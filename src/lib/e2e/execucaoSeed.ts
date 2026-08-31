import { SYNTHETIC_DATA_PREFIX, type SeedManifest } from './syntheticSeedData';

/**
 * Diário de execução do seed: o plano escrito **antes** de qualquer escrita, e
 * o progresso registrado a cada operação concluída.
 *
 * Existe porque o seed escreve num projeto Supabase compartilhado, criando
 * usuários de autenticação, organizações e memberships de verdade. Sem diário,
 * uma interrupção no meio deixa registros remotos sem nenhum rastro local — e
 * quem chega depois não sabe o que existe nem o que apagar.
 *
 * O caso difícil, e o motivo de o diário existir separado do manifesto: a
 * operação remota conclui e a gravação local falha. O usuário existe no
 * Supabase e o diário não sabe. `reconciliar` resolve isso comparando o plano
 * com o que o projeto de fato tem — nunca inventando, nunca apagando.
 *
 * Tudo aqui é puro: nenhuma função deste módulo fala com a rede. Quem executa
 * é `e2e/seed/run-seed.ts`, e é ele que passa o que leu.
 */

/** O que o seed pretende criar, uma linha por registro. */
export type TipoDeRegistro = 'usuario' | 'organizacao' | 'membership';

/**
 * Quem cria o registro.
 *
 * `spec` são registros que a suíte cria durante os testes — a organização de
 * `organization.spec.ts`, por exemplo. O seed **não** os cria, mas o plano os
 * prevê pelo identificador, que é determinístico. Sem isso eles ficavam de fora
 * de tudo: nenhum plano os conhecia, e a limpeza os deixava no projeto a cada
 * execução.
 */
export type CriadoPor = 'seed' | 'spec';

export interface OperacaoPlanejada {
  readonly tipo: TipoDeRegistro;
  /** Chave estável dentro da execução — `persona:owner-a`, `org:org-a`. */
  readonly chave: string;
  /**
   * Identificador legível que o registro terá no projeto: e-mail da persona ou
   * slug da organização. É por ele que a conferência de identidade acontece
   * antes de apagar qualquer coisa.
   */
  readonly identificador: string;
  readonly criadoPor: CriadoPor;
}

export interface PlanoDeExecucao {
  /** Ref do projeto Supabase alvo, escrito antes da primeira operação. */
  readonly projetoRef: string;
  readonly runId: string;
  readonly criadoEm: string;
  readonly operacoes: readonly OperacaoPlanejada[];
}

/** Operação concluída, com o id que o projeto devolveu. */
export interface OperacaoConcluida {
  readonly chave: string;
  readonly idReal: string;
  readonly concluidaEm: string;
}

export interface DiarioDeExecucao {
  readonly plano: PlanoDeExecucao;
  readonly concluidas: readonly OperacaoConcluida[];
}

/**
 * Monta o plano a partir do manifesto, **antes** de qualquer escrita.
 *
 * O `projetoRef` entra aqui e não depois: um diário que não diz em qual projeto
 * rodou é inútil justamente na hora em que alguém precisa dele.
 */
