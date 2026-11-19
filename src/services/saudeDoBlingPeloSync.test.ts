import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockEnqueueJob, mockAcquireLease, mockReleaseExpiredLeases, mockCompleteJob, mockAdvanceCheckpoint } =
  vi.hoisted(() => ({
    mockEnqueueJob: vi.fn(),
    mockAcquireLease: vi.fn(),
    mockReleaseExpiredLeases: vi.fn(),
    mockCompleteJob: vi.fn(),
    mockAdvanceCheckpoint: vi.fn(),
  }));

vi.mock('../repositories/syncJobRepository', () => ({
  enqueueJob: (...args: unknown[]) => mockEnqueueJob(...args),
  acquireLease: (...args: unknown[]) => mockAcquireLease(...args),
  advanceCheckpoint: (...args: unknown[]) => mockAdvanceCheckpoint(...args),
  completeJob: (...args: unknown[]) => mockCompleteJob(...args),
  getJobStatus: vi.fn(),
  releaseExpiredLeases: (...args: unknown[]) => mockReleaseExpiredLeases(...args),
}));

// O cliente Supabase do servidor: só a consulta da conexão Bling da organização.
const { consultas, conexao } = vi.hoisted(() => ({
  consultas: [] as Array<Record<string, string>>,
  conexao: { atual: { data: { id: 'conexao-bling' } as { id: string } | null, error: null as { message: string } | null } },
}));
vi.mock('../lib/supabaseServer', () => ({
  supabaseServer: {
    from: (tabela: string) => {
      const filtros: Record<string, string> = { tabela };
      const builder = {
        select: () => builder,
        eq: (coluna: string, valor: string) => {
          filtros[coluna] = valor;
          return builder;
        },
        maybeSingle: async () => {
          consultas.push(filtros);
          return conexao.atual;
        },
      };
      return builder;
    },
  },
}));

const { mockUpdateConnectionHealth } = vi.hoisted(() => ({ mockUpdateConnectionHealth: vi.fn() }));
vi.mock('./outboxService', () => ({
  outboxService: { updateConnectionHealth: (...args: unknown[]) => mockUpdateConnectionHealth(...args) },
}));

vi.mock('./syncCheckpoint', async () => {
  const real = await vi.importActual<typeof import('./syncCheckpoint')>('./syncCheckpoint');
  return { ...real, touchSyncState: async () => {}, getLastSyncedAt: async () => null };
});

const { mockGetClientes } = vi.hoisted(() => ({ mockGetClientes: vi.fn() }));
vi.mock('./bling', () => ({
  bling: {
    forVerifiedOrganization: () => ({
      getClientes: mockGetClientes,
      getProdutos: async () => [],
      getEstoquesSaldos: async () => [],
      getPedidos: async () => [],
      getPedido: async () => null,
    }),
  },
  extractBlingImageUrl: () => null,
}));

import { SyncService } from './sync';
import { ERRO_PUBLICO_DO_SYNC_NA_SAUDE } from './saudeDoBlingPeloSync';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';

const ESCOPO = {
  organizationId: '10000000-0000-4000-8000-000000000001',
  actorId: '10000000-0000-4000-8000-000000000002',
  role: 'owner',
} as VerifiedOrganizationScope;

describe('SyncService — saúde da conexão Bling', () => {
  let saidaDoLog: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    consultas.length = 0;
    conexao.atual = { data: { id: 'conexao-bling' }, error: null };
    saidaDoLog = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      saidaDoLog.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
    mockReleaseExpiredLeases.mockResolvedValue(0);
    mockAcquireLease.mockResolvedValue(true);
    mockCompleteJob.mockResolvedValue(undefined);
    mockGetClientes.mockResolvedValue([]);
    mockUpdateConnectionHealth.mockResolvedValue(undefined);
  });

  it('um sync concluído marca a conexão Bling da própria organização como saudável', async () => {
    const desfecho = await new SyncService().processJob('job-1', ESCOPO);

    expect(desfecho).toEqual({ _tag: 'JobFinished' });
    expect(consultas).toEqual([
      { tabela: 'conexoes_integracao', organizacao_id: ESCOPO.organizationId, provedor: 'bling' },
    ]);
    expect(mockUpdateConnectionHealth).toHaveBeenCalledTimes(1);
    expect(mockUpdateConnectionHealth).toHaveBeenCalledWith(
      expect.anything(), ESCOPO, 'conexao-bling', 'healthy', undefined,
    );
  });

  it('um sync que falha grava erro com texto público, sem o diagnóstico interno', async () => {
    mockGetClientes.mockRejectedValue(new Error('permission denied for function fn_travar_bling_id_de_contato'));

    await new SyncService().processJob('job-1', ESCOPO);

    expect(mockCompleteJob).toHaveBeenCalledWith(ESCOPO, 'job-1', 'failed', expect.any(String));
    expect(mockUpdateConnectionHealth).toHaveBeenCalledWith(
      expect.anything(), ESCOPO, 'conexao-bling', 'error', ERRO_PUBLICO_DO_SYNC_NA_SAUDE,
    );
    expect(JSON.stringify(mockUpdateConnectionHealth.mock.calls)).not.toContain('fn_travar');
  });

  it('não grava saúde quando a conclusão do job não pôde ser registrada', async () => {
    mockCompleteJob.mockRejectedValue(new Error('timeout'));

    const desfecho = await new SyncService().processJob('job-1', ESCOPO);

    expect(desfecho).toEqual({ _tag: 'FinalizationFailed' });
    expect(mockUpdateConnectionHealth).not.toHaveBeenCalled();
  });

  it('organização sem conexão Bling: nada a gravar', async () => {
    conexao.atual = { data: null, error: null };

    await new SyncService().processJob('job-1', ESCOPO);

    expect(mockUpdateConnectionHealth).not.toHaveBeenCalled();
  });

  it('falha ao gravar a saúde não muda o desfecho do sync e vai só para o log', async () => {
    mockUpdateConnectionHealth.mockRejectedValue(new Error('registro fora do escopo'));

    const desfecho = await new SyncService().processJob('job-1', ESCOPO);

    expect(desfecho).toEqual({ _tag: 'JobFinished' });
    expect(mockCompleteJob).toHaveBeenCalledWith(ESCOPO, 'job-1', 'completed');
    expect(saidaDoLog.join('\n')).toContain('sync.saude_do_bling');
  });
});
