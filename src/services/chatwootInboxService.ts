import crypto from 'node:crypto';
import { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { ChatwootWebhookEvent } from './chatwoot/chatwootPort';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';

export interface ChatwootInboxEventRecord {
  id: string;
  organizacao_id: string;
  conexao_id?: string | null;
  user_id?: string | null;
  inbox_id?: number | null;
  idempotency_key: string;
  event_type: string;
  payload: Record<string, unknown>;
  status: 'received' | 'processing' | 'processed' | 'failed' | 'ignored';
  attempts: number;
  last_error?: string | null;
  response_body?: Record<string, unknown> | null;
  processed_at?: string | null;
  created_at: string;
  updated_at: string;
}

/** De onde veio a repetição reconhecida: a mesma entrega ou o mesmo evento em outra entrega. */
export type DuplicataChatwoot = 'entrega' | 'evento';

/** Desfecho tipado do aceite de uma entrega na inbox; só `EntregaAceita` permite o ACK. */
export type AceiteDeEntregaChatwoot =
  | {
      readonly _tag: 'EntregaAceita';
      readonly eventoId: string;
      readonly status: ChatwootInboxEventRecord['status'];
      readonly duplicata: DuplicataChatwoot | null;
      readonly cachedResponse: Record<string, unknown> | null;
    }
  | { readonly _tag: 'EntregaConflitante' }
  | { readonly _tag: 'ConexaoRecusada'; readonly motivo: 'fora_do_escopo' | 'desligada' }
  | { readonly _tag: 'EntradaRecusada' }
  | { readonly _tag: 'InboxIndisponivel'; readonly cause: string };

const AceiteRowSchema = z.object({
  evento_id: z.string().min(1),
  status: z.enum(['received', 'processing', 'processed', 'failed', 'ignored']),
  duplicata: z.enum(['entrega', 'evento']).nullable(),
  cached_response: z.record(z.string(), z.unknown()).nullable(),
});

const RECUSA_POR_SQLSTATE: Readonly<Record<string, AceiteDeEntregaChatwoot>> = {
  '23505': { _tag: 'EntregaConflitante' },
  '42501': { _tag: 'ConexaoRecusada', motivo: 'fora_do_escopo' },
  '55000': { _tag: 'ConexaoRecusada', motivo: 'desligada' },
  '22023': { _tag: 'EntradaRecusada' },
};

/** Identificação da entrega que acompanha o evento: o delivery id (opcional no
 * Chatwoot) e o timestamp coberto pela assinatura. */
export interface EntregaChatwoot {
  readonly deliveryId: string | null;
  readonly timestampAssinado: string;
}

function digestEstavel(valor: unknown): string {
  const canonico = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonico);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonico((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonico(valor) ?? null)).digest('hex').slice(0, 32);
}

/**
 * Chave semântica (versão `v2`) do evento; o banco a combina com organização +
 * conexão. `message_created` acontece uma vez por mensagem. Edição, status e os
 * demais eventos se repetem de forma legítima (A→B→A, open→resolved→open→
 * resolved), então a chave leva um marcador de revisão: o `updated_at` do
 * provedor, senão o delivery id, senão o timestamp assinado. Na dúvida a chave
 * separa: reprocessar uma repetição é idempotente no espelho, e engolir uma
 * revisão perde a ocorrência.
 */
export function chaveDoEventoChatwoot(evento: ChatwootWebhookEvent, entrega: EntregaChatwoot): string {
  const marcador = (updatedAt: string | number | undefined) => {
    if (updatedAt !== undefined && String(updatedAt) !== '') return `u${updatedAt}`;
    return entrega.deliveryId ? `d${entrega.deliveryId}` : `t${entrega.timestampAssinado}`;
  };

  if (evento.event === 'message_created' && evento.id !== undefined) {
    return `v2:message_created:msg:${evento.id}`;
  }
  if (evento.event === 'message_updated' && evento.id !== undefined) {
    const conteudo = digestEstavel({ content: evento.content, message_type: evento.message_type, private: evento.private });
    return `v2:message_updated:msg:${evento.id}:${marcador(evento.updated_at)}:${conteudo}`;
  }
  const conversa = evento.conversation;
  if (evento.event === 'conversation_status_changed' && conversa?.id !== undefined) {
    const revisao = marcador(conversa.updated_at ?? evento.updated_at);
    return `v2:conversation_status_changed:conv:${conversa.id}:${conversa.status ?? 'unknown'}:${revisao}`;
  }
  return `v2:${evento.event}:${evento.id ?? 'sem-id'}:${marcador(evento.updated_at)}:${digestEstavel(evento)}`;
}

