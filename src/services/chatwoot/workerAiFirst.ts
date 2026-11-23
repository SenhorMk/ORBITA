import { z } from 'zod';
import { setTimeout as esperar } from 'node:timers/promises';
import { logger } from '../../lib/observability/logger';
import { gerarResposta, type ModeloDeResposta } from '../sac/gerarResposta';

type Argumentos = Record<string, string | number | boolean | null>;
export interface BancoDoWorkerAiFirst {
  rpc(nome: string, args: Argumentos): PromiseLike<{ data: unknown; error: unknown }>;
}

const Escopo = z.object({ p_org: z.string().uuid(), p_conexao: z.string().uuid(), p_executor: z.string().uuid() });
type Escopo = z.infer<typeof Escopo>;
const Projecao = z.object({
  id_local: z.string().uuid(), id_externo: z.string().regex(/^[1-9]\d{0,9}$/),
  inbox_id: z.number().int().positive(), account_id: z.coerce.string().regex(/^[1-9]\d{0,9}$/),
  token: z.string().uuid(), desejado: z.enum(['open', 'pending']), somente_leitura: z.boolean(),
  evidencia: z.string().uuid().nullable(), global: z.number().int(), org_versao: z.number().int(),
});
type Projecao = z.infer<typeof Projecao>;
const Geracao = z.object({
  caso: z.string().uuid(), conversa: z.string().uuid(), token: z.string().uuid(), run: z.string().uuid(),
  versao: z.number().int(), versao_global: z.number().int(), versao_org: z.number().int(),
  intencao: z.string(), mensagens: z.array(z.object({ conteudo: z.string(), criadaEm: z.string() })).min(1).max(5),
  resumo: z.string().max(2000).nullable(),
});
const Observacao = z.object({
  conta: z.string(), inbox: z.number(), conversa: z.string(),
  status: z.enum(['open', 'pending', 'resolved', 'snoozed']), responsavel: z.number().int().positive().nullable(),
});
type Observacao = z.infer<typeof Observacao>;

export interface CanalDeProjecaoAiFirst {
  // The implementation must bind its credential to this exact local scope.
  pronto(escopo: Escopo): Promise<boolean>;
  ler(escopo: Escopo, item: Pick<Projecao, 'id_externo' | 'inbox_id' | 'account_id'>): Promise<Observacao>;
  // This capability must be attested for CE 4.19.1 before a real adapter is
  // supplied. An ordinary agent's toggle_status(open) is unsafe.
  alterarSemAtribuir(escopo: Escopo, item: Pick<Projecao, 'id_externo' | 'inbox_id' | 'account_id'>,
    status: 'open' | 'pending'): Promise<void>;
}

async function rpc(banco: BancoDoWorkerAiFirst, nome: string, args: Argumentos) {
  const { data, error } = await banco.rpc(nome, args);
  if (error) throw new Error('Falha no worker AI-first: ' + nome);
  return data;
}

async function lerCanal(canal: CanalDeProjecaoAiFirst, escopo: Escopo, item: Projecao) {
  const obs = Observacao.parse(await canal.ler(escopo, item));
  if (obs.conta !== item.account_id || obs.inbox !== item.inbox_id || obs.conversa !== item.id_externo) {
    throw new Error('Observação de status fora da conexão.');
  }
  return obs;
}

async function projetar(banco: BancoDoWorkerAiFirst, canal: CanalDeProjecaoAiFirst, escopo: Escopo, item: Projecao) {
  const chave = { ...escopo, p_conversa: item.id_local, p_token: item.token };
  let observacao: Observacao | null = null;
  try {
    const anterior = await lerCanal(canal, escopo, item);
    observacao = anterior;
    const podeEscrever = !item.somente_leitura && anterior.status !== item.desejado
      && ['open', 'pending'].includes(anterior.status)
      && (item.desejado === 'open' || anterior.responsavel === null);
    if (podeEscrever && await rpc(banco, 'iniciar_projecao_ai_first', chave) === true) {
      await canal.alterarSemAtribuir(escopo, item, item.desejado);
      const posterior = await lerCanal(canal, escopo, item);
      observacao = posterior.responsavel === anterior.responsavel ? posterior : null;
    }
  } catch {
    observacao = null;
  }
  return rpc(banco, 'concluir_projecao_ai_first', {
    ...chave, p_observado: observacao?.status ?? null, p_sem_responsavel: observacao?.responsavel === null,
    p_evidencia: item.evidencia, p_global: item.global, p_org_versao: item.org_versao,
  });
}

/**
 * Até quando a conversa reivindicada foi comprovadamente atendida (resposta
 * que chegou ao cliente ou devolução do atendente); `null` = nada ainda.
 */
export type LerAtendidaAte = (escopo: Escopo, conversaIdLocal: string) => Promise<string | null>;