export function planejarExecucao(
  manifest: SeedManifest,
  projetoRef: string,
  agora: () => Date = () => new Date(),
): PlanoDeExecucao {
  if (!projetoRef.trim()) {
    throw new Error('O plano exige o ref do projeto alvo: sem ele, o diário não diz onde as escritas aconteceram.');
  }

  const operacoes: OperacaoPlanejada[] = [];

  for (const persona of manifest.personas) {
    operacoes.push({ tipo: 'usuario', chave: `persona:${persona.key}`, identificador: persona.email, criadoPor: 'seed' });
  }
  for (const organizacao of manifest.organizations) {
    operacoes.push({ tipo: 'organizacao', chave: `org:${organizacao.key}`, identificador: organizacao.slug, criadoPor: 'seed' });
  }
  for (const persona of manifest.personas) {
    if (persona.organizationKey === null) continue;
    const organizacao = manifest.organizations.find((o) => o.key === persona.organizationKey);
    if (!organizacao) {
      throw new Error(`Persona "${persona.key}" aponta para a organização "${persona.organizationKey}", que o manifesto não tem.`);
    }
    operacoes.push({
      tipo: 'membership',
      chave: `membership:${persona.key}`,
      // E-mail e slug, os dois legíveis no projeto. Usar a chave interna da
      // organização tornaria o identificador irreconstruível a partir do que o
      // Supabase devolve — e a conferência de identidade compararia o plano
      // consigo mesmo, que não prova nada.
      identificador: `${persona.email}@${organizacao.slug}`,
      criadoPor: 'seed',
    });
  }

  // Registros que as specs criam durante a execução. O identificador é
  // determinístico, então o plano os prevê — e a limpeza passa a alcançá-los.
  // Sem isto, `spec-created-org` sobrava no projeto a cada execução.
  for (const criadoPelaSpec of ORGANIZACOES_CRIADAS_PELAS_SPECS) {
    operacoes.push({
      tipo: 'organizacao',
      chave: `spec:${criadoPelaSpec}`,
      identificador: `${manifest.prefix}${criadoPelaSpec}`,
      criadoPor: 'spec',
    });
  }

  return { projetoRef, runId: manifest.runId, criadoEm: agora().toISOString(), operacoes };
}

/**
 * Organizações que as specs criam por conta própria, pelo sufixo do slug.
 *
 * Manter a lista aqui, e não na spec, é o que permite ao plano prevê-las antes
 * de a suíte rodar. Uma spec nova que criar registro precisa entrar aqui —
 * senão o resíduo volta.
 */
const ORGANIZACOES_CRIADAS_PELAS_SPECS: readonly string[] = ['spec-created-org'];

/** Diário zerado, pronto para a primeira escrita. */
export function iniciarDiario(plano: PlanoDeExecucao): DiarioDeExecucao {
  return { plano, concluidas: [] };
}

/**
 * Registra uma operação concluída.
 *
 * Repetir a mesma chave **atualiza** em vez de duplicar: uma retomada que
 * reencontra a mesma operação não pode inflar o diário.
 */
export function registrarConclusao(
  diario: DiarioDeExecucao,
  chave: string,
  idReal: string,
  agora: () => Date = () => new Date(),
): DiarioDeExecucao {
  if (!diario.plano.operacoes.some((o) => o.chave === chave)) {
    throw new Error(`Operação fora do plano: "${chave}". O diário não aceita registro que o plano não previu.`);
  }

  const entrada: OperacaoConcluida = { chave, idReal, concluidaEm: agora().toISOString() };
  const semAAntiga = diario.concluidas.filter((c) => c.chave !== chave);
  return { ...diario, concluidas: [...semAAntiga, entrada] };
}

/** Operações do plano que o diário ainda não deu por concluídas. */
export function operacoesPendentes(diario: DiarioDeExecucao): readonly OperacaoPlanejada[] {
  const feitas = new Set(diario.concluidas.map((c) => c.chave));
  return diario.plano.operacoes.filter((o) => !feitas.has(o.chave));
}

/** Registro encontrado no projeto alvo, do jeito que o executor o leu. */
export interface RegistroEncontrado {
  readonly identificador: string;
  readonly id: string;
}

export interface DivergenciaDeReconciliacao {
  readonly chave: string;
  readonly identificador: string;
  readonly idNoDiario: string;
  readonly idNoProjeto: string;
}

export interface ResultadoDaReconciliacao {
  readonly diario: DiarioDeExecucao;
  /** Operações que existiam no projeto e faltavam no diário. */
  readonly recuperadas: readonly OperacaoConcluida[];
  /**
   * Conclusões cujo id no diário **não** é o id que o projeto tem hoje.
   *
   * O diário não é corrigido: ele é o histórico, e reescrevê-lo apagaria a
   * única prova do que foi criado. Quem decide é o chamador, e a decisão certa
   * é parar — reutilizar um id que não existe mais criaria membership apontando
   * para organização de outra pessoa.
   */
  readonly divergentes: readonly DivergenciaDeReconciliacao[];
}