export class ChatwootInboxService {
  private async assertEventScope(
    supabase: SupabaseClient,
    scope: VerifiedOrganizationScope,
    eventoId: string,
  ): Promise<void> {
    const { data, error } = await supabase
      .from('inbox_eventos_chatwoot')
      .select('id')
      .eq('id', eventoId)
      .eq('organizacao_id', scope.organizationId)
      .maybeSingle();
    if (error) throw new Error(`Falha ao validar escopo do evento Chatwoot: ${error.message}`);
    if (!data) throw new Error('Evento Chatwoot fora do escopo organizacional verificado.');
  }

  /**
   * Aceita a entrega na inbox numa transação do banco: confere a conexão, grava
   * o evento e a entrega com `on conflict` e só então devolve `EntregaAceita`.
   * Qualquer outro desfecho não gravou nada e não pode virar ACK.
   */
  async aceitarEntrega(
    supabase: SupabaseClient,
    scope: VerifiedOrganizationScope,
    params: {
      conexaoId: string;
      inboxId: number | null;
      deliveryId: string | null;
      idempotencyKey: string;
      eventType: string;
      payload: Record<string, unknown>;
    }
  ): Promise<AceiteDeEntregaChatwoot> {
    const { data, error } = await supabase.rpc('aceitar_entrega_inbox_chatwoot', {
      p_organizacao_id: scope.organizationId,
      p_conexao_id: params.conexaoId,
      p_user_id: scope.actorId,
      p_inbox_id: params.inboxId,
      p_delivery_id: params.deliveryId,
      p_idempotency_key: params.idempotencyKey,
      p_event_type: params.eventType,
      p_payload: params.payload,
    });

    if (error) {
      return RECUSA_POR_SQLSTATE[error.code ?? ''] ?? { _tag: 'InboxIndisponivel', cause: error.code || 'rpc-error' };
    }

    const row = AceiteRowSchema.safeParse(Array.isArray(data) ? data[0] : data);
    if (!row.success) return { _tag: 'InboxIndisponivel', cause: 'resposta-invalida' };

    return {
      _tag: 'EntregaAceita',
      eventoId: row.data.evento_id,
      status: row.data.status,
      duplicata: row.data.duplicata,
      cachedResponse: row.data.cached_response,
    };
  }

  /**
   * Prepara um evento no inbox para replay seguro, restaurando o estado e retornando o payload.
   */
  async prepareReplay(
    supabase: SupabaseClient,
    scope: VerifiedOrganizationScope,
    eventoId: string
  ): Promise<{
    eventoId: string;
    organizacaoId: string;
    conexaoId?: string | null;
    userId?: string | null;
    inboxId?: number | null;
    eventType: string;
    payload: Record<string, unknown>;
  } | null> {
    await this.assertEventScope(supabase, scope, eventoId);
    const { data, error } = await supabase.rpc('preparar_replay_evento_inbox_chatwoot', {
      p_evento_id: eventoId,
    });

    if (error || !data) {
      console.error('❌ Falha ao preparar replay de evento Chatwoot:', error?.message);
      return null;
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;

    return {
      eventoId: row.evento_id,
      organizacaoId: row.organizacao_id,
      conexaoId: row.conexao_id,
      userId: row.user_id,
      inboxId: row.inbox_id,
      eventType: row.event_type,
      payload: row.payload,
    };
  }
}

export const chatwootInboxService = new ChatwootInboxService();
