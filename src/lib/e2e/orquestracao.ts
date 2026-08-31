import {
  iniciarDiario,
  planejarExecucao,
  reconciliar,
  registrarConclusao,
  type DiarioDeExecucao,
  type DivergenciaDeReconciliacao,
  type RegistroEncontrado,
} from './execucaoSeed';
import {
  descreverSimulacao,
  limpezaPodeProsseguir,
  planejarLimpeza,
  relatarOrfaos,
  type PlanoDeLimpeza,
} from './limpezaSegura';
import type { PapelDeMembership, PersistirDiario, PortaDoProjeto } from './portaDoProjeto';
import { findOrganization, type SeedManifest, type SyntheticPersonaRole } from './syntheticSeedData';

/**
 * Orquestração do seed e da limpeza, com a porta do projeto injetada.
 *
 * Fica aqui, e não nos scripts, para poder ser exercitada com falhas simuladas
 * — leitura que estoura, escrita que morre no meio, exclusão que recusa —
 * sem tocar em ambiente nenhum. Os scripts viram adaptadores finos.
 */

const PAPEL_POR_PERSONA: Readonly<Record<Exclude<SyntheticPersonaRole, 'external'>, PapelDeMembership>> = {
  owner: 'owner',
  admin: 'admin',
  member: 'member',
};

/** Tudo o que o projeto tem daquela execução, com identificadores remotos. */
export type LeituraCompleta =
  | { readonly _tag: 'Lido'; readonly registros: readonly RegistroEncontrado[] }
  | { readonly _tag: 'FalhaDeLeitura'; readonly recurso: string; readonly causa: string };

/**
 * Lê usuários, organizações e memberships da execução.
 *
 * Uma falha em qualquer um dos três **aborta**: seguir com leitura parcial faria
 * registro existente parecer ausente, e é exatamente assim que uma limpeza
 * declara sucesso deixando dado para trás.
 */
export async function lerTudoDaExecucao(porta: PortaDoProjeto, runId: string): Promise<LeituraCompleta> {
  const registros: RegistroEncontrado[] = [];

  for (const [recurso, ler] of [
    ['organizacoes', () => porta.lerOrganizacoesDaExecucao(runId)],
    ['usuarios', () => porta.lerUsuariosDaExecucao(runId)],
    ['memberships', () => porta.lerMembershipsDaExecucao(runId)],
  ] as const) {
    const leitura = await ler();
    if (leitura._tag === 'FalhaDeLeitura') {
      return { _tag: 'FalhaDeLeitura', recurso, causa: leitura.causa };
    }
    registros.push(...leitura.registros);
  }

  return { _tag: 'Lido', registros };
}

/**
 * Interrompe diante de divergência entre o diário e o projeto.
 *
 * Reutilizar um id que o projeto já não tem é como um membership passa a
 * apontar para a organização de outra pessoa. O diário **não** é corrigido: ele
 * é o histórico, e reescrevê-lo apagaria a prova do que foi criado.
 */
function exigirSemDivergencia(divergentes: readonly DivergenciaDeReconciliacao[], etapa: string): void {
  if (divergentes.length === 0) return;
  const detalhe = divergentes
    .map((d) => `  ${d.identificador}: diário=${d.idNoDiario} projeto=${d.idNoProjeto}`)
    .join('\n');
  throw new Error(
    `${etapa} abortada: ${divergentes.length} registro(s) com id diferente do que o diário guarda.\n${detalhe}\n`
      + 'O diário foi preservado. Reutilizar id obsoleto criaria vínculo com registro de outra pessoa.',
  );
}

export interface ResultadoDoSeed {
  readonly diario: DiarioDeExecucao;
  readonly manifest: SeedManifest;
  readonly recuperadas: number;
}

export interface OpcoesDoSeed {
  readonly porta: PortaDoProjeto;
  readonly manifest: SeedManifest;
  readonly projetoRef: string;
  readonly persistir: PersistirDiario;
  /**
   * Diário já existente em disco, quando é retomada.
   *
   * **Nunca sobrescrever um diário existente com um vazio.** Era o defeito: a
   * retomada montava plano novo, gravava por cima e destruía o registro do que
   * já tinha sido criado — antes mesmo de ler o projeto.
   */
  readonly diarioExistente?: DiarioDeExecucao;
}

/**
 * Executa o seed, gravando o diário antes da primeira escrita e após cada uma.
 *
 * Na retomada, reconcilia contra o que o projeto de fato tem — usuários,
 * organizações **e** memberships — antes de decidir o que ainda falta criar.
 * Reconciliar só organizações deixaria o seed tentar recriar usuário com
 * e-mail já existente, e falhar por conta própria.
 */
