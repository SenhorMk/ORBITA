/**
 * syncJobRepository.test.ts
 * Ticket 34: Testes unitários do syncJobRepository.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock do supabaseServer antes de qualquer importação do módulo
const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock('../lib/supabaseServer', () => ({
  supabaseServer: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

import {
  enqueueJob,
  acquireLease,
  advanceCheckpoint,
  completeJob,
  getJobStatus,
  releaseExpiredLeases,
} from './syncJobRepository';

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// enqueueJob
// ---------------------------------------------------------------------------

describe('syncJobRepository', () => {
  describe('enqueueJob', () => {
    it('retorna novo job (isNew=true) na primeira chamada', async () => {
      mockRpc.mockResolvedValueOnce({
        data: [{ job_id: 'uuid-novo', status: 'queued', is_new: true }],
        error: null,
      });

      const result = await enqueueJob('org-123', 'user-abc');
      expect(result.jobId).toBe('uuid-novo');
      expect(result.status).toBe('queued');
      expect(result.isNew).toBe(true);
    });

    it('retorna job existente (isNew=false) quando já há job ativo', async () => {
      mockRpc.mockResolvedValueOnce({
        data: [{ job_id: 'uuid-existente', status: 'running', is_new: false }],
        error: null,
      });

      const result = await enqueueJob('org-123', 'user-abc');
      expect(result.jobId).toBe('uuid-existente');
      expect(result.isNew).toBe(false);
    });

    it('lança erro quando RPC falha', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'DB error' } });

      await expect(enqueueJob('org-123', 'user-abc')).rejects.toThrow(
        'Falha ao registrar job de sincronização: DB error',
      );
    });
  });

  // -------------------------------------------------------------------------
  // acquireLease
  // -------------------------------------------------------------------------

  describe('acquireLease', () => {
    it('retorna true quando o lease é adquirido com sucesso', async () => {
      mockRpc.mockResolvedValueOnce({ data: true, error: null });
      expect(await acquireLease('job-abc')).toBe(true);
    });

    it('retorna false quando outro processo já possui o lease', async () => {
      mockRpc.mockResolvedValueOnce({ data: false, error: null });
      expect(await acquireLease('job-abc')).toBe(false);
    });

    it('lança erro quando RPC falha', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'lock timeout' } });
      await expect(acquireLease('job-abc')).rejects.toThrow(
        'Falha ao adquirir lease do job job-abc: lock timeout',
      );
    });
  });

  // -------------------------------------------------------------------------
  // advanceCheckpoint
  // -------------------------------------------------------------------------

  describe('advanceCheckpoint', () => {
    it('confirma progresso sem lançar erro em caso de sucesso', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });

      await expect(
        advanceCheckpoint('job-abc', { clientes_processados: 50, etapa_atual: 'clientes' }),
      ).resolves.toBeUndefined();
    });

    it('lança erro quando checkpoint falha no banco', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'checkpoint failed' } });

      await expect(advanceCheckpoint('job-abc', {})).rejects.toThrow(
        'Falha ao avançar checkpoint do job job-abc: checkpoint failed',
      );
    });
  });

  // -------------------------------------------------------------------------
  // completeJob
  // -------------------------------------------------------------------------

  describe('completeJob', () => {
    it('conclui job com status completed sem erro', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });
      await expect(completeJob('job-abc', 'completed')).resolves.toBeUndefined();
    });

    it('conclui job com status failed e mensagem de erro redigida', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });

      await completeJob('job-abc', 'failed', 'Timeout ao acessar API Bling');

      expect(mockRpc).toHaveBeenCalledWith('concluir_job_sync', expect.objectContaining({
        p_status: 'failed',
        p_error: 'Timeout ao acessar API Bling',
      }));
    });

    it('lança erro quando RPC falha', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'RPC error' } });
      await expect(completeJob('job-abc', 'completed')).rejects.toThrow(
        'Falha ao concluir job job-abc: RPC error',
      );
    });
  });

  // -------------------------------------------------------------------------
  // getJobStatus
  // -------------------------------------------------------------------------

  describe('getJobStatus', () => {
    it('retorna dados do job quando encontrado', async () => {
      const jobData = {
        id: 'job-abc',
        organizacao_id: 'org-123',
        status: 'running',
        progress: { etapa_atual: 'clientes' },
        last_error: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:01:00Z',
        completed_at: null,
      };

      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValueOnce({ data: jobData, error: null }),
      });

      const result = await getJobStatus('job-abc', 'org-123');
      expect(result?.status).toBe('running');
    });

    it('retorna null quando job não existe', async () => {
      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValueOnce({ data: null, error: null }),
      });

      const result = await getJobStatus('nao-existe', 'org-123');
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // releaseExpiredLeases (crash recovery)
  // -------------------------------------------------------------------------

  describe('releaseExpiredLeases', () => {
    it('retorna o número de leases liberados', async () => {
      mockRpc.mockResolvedValueOnce({ data: 2, error: null });
      expect(await releaseExpiredLeases()).toBe(2);
    });

    it('retorna 0 e não lança erro quando RPC falha (não fatal)', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'connection error' } });
      // Não deve lançar — swallows gracefully
      expect(await releaseExpiredLeases()).toBe(0);
    });
  });
});