/**
 * Recupera o diário quando a operação remota concluiu e a gravação local não, e
 * **confere** o que o diário já dava por concluído.
 *
 * O executor lê do projeto os registros da execução (filtrados pelo `runId`) e
 * entrega aqui. O que estiver no plano, existir lá e faltar no diário é marcado
 * como concluído — porque **existe**, e ignorá-lo criaria um órfão invisível.
 *
 * O que já estava no diário é conferido contra o projeto: id diferente vira
 * divergência. Confiar no id gravado sem olhar era o buraco — a retomada
 * reutilizava esse id para criar membership, e um id obsoleto aponta para
 * registro de outra pessoa.
 *
 * O que **não** faz, de propósito: não apaga, não inventa id, não reescreve
 * histórico, e não aceita registro fora do plano.
 */
export function reconciliar(
  diario: DiarioDeExecucao,
  encontrados: readonly RegistroEncontrado[],
  agora: () => Date = () => new Date(),
): ResultadoDaReconciliacao {
  const porIdentificador = new Map(encontrados.map((e) => [e.identificador, e.id]));
  const concluidaPorChave = new Map(diario.concluidas.map((c) => [c.chave, c]));
  const recuperadas: OperacaoConcluida[] = [];
  const divergentes: DivergenciaDeReconciliacao[] = [];

  for (const operacao of diario.plano.operacoes) {
    const idNoProjeto = porIdentificador.get(operacao.identificador);
    const concluida = concluidaPorChave.get(operacao.chave);

    if (concluida) {
      // Ausente do projeto não é divergência: pode ter sido apagado, e a
      // limpeza trata isso. Presente com outro id é.
      if (idNoProjeto !== undefined && idNoProjeto !== concluida.idReal) {
        divergentes.push({
          chave: operacao.chave,
          identificador: operacao.identificador,
          idNoDiario: concluida.idReal,
          idNoProjeto,
        });
      }
      continue;
    }

    if (idNoProjeto === undefined) continue;
    recuperadas.push({ chave: operacao.chave, idReal: idNoProjeto, concluidaEm: agora().toISOString() });
  }

  return {
    diario: { ...diario, concluidas: [...diario.concluidas, ...recuperadas] },
    recuperadas,
    divergentes,
  };
}

/** Motivo pelo qual um diário lido do disco não pode ser usado. */
export type DiarioInvalido =
  | { readonly _tag: 'FormaInvalida'; readonly detalhe: string }
  | { readonly _tag: 'ProjetoDivergente'; readonly esperado: string; readonly encontrado: string }
  | { readonly _tag: 'RunIdDivergente'; readonly esperado: string; readonly encontrado: string };

export type LeituraDoDiario =
  | { readonly _tag: 'DiarioValido'; readonly diario: DiarioDeExecucao }
  | { readonly _tag: 'DiarioRecusado'; readonly motivo: DiarioInvalido };

function ehTexto(valor: unknown): valor is string {
  return typeof valor === 'string' && valor.trim().length > 0;
}

function ehTipoDeRegistro(valor: unknown): valor is TipoDeRegistro {
  return valor === 'usuario' || valor === 'organizacao' || valor === 'membership';
}

function ehCriadoPor(valor: unknown): valor is CriadoPor {
  return valor === 'seed' || valor === 'spec';
}

/**
 * Valida um diário lido do disco contra o projeto e a execução esperados.
 *
 * Recusar é o comportamento correto: agir sobre um diário de outra execução, ou
 * de outro projeto, é exatamente como uma limpeza apagaria o que não criou.
 *
 * A validação é **integral** — plano e `concluidas`, item a item. Um diário
 * meio válido é pior que um inválido: ele passa na porta e falha lá dentro,
 * quando já há escrita em curso.
 */
