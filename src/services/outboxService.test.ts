import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  classifyError,
  calculateBackoffSeconds,
  outboxService,
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
  });

  describe('claimBatch', () => {
    it('claims available batch of outbox events', async () => {
      const mockBatch = [
        { id: 'evt-1', destination: 'chatwoot', event_type: 'message.send' },
        { id: 'evt-2', destination: 'bling', event_type: 'order.push' },
      ];
      mockRpc.mockResolvedValueOnce({ data: mockBatch, error: null });

      const result = await outboxService.claimBatch(mockSupabase, 10);
      expect(result).toHaveLength(2);
      expect(mockRpc).toHaveBeenCalledWith('reivindicar_lote_outbox', { p_limit: 10 });
    });
  });

  describe('markSent and markFailed', () => {
    it('calls concluir_evento_outbox with status sent on success', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });

      await outboxService.markSent(mockSupabase, scope, 'evt-1', { messageId: 456 });

      expect(mockRpc).toHaveBeenCalledWith('concluir_evento_outbox', {
        p_evento_id: 'evt-1',
        p_status: 'sent',
        p_response_body: { messageId: 456 },
        p_error: null,
        p_error_category: null,
        p_retry_delay_sec: 0,
      });
    });

    it('calls concluir_evento_outbox with failed_transient for transient errors', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });

      await outboxService.markFailed(
        mockSupabase,
        scope,
        'evt-1',
        new Error('503 Service Unavailable'),
        1,
      );

      expect(mockRpc).toHaveBeenCalledWith(
        'concluir_evento_outbox',
        expect.objectContaining({
          p_evento_id: 'evt-1',
          p_status: 'failed_transient',
          p_error_category: 'transient',
          p_retry_delay_sec: 20,
        }),
      );
    });

    it('calls concluir_evento_outbox with dead_letter for permanent errors without loop', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });

      await outboxService.markFailed(
        mockSupabase,
        scope,
        'evt-1',
        new Error('400 Bad Request: Invalid parameters'),
        0,
      );

      expect(mockRpc).toHaveBeenCalledWith(
        'concluir_evento_outbox',
        expect.objectContaining({
          p_evento_id: 'evt-1',
          p_status: 'dead_letter',
          p_error_category: 'permanent',
        }),
      );
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
