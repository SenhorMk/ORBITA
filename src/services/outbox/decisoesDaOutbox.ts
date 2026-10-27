/**
 * O lado do operador da outbox (MSG-007): a consulta dos efeitos que pedem
 * atenção, com as tentativas, e as decisões humanas sobre um efeito
 * desconhecido — reconciliar com prova ou autorizar o replay. A organização e
 * o ator vêm sempre do escopo verificado; o banco confere papel e estado de
 * novo e devolve códigos que viram falhas tipadas.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { OutboxStatus } from '@/services/outboxService';
import { desfechoVisivel, explicarEstado, podeRepetir, type DesfechoVisivel } from './desfechoDoEfeito';

export interface TentativaVisivel {
  readonly fencingToken: number;
  readonly desfecho: 'em_voo' | 'confirmado' | 'recusado' | 'nao_enviado' | 'desconhecido';
  readonly motivo: string | null;
  readonly iniciadaEm: string;
  readonly concluidaEm: string | null;
}

export interface EventoComAtencao {
  readonly id: string;
  readonly destino: string;
  readonly tipo: string;
  readonly status: OutboxStatus;
  readonly desfecho: DesfechoVisivel;
  readonly motivoBloqueio: string | null;
  readonly resolucao: string | null;
  readonly tentativasContadas: number;
  readonly podeRepetir: boolean;
  readonly explicacao: string;
  readonly atualizadoEm: string;
  readonly tentativas: readonly TentativaVisivel[];
}

/** Por que o banco recusou uma decisão humana sobre a outbox. */
export type FalhaDeDecisaoOutbox = 'SemPapel' | 'NaoEncontrado' | 'EstadoNaoAdmite' | 'EntradaInvalida';
export type DecisaoOutbox =
  | { readonly _tag: 'DecisaoAplicada'; readonly status: OutboxStatus }
  | { readonly _tag: 'DecisaoRecusada'; readonly falha: FalhaDeDecisaoOutbox };

export interface EntradaDeReconciliacao {
  readonly resolucao: 'confirmado' | 'provado_nao_aplicado' | 'revisao_manual';
  readonly reciboRef?: string;
  readonly evidencia?: string;
}

const STATUS = z.enum(['pending', 'processing', 'in_flight', 'sent', 'failed_transient', 'dead_letter', 'unknown']);

const EventoLidoSchema = z.object({
  id: z.string().uuid(),
  destination: z.string(),
  event_type: z.string(),
  status: STATUS,
  motivo_bloqueio: z.string().nullable(),
  resolucao: z.string().nullable(),
  attempts: z.number().int(),
  updated_at: z.string(),
});

const TentativaLidaSchema = z.object({
  evento_id: z.string().uuid(),
  fencing_token: z.coerce.number().int(),
  desfecho: z.enum(['em_voo', 'confirmado', 'recusado', 'nao_enviado', 'desconhecido']),
  motivo: z.string().nullable(),
  iniciada_em: z.string(),
  concluida_em: z.string().nullable(),
});

const FALHA_POR_CODIGO: Readonly<Record<string, FalhaDeDecisaoOutbox>> = {
  '42501': 'SemPapel',
  P0002: 'NaoEncontrado',
  '55000': 'EstadoNaoAdmite',
  '22023': 'EntradaInvalida',
};

function decisao(data: unknown, error: { code?: string; message: string } | null): DecisaoOutbox {
  if (error) {
    const falha = error.code ? FALHA_POR_CODIGO[error.code] : undefined;
    if (falha) return { _tag: 'DecisaoRecusada', falha };
    throw new Error(`Falha ao decidir sobre a outbox: ${error.message}`);
  }
  return { _tag: 'DecisaoAplicada', status: STATUS.parse(data) };
}

async function tentativasPorEvento(
  supabase: SupabaseClient,
  scope: VerifiedOrganizationScope,
  eventoIds: readonly string[],
): Promise<Map<string, TentativaVisivel[]>> {
  const { data, error } = await supabase
    .from('outbox_tentativas')
    .select('evento_id, fencing_token, desfecho, motivo, iniciada_em, concluida_em')
    .eq('organizacao_id', scope.organizationId)
    .in('evento_id', eventoIds)
    .order('fencing_token', { ascending: true });
  if (error) throw new Error(`Falha ao consultar tentativas da outbox: ${error.message}`);
  const porEvento = new Map<string, TentativaVisivel[]>();
  for (const t of TentativaLidaSchema.array().parse(data ?? [])) {
    const lista = porEvento.get(t.evento_id) ?? [];
    lista.push({ fencingToken: t.fencing_token, desfecho: t.desfecho, motivo: t.motivo, iniciadaEm: t.iniciada_em, concluidaEm: t.concluida_em });
    porEvento.set(t.evento_id, lista);
  }
  return porEvento;
}

/**
 * Eventos que pedem atenção do operador na organização verificada
 * (desconhecidos, recusados e em voo), com as tentativas. Sem payload: o
 * conteúdo da mensagem não sai daqui.
 */
export async function listarEventosComAtencao(
  supabase: SupabaseClient,
  scope: VerifiedOrganizationScope,
  limit = 50,
): Promise<EventoComAtencao[]> {
  const { data, error } = await supabase
    .from('outbox_eventos')
    .select('id, destination, event_type, status, motivo_bloqueio, resolucao, attempts, updated_at')
    .eq('organizacao_id', scope.organizationId)
    .in('status', ['unknown', 'dead_letter', 'in_flight'])
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Falha ao consultar a outbox: ${error.message}`);
  const linhas = EventoLidoSchema.array().parse(data ?? []);
  if (linhas.length === 0) return [];

  const porEvento = await tentativasPorEvento(supabase, scope, linhas.map((linha) => linha.id));
  return linhas.map((linha) => {
    const estado = { status: linha.status, motivoBloqueio: linha.motivo_bloqueio, resolucao: linha.resolucao };
    return {
      id: linha.id,
      destino: linha.destination,
      tipo: linha.event_type,
      status: linha.status,
      desfecho: desfechoVisivel(linha.status),
      motivoBloqueio: linha.motivo_bloqueio,
      resolucao: linha.resolucao,
      tentativasContadas: linha.attempts,
      podeRepetir: podeRepetir(estado),
      explicacao: explicarEstado(estado),
      atualizadoEm: linha.updated_at,
      tentativas: porEvento.get(linha.id) ?? [],
    };
  });
}

/** Registra a reconciliação de um efeito desconhecido. */
export async function resolverDesconhecido(
  supabase: SupabaseClient,
  scope: VerifiedOrganizationScope,
  eventoId: string,
  entrada: EntradaDeReconciliacao,
): Promise<DecisaoOutbox> {
  const { data, error } = await supabase.rpc('resolver_evento_desconhecido_outbox', {
    p_organizacao_id: scope.organizationId,
    p_evento_id: eventoId,
    p_ator_id: scope.actorId,
    p_resolucao: entrada.resolucao,
    p_recibo_ref: entrada.reciboRef ?? null,
    p_evidencia: entrada.evidencia ?? null,
  });
  return decisao(data, error);
}

/** Autoriza o replay de um efeito provado como não aplicado. */
export async function autorizarReplay(supabase: SupabaseClient, scope: VerifiedOrganizationScope, eventoId: string): Promise<DecisaoOutbox> {
  const { data, error } = await supabase.rpc('autorizar_replay_outbox', {
    p_organizacao_id: scope.organizationId,
    p_evento_id: eventoId,
    p_ator_id: scope.actorId,
  });
  return decisao(data, error);
}
