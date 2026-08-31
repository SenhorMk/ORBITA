import type { DiarioDeExecucao, OperacaoPlanejada, RegistroEncontrado, TipoDeRegistro } from './execucaoSeed';
import { SYNTHETIC_DATA_PREFIX } from './syntheticSeedData';

/**
 * Decide **o que** pode ser apagado, antes de apagar qualquer coisa.
 *
 * A limpeza roda contra o projeto Supabase compartilhado. A regra é uma só:
 * apaga-se o que esta execução criou, provado registro a registro, e nada
 * além. Divergência não é resolvida por aproximação — é recusa.
 *
 * Módulo puro: nenhuma função aqui fala com a rede nem apaga nada. Quem
 * executa é `e2e/seed/run-cleanup.ts`, que lê o projeto, pergunta aqui o que
 * fazer, e só então age.
 */

/** Exclusão aprovada: identidade conferida contra o que o diário registrou. */
export interface ExclusaoAprovada {
  readonly tipo: TipoDeRegistro;
  readonly chave: string;
  readonly identificador: string;
  readonly id: string;
}

/** Motivo de recusa. Nenhum deles resulta em exclusão. */
export type MotivoDeRecusa =
  | { readonly _tag: 'NaoEncontrado' }
  | { readonly _tag: 'IdDivergente'; readonly registrado: string; readonly encontrado: string }
  | { readonly _tag: 'IdentificadorSemPrefixo' }
  | { readonly _tag: 'ForaDaExecucao'; readonly runId: string };

export interface ExclusaoRecusada {
  readonly chave: string;
  readonly identificador: string;
  readonly motivo: MotivoDeRecusa;
}

export interface PlanoDeLimpeza {
  readonly projetoRef: string;
  readonly runId: string;
  /** Na ordem em que devem ser apagados: membership, organização, usuário. */
  readonly aprovadas: readonly ExclusaoAprovada[];
  /** Nada aqui é apagado. Se houver qualquer item, a limpeza não prossegue. */
  readonly recusadas: readonly ExclusaoRecusada[];
  /**
   * Já não existem no projeto. Não são erro: uma limpeza repetida encontra
   * exatamente isto, e precisa terminar em sucesso.
   */
  readonly jaRemovidas: readonly OperacaoPlanejada[];
  /**
   * Existem no projeto e o diário nunca registrou a conclusão delas.
   *
   * São órfãos no sentido estrito: a operação remota deu certo e a gravação
   * local não. Não entram em `aprovadas` porque não há id registrado para
   * conferir — apagar por identificador seria apagar por semelhança —, e não
   * entram em `jaRemovidas` porque **existem**.
   */
  readonly naoRegistradas: readonly { readonly operacao: OperacaoPlanejada; readonly encontrado: RegistroEncontrado }[];
}

/** Ordem de exclusão: dependente antes do dependido. */
const ORDEM: Readonly<Record<TipoDeRegistro, number>> = { membership: 0, organizacao: 1, usuario: 2 };

/**
 * Confere a identidade de um registro antes de aprová-lo para exclusão.
 *
 * Três perguntas, todas obrigatórias: o identificador carrega o prefixo
 * sintético? ele pertence a **esta** execução? o id que o projeto devolveu é o
 * mesmo que o diário registrou?
 *
 * A terceira é a que importa mais. Um slug pode ser reaproveitado; o id, não.
 * Se o id mudou, o registro que está lá **não é** o que criamos, e apagá-lo
 * seria destruir dado de outra pessoa.
 */
export function conferirIdentidade(
  operacao: OperacaoPlanejada,
  idRegistrado: string,
  encontrado: RegistroEncontrado | undefined,
  runId: string,
): { readonly _tag: 'Aprovada'; readonly exclusao: ExclusaoAprovada }
  | { readonly _tag: 'Recusada'; readonly recusa: ExclusaoRecusada }
  | { readonly _tag: 'JaRemovida' } {
  const recusar = (motivo: MotivoDeRecusa) => ({
    _tag: 'Recusada' as const,
    recusa: { chave: operacao.chave, identificador: operacao.identificador, motivo },
  });

  if (!operacao.identificador.includes(SYNTHETIC_DATA_PREFIX)) {
    return recusar({ _tag: 'IdentificadorSemPrefixo' });
  }
  if (!operacao.identificador.includes(runId)) {
    return recusar({ _tag: 'ForaDaExecucao', runId });
  }
  if (encontrado === undefined) {
    return { _tag: 'JaRemovida' };
  }
  if (encontrado.id !== idRegistrado) {
    return recusar({ _tag: 'IdDivergente', registrado: idRegistrado, encontrado: encontrado.id });
  }

  return {
    _tag: 'Aprovada',
    exclusao: {
      tipo: operacao.tipo,
      chave: operacao.chave,
      identificador: operacao.identificador,
      id: idRegistrado,
    },
  };
}

/**
 * Monta o plano de limpeza a partir do diário e do que o projeto tem agora.
 *
 * O que o diário nunca registrou como concluído não entra: não há id para
 * conferir, e apagar por identificador seria apagar por semelhança.
 */