/**
 * O mais recente entre fontes de prova (espelho do Chatwoot, envio confirmado,
 * devolução). Cada fonte só devolve prova; qualquer falha rejeita e o worker
 * cai no corte conservador.
 */
export function atendidaAteEntre(...fontes: readonly LerAtendidaAte[]): LerAtendidaAte {
  return async (escopo, conversa) => {
    const instantes = (await Promise.all(fontes.map((ler) => ler(escopo, conversa)))).filter((v): v is string => v !== null);
    return instantes.reduce<string | null>((maior, v) => (maior === null || Date.parse(v) > Date.parse(maior) ? v : maior), null);
  };
}

export interface OpcoesDoWorkerAiFirst {
  readonly escopo: Escopo;
  readonly habilitado: boolean;
  readonly modelo: ModeloDeResposta | null;
  readonly canal: CanalDeProjecaoAiFirst;
  readonly banco: BancoDoWorkerAiFirst;
  /** Até onde a conversa foi atendida; sem ele, só a última mensagem é pedido. */
  readonly atendidaAte?: LerAtendidaAte;
}

/** Falha na leitura não bloqueia a resposta: cai no corte conservador (só a última mensagem). */
async function lerAtendidaAte(opcoes: OpcoesDoWorkerAiFirst, escopo: Escopo, conversa: string) {
  if (!opcoes.atendidaAte) return undefined;
  try {
    return await opcoes.atendidaAte(escopo, conversa);
  } catch {
    logger.warn('chatwoot.ai_first.historico_indisponivel', { subsystem: 'queue', organizacaoId: escopo.p_org });
    return undefined;
  }
}

/** One bounded pass. All durable effects are leases/observations or a MSG-022
 * intent. The existing outbox worker remains the only message sender. */
export async function consumirAiFirstUmaVez(opcoes: OpcoesDoWorkerAiFirst) {
  const { banco, canal, modelo } = opcoes;
  const escopo = Escopo.parse(opcoes.escopo);
  let pronto = false;
  if (opcoes.habilitado && modelo !== null) {
    try { pronto = await canal.pronto(escopo); } catch { pronto = false; }
  }
  const renovado = await rpc(banco, 'renovar_worker_ai_first', { ...escopo, p_pronto: pronto });
  if (!pronto || renovado !== true || modelo === null) return { estado: 'desligado' } as const;
  const escalonamento = await rpc(banco, 'escalonar_triagem_ai_first', escopo);
  const item = Projecao.nullable().parse(await rpc(banco, 'reivindicar_projecao_ai_first', escopo));
  const projecao = item ? await projetar(banco, canal, escopo, item) : null;
  const trabalho = Geracao.nullable().parse(await rpc(banco, 'reivindicar_geracao_ai_first', escopo));
  if (!trabalho) return { estado: 'sem_geracao', projecao, escalonamento } as const;
  const contexto = { intencao: trabalho.intencao, mensagens: trabalho.mensagens, marca: trabalho.token,
    resumo: trabalho.resumo ?? undefined, atendidaAte: await lerAtendidaAte(opcoes, escopo, trabalho.conversa) };
  const resposta = await gerarResposta(async () => contexto, modelo);
  // The true second read is the completion RPC: it revalidates authorization,
  // run, case marker, control, inbox and the durable fencing token together.
  const geracao = await rpc(banco, 'concluir_geracao_ai_first', {
    ...escopo, p_token: trabalho.token, p_conversa: trabalho.conversa, p_caso: trabalho.caso, p_run: trabalho.run,
    p_versao: trabalho.versao, p_global: trabalho.versao_global, p_org_versao: trabalho.versao_org,
    p_texto: resposta.estado === 'rascunho' ? resposta.texto : null,
  });
  return { estado: 'processado', projecao, geracao, escalonamento } as const;
}

export async function executarWorkerAiFirst(opcoes: OpcoesDoWorkerAiFirst, parar: AbortSignal) {
  try {
    while (!parar.aborted) {
      try {
        const resultado = await consumirAiFirstUmaVez(opcoes);
        logger.info('chatwoot.ai_first.passada', { subsystem: 'queue',
          organizacaoId: opcoes.escopo.p_org, ...resultado });
      } catch {
        logger.warn('chatwoot.ai_first.passada_falhou', { subsystem: 'queue',
          organizacaoId: opcoes.escopo.p_org });
        await rpc(opcoes.banco, 'renovar_worker_ai_first', { ...opcoes.escopo, p_pronto: false }).catch(() => undefined);
      }
      await esperar(1500, undefined, { signal: parar }).catch((erro: unknown) => {
        if (!parar.aborted) throw erro;
      });
    }
  } finally {
    // If the connection was lost abruptly the database heartbeat expires.
    await rpc(opcoes.banco, 'renovar_worker_ai_first', { ...opcoes.escopo, p_pronto: false }).catch(() => undefined);
  }
}
