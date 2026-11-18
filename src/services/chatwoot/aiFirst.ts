import { createHash } from 'node:crypto';
import { gerarResposta, type ContextoDaResposta, type ModeloDeResposta } from '../sac/gerarResposta';

export interface AutorizacaoAiFirst {
  readonly organizacao: string;
  readonly executor: string;
  readonly conversa: string;
  readonly versaoGlobal: number;
  readonly versaoOrganizacao: number;
}

/** Adapter must pin the scope to the registered connection and verify the
 * status with a fresh GET. A webhook observation alone cannot grant AI. */
export interface ObservacaoDoCanal {
  readonly conversa: string;
  readonly status: 'open' | 'pending' | 'resolved' | 'snoozed';
  readonly assigneeId: number | null | undefined;
}

export function planejarProjecao(
  modo: 'PREPARANDO_IA' | 'AI' | 'HUMAN_REQUIRED' | 'HUMAN',
  observado: ObservacaoDoCanal,
) {
  if (observado.status === 'resolved' || observado.status === 'snoozed') return 'conter';
  if (modo === 'AI') return observado.status === 'pending' && observado.assigneeId === null ? 'confirmado' : 'conter';
  if (modo === 'PREPARANDO_IA') {
    if (observado.assigneeId !== null) return 'conter';
    return observado.status === 'pending' ? 'confirmado' : 'projetar_pending';
  }
  return observado.status === 'open' ? 'confirmado' : 'projetar_open';
}

interface RespostaRpc { readonly data: unknown; readonly error: unknown }
export interface RpcAiFirst {
  rpc(nome: string, argumentos: Record<string, string | number>): PromiseLike<RespostaRpc>;
}

async function executarRpc(banco: RpcAiFirst, nome: string, argumentos: Record<string, string | number>) {
  const { data, error } = await banco.rpc(nome, argumentos);
  if (error || typeof data !== 'string') throw Error('Controle AI-first indisponível.');
  return data;
}

export async function ativarAposProjecao(
  banco: RpcAiFirst,
  autorizacao: AutorizacaoAiFirst,
  eventoCriacao: string,
  corte: string,
  confirmado: ObservacaoDoCanal,
) {
  if (confirmado.conversa !== autorizacao.conversa || planejarProjecao('PREPARANDO_IA', confirmado) !== 'confirmado') {
    return 'projecao_nao_confirmada';
  }
  return executarRpc(banco, 'iniciar_ai_first_chatwoot', {
    p_org: autorizacao.organizacao, p_executor: autorizacao.executor, p_conversa: autorizacao.conversa,
    p_evento_criacao: eventoCriacao, p_corte: corte, p_global: autorizacao.versaoGlobal,
    p_org_versao: autorizacao.versaoOrganizacao,
  });
}

export interface ContextoAutorizado extends ContextoDaResposta {
  readonly autorizacao: AutorizacaoAiFirst;
  readonly caso: string;
  readonly run: string;
  readonly versaoControle: number;
}

function identidade(contexto: ContextoAutorizado) {
  const a = contexto.autorizacao;
  return JSON.stringify([a.organizacao, a.executor, a.conversa, contexto.caso, contexto.run,
    a.versaoGlobal, a.versaoOrganizacao, contexto.versaoControle, contexto.marca]);
}

/** One invocation by the authorized worker. Its repository must load the
 * case, run and conversation together under the verified organization. */
export async function produzirIntencaoAiFirst(
  banco: RpcAiFirst,
  ler: () => Promise<ContextoAutorizado | null>,
  modelo: ModeloDeResposta,
) {
  const inicio = await ler();
  if (inicio === null) return 'aguardando_contexto';
  const chave = identidade(inicio);
  const resposta = await gerarResposta(async () => {
    const atual = await ler();
    return atual && identidade(atual) === chave ? atual : null;
  }, modelo);
  if (resposta.estado !== 'rascunho') return resposta.estado;

  const a = inicio.autorizacao;
  const hex = createHash('sha256').update('orbita:ai-first:' + chave).digest('hex');
  // UUID deterministic for this run/revision. A different payload under the
  // same command is a conflict in MSG-022, never a second send.
  const command = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return executarRpc(banco, 'registrar_autorresposta_chatwoot', {
    p_organizacao_id: a.organizacao, p_ator_id: a.executor, p_conversa_id: a.conversa,
    p_caso_id: inicio.caso, p_command_id: command, p_run_id: inicio.run,
    p_conteudo: resposta.texto, p_versao_global: a.versaoGlobal, p_versao_org: a.versaoOrganizacao,
    p_versao_conversa: inicio.versaoControle,
  });
}
