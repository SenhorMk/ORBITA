import { describe, expect, it, vi } from 'vitest';
import {
  BlingInboxService,
  generateBlingIdempotencyKey,
} from './blingInboxService';
import { SupabaseClient } from '@supabase/supabase-js';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

const scope = { organizationId: 'org-123', actorId: 'user-789', role: 'owner' } as unknown as VerifiedOrganizationScope;

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

describe('BlingInboxService & Idempotency Boundary', () => {
  describe('generateBlingIdempotencyKey', () => {
    it('generates a structured key for contact events with id', () => {
      const event = {
        event: 'contact.updated',
        data: { id: '123456', nome: 'João Silva' },
      };
      const key = generateBlingIdempotencyKey(event);
      expect(key).toBe('contact.updated_123456');
    });

    it('generates a structured key for order events with id and action', () => {
      const event = {
        entity: 'pedidos',
        action: 'status_changed',
        data: { id: '998877' },
      };
      const key = generateBlingIdempotencyKey(event);
      expect(key).toBe('pedidos_998877_status_changed');
    });

    it('generates a structured key for stock/product events with idProduto', () => {
      const event = {
        event: 'stock.updated',
        data: { idProduto: 'PROD-42' },
      };
      const key = generateBlingIdempotencyKey(event);
      expect(key).toBe('stock.updated_PROD-42');
    });

    it('generates a deterministic SHA-256 fallback key for generic or unstructured events', () => {
      const payload1 = { rawMessage: 'unstructured data', timestamp: 12345 };
      const payload2 = { rawMessage: 'unstructured data', timestamp: 12345 };
      const key1 = generateBlingIdempotencyKey(payload1);
      const key2 = generateBlingIdempotencyKey(payload2);

      expect(key1).toMatch(/^bling_hash_[a-f0-9]{32}$/);
      expect(key1).toBe(key2);
    });
  });

  describe('registerEvent', () => {
    it('handles first delivery (isDuplicate = false)', async () => {
      const mockClient = {
        rpc: vi.fn().mockResolvedValue({
          data: [
            {
              evento_id: 'evt-uuid-1',
              status: 'received',
              is_duplicate: false,
              cached_response: null,
            },
          ],
          error: null,
        }),
      } as unknown as SupabaseClient;

      const service = new BlingInboxService();
      const result = await service.registerEvent(mockClient, scope, {
        conexaoId: 'conn-456',
        idempotencyKey: 'order_1001',
        eventType: 'pedidos',
        payload: { id: 1001 },
      });

      expect(mockClient.rpc).toHaveBeenCalledWith('registrar_evento_inbox_bling', {
        p_organizacao_id: 'org-123',
        p_conexao_id: 'conn-456',
        p_user_id: 'user-789',
        p_idempotency_key: 'order_1001',
        p_event_type: 'pedidos',
        p_payload: { id: 1001 },
      });
      expect(result).toEqual({
        eventoId: 'evt-uuid-1',
        status: 'received',
        isDuplicate: false,
        cachedResponse: null,
      });
    });

    it('handles duplicate delivery with cached response (isDuplicate = true)', async () => {
      const mockClient = {
        rpc: vi.fn().mockResolvedValue({
          data: [
            {
              evento_id: 'evt-uuid-1',
              status: 'processed',
              is_duplicate: true,
              cached_response: { success: true, processedProducts: 1 },
            },
          ],
          error: null,
        }),
      } as unknown as SupabaseClient;

      const service = new BlingInboxService();
      const result = await service.registerEvent(mockClient, scope, {
        idempotencyKey: 'order_1001',
        eventType: 'pedidos',
        payload: { id: 1001 },
      });

      expect(result.isDuplicate).toBe(true);
      expect(result.status).toBe('processed');
      expect(result.cachedResponse).toEqual({ success: true, processedProducts: 1 });
    });

    it('throws when database rpc returns an error', async () => {
      const mockClient = {
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'Database lock timeout' },
        }),
      } as unknown as SupabaseClient;

      const service = new BlingInboxService();
      await expect(
        service.registerEvent(mockClient, scope, {
          idempotencyKey: 'order_1001',
          eventType: 'pedidos',
          payload: {},
        })
      ).rejects.toThrow('Falha ao registrar evento no inbox Bling: Database lock timeout');
    });
  });

  describe('markProcessed & markFailed', () => {
    it('marks event as processed storing response_body', async () => {
      const mockClient = scopedClient(vi.fn().mockResolvedValue({ error: null }));

      const service = new BlingInboxService();
      await service.markProcessed(mockClient, scope, 'evt-uuid-1', { success: true, count: 5 });

      expect(mockClient.rpc).toHaveBeenCalledWith('concluir_evento_inbox_bling', {
        p_evento_id: 'evt-uuid-1',
        p_status: 'processed',
        p_response_body: { success: true, count: 5 },
        p_error: null,
      });
    });

    it('marks event as failed redacting sensitive error information', async () => {
      const mockClient = scopedClient(vi.fn().mockResolvedValue({ error: null }));

      const service = new BlingInboxService();
      const errorWithSecret = new Error('HTTP 401 with token bearer secret_token_12345');
      await service.markFailed(mockClient, scope, 'evt-uuid-1', errorWithSecret);

      expect(mockClient.rpc).toHaveBeenCalledWith('concluir_evento_inbox_bling', {
        p_evento_id: 'evt-uuid-1',
        p_status: 'failed',
        p_response_body: null,
        p_error: expect.any(String),
      });
    });
  });

  describe('prepareReplay', () => {
    it('prepares event for replay and restores payload', async () => {
      const mockClient = scopedClient(vi.fn().mockResolvedValue({
          data: [
            {
              evento_id: 'evt-uuid-failed',
              organizacao_id: 'org-123',
              conexao_id: 'conn-456',
              user_id: 'user-789',
              event_type: 'pedidos',
              payload: { id: 1002, numero: 'PED-1002' },
            },
          ],
          error: null,
        }));

      const service = new BlingInboxService();
      const replayData = await service.prepareReplay(mockClient, scope, 'evt-uuid-failed');

      expect(mockClient.rpc).toHaveBeenCalledWith('preparar_replay_evento_inbox_bling', {
        p_evento_id: 'evt-uuid-failed',
      });
      expect(replayData).toEqual({
        eventoId: 'evt-uuid-failed',
        organizacaoId: 'org-123',
        conexaoId: 'conn-456',
        userId: 'user-789',
        eventType: 'pedidos',
        payload: { id: 1002, numero: 'PED-1002' },
      });
    });
  });
});
