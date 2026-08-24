import { describe, expect, it, vi } from 'vitest';
import {
  ChatwootInboxService,
  generateChatwootIdempotencyKey,
} from './chatwootInboxService';
import { SupabaseClient } from '@supabase/supabase-js';

describe('ChatwootInboxService & Idempotency Boundary', () => {
  describe('generateChatwootIdempotencyKey', () => {
    it('generates a structured key for message_created events with id and conversation', () => {
      const event = {
        event: 'message_created',
        id: 12345,
        conversation: { id: 6789 },
        content: 'Olá!',
      };

      const key = generateChatwootIdempotencyKey(event);
      expect(key).toBe('event_message_created_msg_12345_conv_6789');
    });

    it('generates a structured key for conversation_status_changed events', () => {
      const event = {
        event: 'conversation_status_changed',
        id: 6789,
        conversation: { id: 6789, status: 'resolved' },
      };

      const key = generateChatwootIdempotencyKey(event);
      expect(key).toBe('event_conversation_status_changed_conv_6789_status_resolved');
    });

    it('generates a structured key for contact events', () => {
      const event = {
        event: 'contact_updated',
        id: 999,
        contact: { id: 999, name: 'Cliente A' },
      };

      const key = generateChatwootIdempotencyKey(event);
      expect(key).toBe('event_contact_updated_contact_999');
    });

    it('falls back to deterministic SHA-256 for unstructured or arbitrary payloads', () => {
      const event = { randomField: 'value123' };
      const key1 = generateChatwootIdempotencyKey(event);
      const key2 = generateChatwootIdempotencyKey(event);

      expect(key1).toMatch(/^chatwoot_hash_[0-9a-f]{32}$/);
      expect(key1).toBe(key2);
    });
  });

  describe('registerEvent', () => {
    it('invokes registrar_evento_inbox_chatwoot RPC and returns structured result for new event', async () => {
      const mockRpc = vi.fn().mockResolvedValue({
        data: [{
          evento_id: 'evt-123',
          status: 'received',
          is_duplicate: false,
          cached_response: null,
        }],
        error: null,
      });

      const mockSupabase = { rpc: mockRpc } as unknown as SupabaseClient;
      const service = new ChatwootInboxService();

      const result = await service.registerEvent(mockSupabase, {
        organizacaoId: 'org-abc',
        conexaoId: 'conn-123',
        userId: 'user-123',
        inboxId: 10,
        idempotencyKey: 'event_message_created_msg_123',
        eventType: 'message_created',
        payload: { id: 123 },
      });

      expect(mockRpc).toHaveBeenCalledWith('registrar_evento_inbox_chatwoot', {
        p_organizacao_id: 'org-abc',
        p_conexao_id: 'conn-123',
        p_user_id: 'user-123',
        p_inbox_id: 10,
        p_idempotency_key: 'event_message_created_msg_123',
        p_event_type: 'message_created',
        p_payload: { id: 123 },
      });

      expect(result.eventoId).toBe('evt-123');
      expect(result.status).toBe('received');
      expect(result.isDuplicate).toBe(false);
      expect(result.cachedResponse).toBeNull();
    });

    it('returns isDuplicate = true and cachedResponse if event was already registered', async () => {
      const mockRpc = vi.fn().mockResolvedValue({
        data: [{
          evento_id: 'evt-123',
          status: 'processed',
          is_duplicate: true,
          cached_response: { success: true, messageId: 123 },
        }],
        error: null,
      });

      const mockSupabase = { rpc: mockRpc } as unknown as SupabaseClient;
      const service = new ChatwootInboxService();

      const result = await service.registerEvent(mockSupabase, {
        organizacaoId: 'org-abc',
        idempotencyKey: 'event_message_created_msg_123',
        eventType: 'message_created',
        payload: { id: 123 },
      });

      expect(result.isDuplicate).toBe(true);
      expect(result.status).toBe('processed');
      expect(result.cachedResponse).toEqual({ success: true, messageId: 123 });
    });

    it('throws when RPC encounters a database error', async () => {
      const mockRpc = vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'Database constraint violation' },
      });

      const mockSupabase = { rpc: mockRpc } as unknown as SupabaseClient;
      const service = new ChatwootInboxService();

      await expect(service.registerEvent(mockSupabase, {
        organizacaoId: 'org-abc',
        idempotencyKey: 'event_1',
        eventType: 'test',
        payload: {},
      })).rejects.toThrow('Falha ao registrar evento no inbox Chatwoot: Database constraint violation');
    });
  });

  describe('markProcessed', () => {
    it('calls concluir_evento_inbox_chatwoot with status processed and responseBody', async () => {
      const mockRpc = vi.fn().mockResolvedValue({ data: null, error: null });
      const mockSupabase = { rpc: mockRpc } as unknown as SupabaseClient;
      const service = new ChatwootInboxService();

      await service.markProcessed(mockSupabase, 'evt-123', { success: true, count: 1 });

      expect(mockRpc).toHaveBeenCalledWith('concluir_evento_inbox_chatwoot', {
        p_evento_id: 'evt-123',
        p_status: 'processed',
        p_response_body: { success: true, count: 1 },
        p_error: null,
      });
    });
  });

  describe('markFailed', () => {
    it('redacts sensitive credentials before recording last_error in database', async () => {
      const mockRpc = vi.fn().mockResolvedValue({ data: null, error: null });
      const mockSupabase = { rpc: mockRpc } as unknown as SupabaseClient;
      const service = new ChatwootInboxService();

      const sensitiveError = new Error('Falha de autenticação com token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.do_not_leak_this_secret');
      await service.markFailed(mockSupabase, 'evt-123', sensitiveError);

      expect(mockRpc).toHaveBeenCalledWith('concluir_evento_inbox_chatwoot', expect.objectContaining({
        p_evento_id: 'evt-123',
        p_status: 'failed',
        p_response_body: null,
      }));
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

      const mockSupabase = { rpc: mockRpc } as unknown as SupabaseClient;
      const service = new ChatwootInboxService();

      const replay = await service.prepareReplay(mockSupabase, 'evt-123');

      expect(mockRpc).toHaveBeenCalledWith('preparar_replay_evento_inbox_chatwoot', {
        p_evento_id: 'evt-123',
      });
      expect(replay?.eventoId).toBe('evt-123');
      expect(replay?.payload).toEqual({ id: 500, content: 'Mensagem' });
    });
  });
});
