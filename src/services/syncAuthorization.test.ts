import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockVerifyScope,
  mockAcquireLease,
  mockReleaseExpiredLeases,
  mockEnqueueJob,
} = vi.hoisted(() => ({
  mockVerifyScope: vi.fn(),
  mockAcquireLease: vi.fn(),
  mockReleaseExpiredLeases: vi.fn(),
  mockEnqueueJob: vi.fn(),
}));

vi.mock('../lib/verifiedOrganizationScope', () => ({
  verifyOrganizationScope: (...args: unknown[]) => mockVerifyScope(...args),
}));

vi.mock('../repositories/syncJobRepository', () => ({
  enqueueJob: (...args: unknown[]) => mockEnqueueJob(...args),
  acquireLease: (...args: unknown[]) => mockAcquireLease(...args),
  advanceCheckpoint: vi.fn(),
  completeJob: vi.fn(),
  getJobStatus: vi.fn(),
  releaseExpiredLeases: (...args: unknown[]) => mockReleaseExpiredLeases(...args),
}));

vi.mock('../lib/supabaseServer', () => ({ supabaseServer: {} }));

import { SyncService } from './sync';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';

const ESCOPO = {
  organizationId: '10000000-0000-4000-8000-000000000001',
  actorId: '10000000-0000-4000-8000-000000000002',
  role: 'owner',
} as VerifiedOrganizationScope;

/**
 * Ticket 22 — este arquivo testava que o serviço, ao resolver o escopo sozinho
 * e receber "depósito indisponível", encerrava antes de tocar nas leases.
 *
 * Essa garantia **não sumiu: mudou de lugar.** A autorização passou a acontecer
 * uma vez só, na fronteira HTTP, que responde 503 e nunca chega a chamar
 * `enqueueSync`/`processJob` — provado em
 * `src/app/api/sync/sync-durable.test.ts`. Em `POST /api/sync` isso vale
 * inclusive para o processamento em segundo plano, porque o escopo é resolvido
 * antes da resposta, e o `after()` só é agendado depois disso.
 *
 * O que sobra para provar aqui é o outro lado do mesmo contrato: o serviço
 * **não** autoriza de novo. Uma segunda autorização dentro dele seria uma
 * segunda resposta para a mesma pergunta — foi assim que o modelo antigo
 * sobreviveu tanto tempo.
 */
describe('SyncService authorization boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAcquireLease.mockResolvedValue(false);
    mockEnqueueJob.mockResolvedValue({ jobId: 'job-1', status: 'queued', isNew: true });
  });

  it('não reautoriza: usa o escopo verificado que recebeu', async () => {
    const service = new SyncService();

    await service.enqueueSync(ESCOPO);
    await service.processJob('job-1', ESCOPO);

    expect(mockVerifyScope).not.toHaveBeenCalled();
    expect(mockEnqueueJob).toHaveBeenCalledWith(ESCOPO);
  });

  it('trabalha sempre contra o escopo recebido, e não contra um id primitivo', async () => {
    const service = new SyncService();

    await service.processJob('job-1', ESCOPO);

    expect(mockReleaseExpiredLeases).toHaveBeenCalledTimes(1);
    expect(mockAcquireLease).toHaveBeenCalledWith(ESCOPO, 'job-1');
  });

  it('para quando a lease não é adquirida, sem seguir para as etapas', async () => {
    mockAcquireLease.mockResolvedValue(false);
    const service = new SyncService();

    await expect(service.processJob('job-1', ESCOPO)).resolves.toBeUndefined();
  });
});