export function planejarLimpeza(
  diario: DiarioDeExecucao,
  encontrados: readonly RegistroEncontrado[],
): PlanoDeLimpeza {
  const porIdentificador = new Map(encontrados.map((e) => [e.identificador, e]));
  const idPorChave = new Map(diario.concluidas.map((c) => [c.chave, c.idReal]));

  const aprovadas: ExclusaoAprovada[] = [];
  const recusadas: ExclusaoRecusada[] = [];
  const jaRemovidas: OperacaoPlanejada[] = [];
  const naoRegistradas: PlanoDeLimpeza['naoRegistradas'][number][] = [];

  for (const operacao of diario.plano.operacoes) {
    const idRegistrado = idPorChave.get(operacao.chave);
    const encontrado = porIdentificador.get(operacao.identificador);

    if (idRegistrado === undefined) {
      // Operação sem conclusão gravada. Se o registro **existe** no projeto,
      // ele é órfão: foi criado e o diário não soube. Tratá-lo como "já
      // removido" era esconder exatamente o caso que o diário existe para
      // revelar — e o relatório de órfãos, que exclui `jaRemovidas`, o
      // silenciava de novo.
      if (encontrado !== undefined) {
        naoRegistradas.push({ operacao, encontrado });
      } else {
        jaRemovidas.push(operacao);
      }
      continue;
    }

    const resultado = conferirIdentidade(operacao, idRegistrado, encontrado, diario.plano.runId);

    if (resultado._tag === 'Aprovada') aprovadas.push(resultado.exclusao);
    else if (resultado._tag === 'Recusada') recusadas.push(resultado.recusa);
    else jaRemovidas.push(operacao);
  }

  aprovadas.sort((a, b) => ORDEM[a.tipo] - ORDEM[b.tipo]);

  return {
    projetoRef: diario.plano.projetoRef,
    runId: diario.plano.runId,
    aprovadas,
    recusadas,
    jaRemovidas,
    naoRegistradas,
  };
}

/** A limpeza pode prosseguir? Qualquer recusa impede. */
export function limpezaPodeProsseguir(plano: PlanoDeLimpeza): boolean {
  return plano.recusadas.length === 0;
}

/**
 * Texto da simulação: exatamente o que seria apagado, e o que seria pulado.
 *
 * É o que o operador lê **antes** de autorizar. Uma simulação que resume ou
 * arredonda não serve para autorizar nada.
 */
export function descreverSimulacao(plano: PlanoDeLimpeza): string {
  const linhas: string[] = [
    `Projeto: ${plano.projetoRef}`,
    `Execução: ${plano.runId}`,
    '',
    `A APAGAR (${plano.aprovadas.length}), nesta ordem:`,
  ];

  if (plano.aprovadas.length === 0) linhas.push('  (nenhum)');
  for (const e of plano.aprovadas) {
    linhas.push(`  ${e.tipo.padEnd(12)} ${e.identificador}  id=${e.id}`);
  }

  if (plano.naoRegistradas.length > 0) {
    linhas.push('', `EXISTEM E O DIÁRIO NÃO REGISTROU (${plano.naoRegistradas.length}) — órfãos, não serão apagados:`);
    for (const { operacao, encontrado } of plano.naoRegistradas) {
      linhas.push(`  ${operacao.tipo.padEnd(12)} ${operacao.identificador}  id=${encontrado.id}`);
    }
  }

  linhas.push('', `JÁ REMOVIDOS OU NUNCA CRIADOS (${plano.jaRemovidas.length}), nada a fazer:`);
  if (plano.jaRemovidas.length === 0) linhas.push('  (nenhum)');
  for (const o of plano.jaRemovidas) linhas.push(`  ${o.tipo.padEnd(12)} ${o.identificador}`);

  if (plano.recusadas.length > 0) {
    linhas.push('', `RECUSADOS (${plano.recusadas.length}) — a limpeza NÃO prossegue:`);
    for (const r of plano.recusadas) {
      linhas.push(`  ${r.identificador}: ${descreverRecusa(r.motivo)}`);
    }
  }

  return linhas.join('\n');
}

function descreverRecusa(motivo: MotivoDeRecusa): string {
  switch (motivo._tag) {
    case 'NaoEncontrado':
      return 'não encontrado no projeto';
    case 'IdDivergente':
      return `o id no projeto (${motivo.encontrado}) não é o que o diário registrou (${motivo.registrado}) — `
        + 'o registro que está lá não é o que esta execução criou';
    case 'IdentificadorSemPrefixo':
      return `o identificador não carrega "${SYNTHETIC_DATA_PREFIX}"`;
    case 'ForaDaExecucao':
      return `o identificador não pertence à execução ${motivo.runId}`;
  }
}

/**
 * Relatório de órfãos **desta execução**, e nada além.
 *
 * Informativo por decisão: apagar por varredura é justamente o que a conferência
 * de identidade existe para impedir. O relatório diz o que sobrou; quem decide
 * é o operador.
 *
 * O filtro é duplo — prefixo sintético **e** `runId` — porque um filtro só de
 * prefixo alcançaria execuções de outras pessoas.
 */
export function relatarOrfaos(
  encontrados: readonly RegistroEncontrado[],
  runId: string,
  plano: PlanoDeLimpeza,
): readonly RegistroEncontrado[] {
  // `naoRegistradas` **não** entra aqui: elas são órfãs por definição, e
  // omiti-las era o defeito. O que sai são as que o diário conhece.
  const conhecidos = new Set([
    ...plano.aprovadas.map((a) => a.identificador),
    ...plano.jaRemovidas.map((o) => o.identificador),
    ...plano.recusadas.map((r) => r.identificador),
  ]);

  return encontrados.filter(
    (e) => e.identificador.includes(SYNTHETIC_DATA_PREFIX)
      && e.identificador.includes(runId)
      && !conhecidos.has(e.identificador),
  );
}
