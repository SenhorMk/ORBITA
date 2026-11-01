import { describe, expect, it, vi } from 'vitest';
import {
  ChatwootInboxService,
  chaveDoEventoChatwoot,
  type EntregaChatwoot,
} from './chatwootInboxService';
import { SupabaseClient } from '@supabase/supabase-js';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

const scope = { organizationId: 'org-abc', actorId: 'user-123', role: 'owner' } as unknown as VerifiedOrganizationScope;

function scopedClient(rpc: ReturnType<typeof vi.fn>): SupabaseClient {
  return {
    rpc,
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'scoped' }, error: null }),
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe('ChatwootInboxService & Idempotency Boundary', () => {
  describe('chaveDoEventoChatwoot (MSG-005)', () => {
    const conta = { id: 1 };
    const semEntrega: EntregaChatwoot = { deliveryId: null, timestampAssinado: '1700000000' };
    const chave = (evento: Record<string, unknown>, entrega = semEntrega) =>
      chaveDoEventoChatwoot({ account: conta, ...evento } as Parameters<typeof chaveDoEventoChatwoot>[0], entrega);

    it('message_created: uma chave por mensagem, igual em qualquer entrega', () => {
      const evento = { event: 'message_created', id: 500, conversation: { id: 50 }, content: 'Olá' };
      expect(chave(evento)).toBe('v2:message_created:msg:500');
      expect(chave(evento, { deliveryId: 'outra', timestampAssinado: '1700000099' })).toBe('v2:message_created:msg:500');
    });

    it('message_updated: created → edited → edited são três chaves; o mesmo conteúdo em outra revisão também separa', () => {
      const created = chave({ event: 'message_created', id: 500, content: 'A' });
      const edit1 = chave({ event: 'message_updated', id: 500, content: 'B' }, { deliveryId: 'd-1', timestampAssinado: '1' });
      const edit2 = chave({ event: 'message_updated', id: 500, content: 'A' }, { deliveryId: 'd-2', timestampAssinado: '2' });
      const edit3 = chave({ event: 'message_updated', id: 500, content: 'B' }, { deliveryId: 'd-3', timestampAssinado: '3' });
      expect(new Set([created, edit1, edit2, edit3]).size).toBe(4);
    });

    it('message_updated: a repetição da mesma entrega dá a mesma chave', () => {
      const evento = { event: 'message_updated', id: 500, content: 'B' };
      expect(chave(evento, { deliveryId: 'd-1', timestampAssinado: '1' })).toBe(chave(evento, { deliveryId: 'd-1', timestampAssinado: '9' }));
      expect(chave(evento)).toBe(chave(evento));
    });

    it('updated_at do provedor marca a revisão e prevalece sobre o delivery id', () => {
      const evento = { event: 'message_updated', id: 500, content: 'B', updated_at: '2026-10-26T10:00:00Z' };
      expect(chave(evento, { deliveryId: 'd-1', timestampAssinado: '1' })).toBe(chave(evento, { deliveryId: 'd-2', timestampAssinado: '2' }));
      expect(chave(evento)).not.toBe(chave({ ...evento, updated_at: '2026-10-26T10:00:01Z' }));
    });

    it('status: open → resolved → open → resolved são quatro chaves', () => {
      const status = (s: string, n: number) =>
        chave({ event: 'conversation_status_changed', conversation: { id: 50, status: s } }, { deliveryId: `d-${n}`, timestampAssinado: String(n) });
      expect(new Set([status('open', 1), status('resolved', 2), status('open', 3), status('resolved', 4)]).size).toBe(4);
    });

    it('status sem delivery id e sem updated_at: o timestamp assinado separa as ocorrências', () => {
      const evento = { event: 'conversation_status_changed', conversation: { id: 50, status: 'resolved' } };
      expect(chave(evento, { deliveryId: null, timestampAssinado: '1' })).not.toBe(chave(evento, { deliveryId: null, timestampAssinado: '2' }));
    });

    it('evento sem forma conhecida: chave determinística pelo conteúdo e pela revisão', () => {
      const evento = { event: 'contact_updated', id: 999, content: 'x' };
      expect(chave(evento)).toBe(chave(evento));
      expect(chave(evento)).toMatch(/^v2:contact_updated:999:t1700000000:[0-9a-f]{32}$/);
    });
  });

  describe('aceitarEntrega', () => {
    const params = {
      conexaoId: 'conn-123',
      inboxId: 10,
      deliveryId: 'd-1',
      idempotencyKey: 'v2:message_created:msg:123',
      eventType: 'message_created',
      payload: { id: 123 },
    };

    it('chama aceitar_entrega_inbox_chatwoot com o escopo verificado e devolve EntregaAceita', async () => {
      const mockRpc = vi.fn().mockResolvedValue({
        data: [{ evento_id: '00000000-0000-4000-8000-000000000001', status: 'received', is_duplicate: false, duplicata: null, cached_response: null }],
        error: null,
      });
      const result = await new ChatwootInboxService().aceitarEntrega(scopedClient(mockRpc), scope, params);

      expect(mockRpc).toHaveBeenCalledWith('aceitar_entrega_inbox_chatwoot', {
        p_organizacao_id: 'org-abc',
        p_conexao_id: 'conn-123',
        p_user_id: 'user-123',
        p_inbox_id: 10,
        p_delivery_id: 'd-1',
        p_idempotency_key: 'v2:message_created:msg:123',
        p_event_type: 'message_created',
        p_payload: { id: 123 },
      });
      expect(result).toEqual({
        _tag: 'EntregaAceita', eventoId: '00000000-0000-4000-8000-000000000001', status: 'received', duplicata: null, cachedResponse: null,
      });
    });

    it('duplicata devolve a origem e a resposta gravada', async () => {
      const mockRpc = vi.fn().mockResolvedValue({
        data: [{ evento_id: '00000000-0000-4000-8000-000000000001', status: 'processed', is_duplicate: true, duplicata: 'entrega', cached_response: { success: true } }],
        error: null,
      });
      expect(await new ChatwootInboxService().aceitarEntrega(scopedClient(mockRpc), scope, params)).toMatchObject({
        _tag: 'EntregaAceita', duplicata: 'entrega', status: 'processed', cachedResponse: { success: true },
      });
    });

    it.each([
      ['23505', { _tag: 'EntregaConflitante' }],
      ['42501', { _tag: 'ConexaoRecusada', motivo: 'fora_do_escopo' }],
      ['55000', { _tag: 'ConexaoRecusada', motivo: 'desligada' }],
      ['22023', { _tag: 'EntradaRecusada' }],
      ['08006', { _tag: 'InboxIndisponivel', cause: '08006' }],
    ])('SQLSTATE %s vira recusa tipada, sem lançar', async (code, esperado) => {
      const mockRpc = vi.fn().mockResolvedValue({ data: null, error: { code, message: 'detalhe interno' } });
      expect(await new ChatwootInboxService().aceitarEntrega(scopedClient(mockRpc), scope, params)).toEqual(esperado);
    });

    it('resposta fora do contrato é InboxIndisponivel, nunca aceite', async () => {
      const mockRpc = vi.fn().mockResolvedValue({ data: [{ evento_id: 'evt-1', status: 'desconhecido', duplicata: null, cached_response: null }], error: null });
      expect(await new ChatwootInboxService().aceitarEntrega(scopedClient(mockRpc), scope, params)).toEqual({
        _tag: 'InboxIndisponivel', cause: 'resposta-invalida',
      });
    });
  });

  describe('prepareReplay', () => {
    it('calls preparar_replay_evento_inbox_chatwoot and returns intact payload', async () => {
      const mockRpc = vi.fn().mockResolvedValue({
        data: [{
          evento_id: 'evt-123',
          organizacao_id: 'org-abc',
          conexao_id: 'conn-123',
          user_id: 'user-123',
          inbox_id: 10,
          event_type: 'message_created',
          payload: { id: 500, content: 'Mensagem' },
        }],
        error: null,
      });

      const mockSupabase = scopedClient(mockRpc);
      const service = new ChatwootInboxService();

      const replay = await service.prepareReplay(mockSupabase, scope, 'evt-123');

      expect(mockRpc).toHaveBeenCalledWith('preparar_replay_evento_inbox_chatwoot', {
        p_evento_id: 'evt-123',
      });
      expect(replay?.eventoId).toBe('evt-123');
      expect(replay?.payload).toEqual({ id: 500, content: 'Mensagem' });
    });
  });
});
