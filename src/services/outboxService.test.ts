import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  classifyError,
  calculateBackoffSeconds,
  outboxService,
  OutboxIntencaoDivergente,
} from './outboxService';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

const scope = { organizationId: 'org-1', actorId: 'user-1', role: 'owner' } as unknown as VerifiedOrganizationScope;

const mockRpc = vi.fn();
const mockFrom = vi.fn();

const mockSupabase = {
  rpc: (...args: unknown[]) => mockRpc(...args),
  from: (...args: unknown[]) => mockFrom(...args),
} as unknown as SupabaseClient;

beforeEach(() => {
  vi.clearAllMocks();
  mockFrom.mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'scoped' }, error: null }),
        }),
      }),
    }),
  });
});

describe('outboxService', () => {
  describe('classifyError', () => {
    it('classifies 429 rate limit errors as transient', () => {
      const err = new Error('HTTP 429 Too Many Requests: Rate limit exceeded');
      const result = classifyError(err);
      expect(result.category).toBe('rate_limit');
      expect(result.isTransient).toBe(true);
    });

    it('classifies 502/503/504 and gateway timeouts as transient', () => {
      const err = new Error('503 Service Unavailable: Gateway Timeout');
      const result = classifyError(err);
      expect(result.category).toBe('transient');
      expect(result.isTransient).toBe(true);
    });

    it('classifies network connection errors as transient', () => {
      const err = new Error('fetch failed with ECONNRESET');
      const result = classifyError(err);
      expect(result.category).toBe('transient');
      expect(result.isTransient).toBe(true);
    });

    it('classifies 401 and invalid_grant as auth_expired (permanent/terminal)', () => {
      const err = new Error('401 Unauthorized: invalid_grant');
      const result = classifyError(err);
      expect(result.category).toBe('auth_expired');
      expect(result.isTransient).toBe(false);
    });

    it('classifies 400 Bad Request and validation errors as permanent', () => {
      const err = new Error('400 Bad Request: Invalid field "conversationId"');
      const result = classifyError(err);
      expect(result.category).toBe('permanent');
      expect(result.isTransient).toBe(false);
    });

    it('redacts sensitive bearer tokens and secrets from error messages', () => {
      const err = new Error('Failed with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret and secret_key=supersecret123');
      const result = classifyError(err);
      expect(result.message).not.toContain('supersecret123');
      expect(result.message).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret');
    });
  });

  describe('calculateBackoffSeconds', () => {
    it('calculates exponential backoff based on attempt count', () => {
      expect(calculateBackoffSeconds(0, 10)).toBe(10);
      expect(calculateBackoffSeconds(1, 10)).toBe(20);
      expect(calculateBackoffSeconds(2, 10)).toBe(40);
      expect(calculateBackoffSeconds(3, 10)).toBe(80);
    });

    it('caps backoff at maximum seconds limit', () => {
      expect(calculateBackoffSeconds(10, 10, 300)).toBe(300);
    });
  });

  describe('enqueue', () => {
    it('registers a new outbox event successfully', async () => {
      mockRpc.mockResolvedValueOnce({
        data: [{ evento_id: 'evt-123', status: 'pending', is_duplicate: false }],
        error: null,
      });

      const result = await outboxService.enqueue(mockSupabase, scope, {
        idempotencyKey: 'key-1',
        destination: 'chatwoot',
        eventType: 'message.send',
        payload: { content: 'Olá' },
      });

      expect(result.eventoId).toBe('evt-123');
      expect(result.status).toBe('pending');
      expect(result.isDuplicate).toBe(false);
    });

    it('returns existing event when duplicate key is provided', async () => {
      mockRpc.mockResolvedValueOnce({
        data: [{ evento_id: 'evt-existing', status: 'sent', is_duplicate: true }],
        error: null,
      });

      const result = await outboxService.enqueue(mockSupabase, scope, {
        idempotencyKey: 'key-dup',
        destination: 'chatwoot',
        eventType: 'message.send',
        payload: { content: 'Olá' },
      });

      expect(result.eventoId).toBe('evt-existing');
      expect(result.isDuplicate).toBe(true);
    });

    it('throws when RPC fails', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'Database connection lost' },
      });

      await expect(
        outboxService.enqueue(mockSupabase, scope, {
          idempotencyKey: 'key-err',
          destination: 'chatwoot',
          eventType: 'message.send',
          payload: {},
        }),
      ).rejects.toThrow('Falha ao registrar evento no outbox: Database connection lost');
    });

    it('refuses the same key with another intention as a typed failure (23505)', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'outra intencao' } });

      await expect(
        outboxService.enqueue(mockSupabase, scope, {
          idempotencyKey: 'k', destination: 'chatwoot', eventType: 'message.send', payload: { content: 'outro' },
        }),
      ).rejects.toBeInstanceOf(OutboxIntencaoDivergente);
    });
  });

  describe('claimBatch', () => {
    const linha = {
      evento_id: '11111111-1111-4111-8111-111111111111',
      organizacao_id: '22222222-2222-4222-8222-222222222222',
      conexao_id: null,
      destination: 'chatwoot',
      event_type: 'message.send',
      payload: { content: 'oi' },
      attempts: 0,
      max_attempts: 5,
      lease_owner: 'worker-1',
      lease_expires_at: '2026-10-26T00:00:00Z',
      correlation_id: null,
      fencing_token: '3',
    };

    it('claims with the fencing RPC and parses the token', async () => {
      mockRpc.mockResolvedValueOnce({ data: [linha], error: null });

      const result = await outboxService.claimBatch(mockSupabase, 'worker-1', 10, 300);

      expect(result[0]!.fencing_token).toBe(3);
      expect(mockRpc).toHaveBeenCalledWith('reivindicar_tentativas_outbox', {
        p_worker_id: 'worker-1',
        p_limit: 10,
        p_lease_ttl_sec: 300,
      });
    });

    it('rejects a claimed row without a fencing token instead of dispatching blind', async () => {
      mockRpc.mockResolvedValueOnce({ data: [{ ...linha, fencing_token: null }], error: null });

      await expect(outboxService.claimBatch(mockSupabase, 'worker-1')).rejects.toThrow();
    });

    it('rejects claiming a batch without a workerId', async () => {
      await expect(outboxService.claimBatch(mockSupabase, '', 10)).rejects.toThrow(
        'workerId é obrigatório',
      );
      expect(mockRpc).not.toHaveBeenCalled();
    });
  });

  describe('startDispatch and concludeAttempt', () => {
    it('starts the dispatch with owner and token', async () => {
      mockRpc.mockResolvedValueOnce({ data: true, error: null });

      expect(await outboxService.startDispatch(mockSupabase, 'evt-1', 'w', 4)).toBe(true);
      expect(mockRpc).toHaveBeenCalledWith('iniciar_despacho_outbox', { p_evento_id: 'evt-1', p_worker_id: 'w', p_fencing_token: 4 });
    });

    const posse = { eventoId: 'evt-1', workerId: 'w', fencingToken: 4 };

    it('sends the receipt only for a confirmed outcome', async () => {
      mockRpc.mockResolvedValueOnce({ data: 'sent', error: null });

      expect(await outboxService.concludeAttempt(mockSupabase, posse, { _tag: 'Confirmado', recibo: '99' })).toBe('sent');
      expect(mockRpc).toHaveBeenCalledWith('concluir_tentativa_outbox', {
        p_evento_id: 'evt-1', p_worker_id: 'w', p_fencing_token: 4,
        p_desfecho: 'confirmado', p_recibo_ref: '99', p_resposta: null,
      });
    });

    it('records an unknown outcome with its reason and a redacted error, never a receipt', async () => {
      mockRpc.mockResolvedValueOnce({ data: 'unknown', error: null });

      await outboxService.concludeAttempt(mockSupabase, posse, { _tag: 'Desconhecido', motivo: 'timeout', erro: 'Bearer abc.def' });

      const args = mockRpc.mock.calls[0]![1];
      expect(args).toMatchObject({ p_desfecho: 'desconhecido', p_motivo: 'timeout', p_erro: 'Bearer [REDACTED]' });
      expect(args).not.toHaveProperty('p_recibo_ref');
    });

    it('honors Retry-After only for a proven non-application', async () => {
      mockRpc.mockResolvedValueOnce({ data: 'failed_transient', error: null });

      await outboxService.concludeAttempt(mockSupabase, posse, {
        _tag: 'NaoEnviado', prova: 'nao_aplicacao_documentada', retryAfterSeconds: 120, erro: '429',
      });

      expect(mockRpc.mock.calls[0]![1]).toMatchObject({ p_desfecho: 'nao_enviado', p_retry_delay_sec: 120 });
    });

    it('returns null when the CAS refuses an old lease or token', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });

      expect(await outboxService.concludeAttempt(mockSupabase, posse, { _tag: 'Confirmado', recibo: '1' })).toBeNull();
    });

    it('throws a database error instead of reporting an outcome', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'db down' } });

      await expect(outboxService.concludeAttempt(mockSupabase, posse, { _tag: 'Confirmado', recibo: '1' })).rejects.toThrow('db down');
    });
  });

  describe('releaseExpiredLeases', () => {
    it('maps reaper RPC rows to camelCase results', async () => {
      mockRpc.mockResolvedValueOnce({
        data: [{ evento_id: 'evt-9', novo_status: 'failed_transient' }],
        error: null,
      });

      const result = await outboxService.releaseExpiredLeases(mockSupabase);

      expect(mockRpc).toHaveBeenCalledWith('liberar_leases_expirados_outbox');
      expect(result).toEqual([{ eventoId: 'evt-9', novoStatus: 'failed_transient' }]);
    });

    it('returns an empty array and warns when the RPC errors, without throwing', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'db down' } });

      const result = await outboxService.releaseExpiredLeases(mockSupabase);

      expect(result).toEqual([]);
    });
  });

  describe('getIntegrationsHealth', () => {
    it('returns sanitized health status for all organization connections', async () => {
      const mockConnections = [
        {
          id: 'conn-1',
          provedor: 'chatwoot',
          nome: 'Principal',
          status: 'conectado',
          health_status: 'healthy',
          last_health_check_at: '2026-08-20T16:00:00Z',
          last_health_error: null,
        },
        {
          id: 'conn-2',
          provedor: 'bling',
          nome: 'Principal',
          status: 'conectado',
          health_status: 'degraded',
          last_health_check_at: '2026-08-20T16:05:00Z',
          last_health_error: 'Rate limit with key=secret123',
        },
      ];

      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValueOnce({ data: mockConnections, error: null }),
      });

      const result = await outboxService.getIntegrationsHealth(mockSupabase, scope);
      expect(result).toHaveLength(2);
      expect(result[0].health_status).toBe('healthy');
      expect(result[1].health_status).toBe('degraded');
      expect(result[1].last_health_error).not.toContain('secret123');
    });
  });
});