export function lerDiario(
  bruto: unknown,
  esperado: { readonly projetoRef: string; readonly runId?: string },
): LeituraDoDiario {
  const recusar = (motivo: DiarioInvalido): LeituraDoDiario => ({ _tag: 'DiarioRecusado', motivo });

  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) {
    return recusar({ _tag: 'FormaInvalida', detalhe: 'o diário não é um objeto' });
  }

  const { plano, concluidas } = bruto as { plano?: unknown; concluidas?: unknown };
  if (typeof plano !== 'object' || plano === null || !Array.isArray(concluidas)) {
    return recusar({ _tag: 'FormaInvalida', detalhe: 'faltam `plano` ou `concluidas`' });
  }

  const p = plano as Partial<PlanoDeExecucao>;
  if (!ehTexto(p.projetoRef) || !ehTexto(p.runId) || !ehTexto(p.criadoEm) || !Array.isArray(p.operacoes)) {
    return recusar({ _tag: 'FormaInvalida', detalhe: 'o plano não traz `projetoRef`, `runId`, `criadoEm` e `operacoes`' });
  }

  if (p.operacoes.length === 0) {
    return recusar({ _tag: 'FormaInvalida', detalhe: 'o plano não tem operação nenhuma' });
  }

  const chaves = new Set<string>();
  for (const [i, operacao] of p.operacoes.entries()) {
    if (typeof operacao !== 'object' || operacao === null) {
      return recusar({ _tag: 'FormaInvalida', detalhe: `operacoes[${i}] não é um objeto` });
    }
    const o = operacao as Partial<OperacaoPlanejada>;
    if (!ehTexto(o.chave) || !ehTexto(o.identificador) || !ehTipoDeRegistro(o.tipo) || !ehCriadoPor(o.criadoPor)) {
      return recusar({ _tag: 'FormaInvalida', detalhe: `operacoes[${i}] não traz \`tipo\`, \`chave\` e \`identificador\` válidos` });
    }
    if (chaves.has(o.chave)) {
      return recusar({ _tag: 'FormaInvalida', detalhe: `chave repetida no plano: "${o.chave}"` });
    }
    chaves.add(o.chave);
    if (!o.identificador.includes(SYNTHETIC_DATA_PREFIX) || !o.identificador.includes(p.runId)) {
      // Salvaguarda contra apontar a limpeza para dados reais montando um
      // arquivo à mão: todo identificador tem de ser desta execução sintética.
      return recusar({
        _tag: 'FormaInvalida',
        detalhe: `operacoes[${i}] ("${o.identificador}") não é um identificador sintético desta execução`,
      });
    }
  }

  const vistas = new Set<string>();
  for (const [i, concluida] of concluidas.entries()) {
    if (typeof concluida !== 'object' || concluida === null) {
      return recusar({ _tag: 'FormaInvalida', detalhe: `concluidas[${i}] não é um objeto` });
    }
    const c = concluida as Partial<OperacaoConcluida>;
    if (!ehTexto(c.chave) || !ehTexto(c.idReal) || !ehTexto(c.concluidaEm)) {
      return recusar({ _tag: 'FormaInvalida', detalhe: `concluidas[${i}] não traz \`chave\`, \`idReal\` e \`concluidaEm\`` });
    }
    if (!chaves.has(c.chave)) {
      // Uma conclusão sem operação no plano é registro de algo que ninguém
      // planejou criar. Não se apaga por um registro desses.
      return recusar({ _tag: 'FormaInvalida', detalhe: `concluidas[${i}] aponta para "${c.chave}", que o plano não prevê` });
    }
    if (vistas.has(c.chave)) {
      return recusar({ _tag: 'FormaInvalida', detalhe: `chave concluída em duplicidade: "${c.chave}"` });
    }
    vistas.add(c.chave);
  }

  if (p.projetoRef !== esperado.projetoRef) {
    return recusar({ _tag: 'ProjetoDivergente', esperado: esperado.projetoRef, encontrado: p.projetoRef });
  }

  if (esperado.runId !== undefined && p.runId !== esperado.runId) {
    return recusar({ _tag: 'RunIdDivergente', esperado: esperado.runId, encontrado: p.runId });
  }

  return { _tag: 'DiarioValido', diario: bruto as DiarioDeExecucao };
}
