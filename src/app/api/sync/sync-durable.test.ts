/**
 * sync-durable.test.ts
 * Ticket 34: Testes de integração dos endpoints de sync durável.
 * Cobre: POST retorna 202 + jobId, GET /status retorna estado correto,
 * idempotência (job existente), 401/403/400/404.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);

// ---------------------------------------------------------------------------
// Hoisted mocks e IDs
// ---------------------------------------------------------------------------

const {
  JOB_ID_NOVO,
  JOB_ID_EXISTENTE,
  ORG_ID,
  USER_ID,
  mockVerifySessionAndRole,
  mockEnqueueSync,
  mockProcessJob,
  mockGetJobStatus,
  mockAfter,
} = vi.hoisted(() => {
  const JOB_ID_NOVO = 'aaaaaaaa-0000-0000-0000-000000000001';
  const JOB_ID_EXISTENTE = 'bbbbbbbb-0000-0000-0000-000000000002';
  const ORG_ID = 'cccccccc-0000-0000-0000-000000000003';
  const USER_ID = 'dddddddd-0000-0000-0000-000000000004';

  return {
    JOB_ID_NOVO,
    JOB_ID_EXISTENTE,
    ORG_ID,
    USER_ID,
    mockVerifySessionAndRole: vi.fn(),
    mockEnqueueSync: vi.fn(),
    mockProcessJob: vi.fn(),
    mockGetJobStatus: vi.fn(),
    mockAfter: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../lib/auth', () => ({
  verifySessionAndRole: (...args: unknown[]) => mockVerifySessionAndRole(...args),
}));

vi.mock('../../../services/sync', () => ({
  syncService: {
    enqueueSync: (...args: unknown[]) => mockEnqueueSync(...args),
    processJob: (...args: unknown[]) => mockProcessJob(...args),
    getJobStatus: (...args: unknown[]) => mockGetJobStatus(...args),
  },
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (...args: unknown[]) => mockAfter(...args),
  };
});

// ---------------------------------------------------------------------------
// Importações após mocks
// ---------------------------------------------------------------------------

import { POST as syncPost } from './route';
import { GET as syncStatusGet } from './status/route';

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifySessionAndRole.mockResolvedValue({
    id: USER_ID,
    role: 'dono',
    tenant: { id: USER_ID, organizacao_id: ORG_ID },
  });
  mockEnqueueSync.mockResolvedValue({
    jobId: JOB_ID_NOVO,
    status: 'queued',
    isNew: true,
  });
  mockProcessJob.mockResolvedValue(undefined);
  mockGetJobStatus.mockResolvedValue({
    id: JOB_ID_NOVO,
    organizacao_id: ORG_ID,
    status: 'running',
    progress: { etapa_atual: 'clientes', clientes_processados: 42 },
    last_error: null,
    created_at: '2026-08-20T18:00:00Z',
    updated_at: '2026-08-20T18:01:00Z',
    completed_at: null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/sync
// ---------------------------------------------------------------------------

describe('POST /api/sync — Jobs duráveis', () => {
  it('retorna 202 com jobId e status queued para novo job', async () => {
    mockEnqueueSync.mockResolvedValueOnce({
      jobId: JOB_ID_NOVO,
      status: 'queued',
      isNew: true,
    });

    const req = new NextRequest('http://localhost/api/sync', { method: 'POST' });
    const res = await syncPost(req);

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.jobId).toBe(JOB_ID_NOVO);
    expect(body.status).toBe('queued');
    expect(mockAfter).toHaveBeenCalledTimes(1);
  });

  it('retorna 202 com job existente quando já há job ativo (idempotência)', async () => {
    mockEnqueueSync.mockResolvedValueOnce({
      jobId: JOB_ID_EXISTENTE,
      status: 'running',
      isNew: false,
    });

    const req = new NextRequest('http://localhost/api/sync', { method: 'POST' });
    const res = await syncPost(req);

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.jobId).toBe(JOB_ID_EXISTENTE);
    expect(body.status).toBe('running');
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it('retorna 401 para requisição não autenticada', async () => {
    mockVerifySessionAndRole.mockResolvedValueOnce(null);

    const req = new NextRequest('http://localhost/api/sync', { method: 'POST' });
    const res = await syncPost(req);
    expect(res.status).toBe(401);
  });

  it('retorna 403 para usuário sem papel dono', async () => {
    mockVerifySessionAndRole.mockResolvedValueOnce({
      id: USER_ID,
      role: 'membro',
      tenant: { id: USER_ID, organizacao_id: ORG_ID },
    });

    const req = new NextRequest('http://localhost/api/sync', { method: 'POST' });
    const res = await syncPost(req);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /api/sync/status
// ---------------------------------------------------------------------------

describe('GET /api/sync/status — Estado observável', () => {
  it('retorna o estado do job quando job_id é válido', async () => {
    const jobData = {
      id: JOB_ID_NOVO,
      organizacao_id: ORG_ID,
      status: 'running',
      progress: { etapa_atual: 'produtos', produtos_processados: 80 },
      last_error: null,
      created_at: '2026-08-20T18:00:00Z',
      updated_at: '2026-08-20T18:02:00Z',
      completed_at: null,
    };
    mockGetJobStatus.mockResolvedValueOnce(jobData);

    const req = new NextRequest(`http://localhost/api/sync/status?job_id=${JOB_ID_NOVO}`);
    const res = await syncStatusGet(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.job.status).toBe('running');
    expect(body.job.progress.etapa_atual).toBe('produtos');
  });

  it('retorna 404 quando job não existe ou não pertence à organização', async () => {
    mockGetJobStatus.mockResolvedValueOnce(null);

    const req = new NextRequest(`http://localhost/api/sync/status?job_id=nao-existe`);
    const res = await syncStatusGet(req);
    expect(res.status).toBe(404);
  });

  it('retorna 400 quando job_id não é fornecido', async () => {
    const req = new NextRequest('http://localhost/api/sync/status');
    const res = await syncStatusGet(req);
    expect(res.status).toBe(400);
  });

  it('retorna 401 para requisição não autenticada', async () => {
    mockVerifySessionAndRole.mockResolvedValueOnce(null);

    const req = new NextRequest(`http://localhost/api/sync/status?job_id=${JOB_ID_NOVO}`);
    const res = await syncStatusGet(req);
    expect(res.status).toBe(401);
  });

  it('retorna estado completed quando job foi concluído com sucesso', async () => {
    const jobData = {
      id: JOB_ID_NOVO,
      organizacao_id: ORG_ID,
      status: 'completed',
      progress: {
        etapa_atual: 'concluido',
        clientes_processados: 100,
        produtos_processados: 200,
        pedidos_processados: 50,
      },
      last_error: null,
      created_at: '2026-08-20T18:00:00Z',
      updated_at: '2026-08-20T18:05:00Z',
      completed_at: '2026-08-20T18:05:00Z',
    };
    mockGetJobStatus.mockResolvedValueOnce(jobData);

    const req = new NextRequest(`http://localhost/api/sync/status?job_id=${JOB_ID_NOVO}`);
    const res = await syncStatusGet(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job.status).toBe('completed');
    expect(body.job.completed_at).toBeTruthy();
  });
});