export async function executarSeed(opcoes: OpcoesDoSeed): Promise<ResultadoDoSeed> {
  const { porta, projetoRef, persistir } = opcoes;
  let manifest = opcoes.manifest;

  let diario = opcoes.diarioExistente ?? iniciarDiario(planejarExecucao(manifest, projetoRef));
  const gravar = (d: DiarioDeExecucao) => {
    persistir(JSON.stringify(d, null, 2));
    return d;
  };
  diario = gravar(diario);

  let recuperadas = 0;
  if (opcoes.diarioExistente) {
    const leitura = await lerTudoDaExecucao(porta, manifest.runId);
    if (leitura._tag === 'FalhaDeLeitura') {
      throw new Error(
        `Retomada abortada: falha ao ler ${leitura.recurso} da execução (${leitura.causa}). `
          + 'Criar sem saber o que já existe duplicaria registros no projeto.',
      );
    }
    const reconciliado = reconciliar(diario, leitura.registros);
    exigirSemDivergencia(reconciliado.divergentes, 'Retomada');
    recuperadas = reconciliado.recuperadas.length;
    diario = gravar(reconciliado.diario);
  }

  const idPorChave = () => new Map(diario.concluidas.map((c) => [c.chave, c.idReal]));

  for (const organizacao of manifest.organizations) {
    const chave = `org:${organizacao.key}`;
    if (idPorChave().has(chave)) continue;
    const escrita = await porta.criarOrganizacao(organizacao.slug, organizacao.nome);
    if (escrita._tag === 'FalhaDeEscrita') {
      throw new Error(`Falha ao criar a organização "${organizacao.slug}": ${escrita.causa}.`);
    }
    diario = gravar(registrarConclusao(diario, chave, escrita.id));
  }

  // As organizações que as specs criam estão no plano para a limpeza
  // alcançá-las, mas o seed não as cria: quem cria é a suíte, durante o teste.
  for (const persona of manifest.personas) {
    const chaveUsuario = `persona:${persona.key}`;
    let userId = idPorChave().get(chaveUsuario);
    if (userId === undefined) {
      const escrita = await porta.criarUsuario(persona.email, persona.password);
      if (escrita._tag === 'FalhaDeEscrita') {
        throw new Error(`Falha ao criar o usuário "${persona.email}": ${escrita.causa}.`);
      }
      userId = escrita.id;
      diario = gravar(registrarConclusao(diario, chaveUsuario, userId));
    }
    manifest = { ...manifest, personas: manifest.personas.map((p) => (p.key === persona.key ? { ...p, userId } : p)) };

    if (persona.organizationKey === null || persona.role === 'external') continue;

    const chaveMembership = `membership:${persona.key}`;
    if (idPorChave().has(chaveMembership)) continue;

    const organizacao = findOrganization(manifest, persona.organizationKey);
    const organizacaoId = idPorChave().get(`org:${organizacao.key}`);
    if (organizacaoId === undefined) {
      throw new Error(`Organização "${organizacao.slug}" não está no diário; o membership não pode ser criado sem ela.`);
    }
    const escrita = await porta.criarMembership(organizacaoId, userId, PAPEL_POR_PERSONA[persona.role]);
    if (escrita._tag === 'FalhaDeEscrita') {
      throw new Error(`Falha ao criar o membership de "${persona.email}": ${escrita.causa}.`);
    }
    diario = gravar(registrarConclusao(diario, chaveMembership, escrita.id));
  }

  return { diario, manifest, recuperadas };
}

export interface ResultadoDaLimpeza {
  readonly plano: PlanoDeLimpeza;
  readonly simulacao: string;
  readonly orfaos: readonly RegistroEncontrado[];
  readonly removidos: number;
  readonly simulado: boolean;
}

/**
 * Executa a limpeza do que a execução criou, e nada além.
 *
 * A leitura vem inteira ou não vem: falha de leitura **aborta** em vez de virar
 * "já removido". Órfãos são relatados sobre o que o projeto de fato tem, e não
 * sobre o que o diário conhece — é justamente o que o diário **não** conhece
 * que interessa aqui.
 */
export async function executarLimpeza(
  porta: PortaDoProjeto,
  diario: DiarioDeExecucao,
  opcoes: { readonly simular: boolean },
): Promise<ResultadoDaLimpeza> {
  const leitura = await lerTudoDaExecucao(porta, diario.plano.runId);
  if (leitura._tag === 'FalhaDeLeitura') {
    throw new Error(
      `Limpeza abortada: falha ao ler ${leitura.recurso} da execução (${leitura.causa}). `
        + 'Erro de leitura não é ausência de registro; apagar assim declararia sucesso deixando dado para trás.',
    );
  }

  // Reconcilia antes de planejar: adota o id real do que existe no projeto e o
  // diário não registrou — inclusive as organizações que as **specs** criam,
  // previstas no plano mas nunca escritas pelo seed. Sem isto elas ficavam no
  // projeto a cada execução.
  const reconciliado = reconciliar(diario, leitura.registros);
  exigirSemDivergencia(reconciliado.divergentes, 'Limpeza');
  const plano = planejarLimpeza(reconciliado.diario, leitura.registros);
  const orfaos = relatarOrfaos(leitura.registros, plano.runId, plano);
  const simulacao = descreverSimulacao(plano);

  if (!limpezaPodeProsseguir(plano)) {
    throw new Error(
      `${plano.recusadas.length} registro(s) recusado(s) na conferência de identidade. Nada foi apagado.\n${simulacao}`,
    );
  }

  if (opcoes.simular) {
    return { plano, simulacao, orfaos, removidos: 0, simulado: true };
  }

  let removidos = 0;
  for (const exclusao of plano.aprovadas) {
    const resultado = exclusao.tipo === 'usuario'
      ? await porta.apagarUsuario(exclusao.id)
      : exclusao.tipo === 'organizacao'
        ? await porta.apagarOrganizacao(exclusao.id)
        : await porta.apagarMembership(exclusao.id);

    if (resultado._tag === 'FalhaDeExclusao') {
      throw new Error(
        `Falha ao apagar ${exclusao.tipo} "${exclusao.identificador}": ${resultado.causa}. `
          + `${removidos} registro(s) já removido(s); rode a limpeza de novo com o mesmo diário.`,
      );
    }
    removidos += 1;
  }

  return { plano, simulacao, orfaos, removidos, simulado: false };
}
