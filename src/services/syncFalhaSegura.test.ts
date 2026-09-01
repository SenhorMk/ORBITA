import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockEnqueueJob,
  mockAcquireLease,
  mockReleaseExpiredLeases,
  mockCompleteJob,
  mockGetJobStatus,
  mockAdvanceCheckpoint,
} = vi.hoisted(() => ({
  mockEnqueueJob: vi.fn(),
  mockAcquireLease: vi.fn(),
  mockReleaseExpiredLeases: vi.fn(),
  mockCompleteJob: vi.fn(),
  mockGetJobStatus: vi.fn(),
  mockAdvanceCheckpoint: vi.fn(),
}));

vi.mock('../repositories/syncJobRepository', () => ({
  enqueueJob: (...args: unknown[]) => mockEnqueueJob(...args),
  acquireLease: (...args: unknown[]) => mockAcquireLease(...args),
  advanceCheckpoint: (...args: unknown[]) => mockAdvanceCheckpoint(...args),
  completeJob: (...args: unknown[]) => mockCompleteJob(...args),
  getJobStatus: (...args: unknown[]) => mockGetJobStatus(...args),
  releaseExpiredLeases: (...args: unknown[]) => mockReleaseExpiredLeases(...args),
}));

vi.mock('../lib/supabaseServer', () => ({ supabaseServer: {} }));
const { mockGetClientes } = vi.hoisted(() => ({ mockGetClientes: vi.fn() }));

vi.mock('./bling', () => ({
  bling: { forVerifiedOrganization: () => ({ getClientes: mockGetClientes }) },
  extractBlingImageUrl: () => null,
}));

import { SyncService, FALHA_PUBLICA_DE_SINCRONIZACAO } from './sync';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';

const ESCOPO = {
  organizationId: '10000000-0000-4000-8000-000000000001',
  actorId: '10000000-0000-4000-8000-000000000002',
  role: 'owner',
} as VerifiedOrganizationScope;

/** Um erro do PostgREST como ele chega de verdade: com valor de linha dentro. */
function erroDoPostgrestComDadoDeCliente(): Error {
  return Object.assign(
    new Error('duplicate key value violates unique constraint "clientes_email_key"'),
    {
      code: '23505',
      details: 'Key (email)=(alguem@empresa.com) already exists.',
      hint: 'Verifique o cliente alguem@empresa.com',
    },
  );
}

describe('SyncService — falha segura', () => {
  let saidaDoLog: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    saidaDoLog = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      saidaDoLog.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
    mockReleaseExpiredLeases.mockResolvedValue(0);
    mockAcquireLease.mockResolvedValue(true);
    mockCompleteJob.mockResolvedValue(undefined);
  });

  // `sync_jobs.last_error` sai pela resposta de `GET /api/sync/status`. Antes
  // guardava `descreverErro(err)` com uma redação que só cobria `Bearer …` e
  // `key=…` — nome de constraint, `details`, `hint` e valor de linha passavam.
  // O caminho reproduzido é o real: a etapa embrulha o erro do PostgREST com
  // `descreverErro`, que junta `message`, `details` e `hint` num texto só, e era
  // esse texto que ia parar no campo — e de lá para a resposta HTTP.
  it('não persiste diagnóstico interno em last_error (CWE-209)', async () => {
    mockGetClientes.mockRejectedValue(erroDoPostgrestComDadoDeCliente());
    const service = new SyncService();

    await service.processJob('job-1', ESCOPO);

    expect(mockCompleteJob).toHaveBeenCalledWith(ESCOPO, 'job-1', 'failed', FALHA_PUBLICA_DE_SINCRONIZACAO);
    const persistido = JSON.stringify(mockCompleteJob.mock.calls);
    expect(persistido).not.toContain('alguem@empresa.com');
    expect(persistido).not.toContain('clientes_email_key');
    expect(persistido).not.toContain('Key (email)');
    expect(persistido).not.toContain('23505');
  });

  it('também não deixa o valor de linha entrar no log do servidor', async () => {
    mockGetClientes.mockRejectedValue(erroDoPostgrestComDadoDeCliente());
    const service = new SyncService();

    await service.processJob('job-1', ESCOPO);

    const linha = saidaDoLog.join('\n');
    expect(linha).not.toContain('alguem@empresa.com');
    expect(linha).not.toContain('clientes_email_key');
    // O que fica é o que serve para achar a falha sem carregar dado de cliente:
    // qual operação, em qual organização, por qual ator.
    expect(linha).toContain('sync.processar');
    expect(linha).toContain(ESCOPO.organizationId);
  });

  // O SQLSTATE se perde antes de chegar ao log porque a etapa achata o erro
  // tipado num texto (`Etapa clientes falhou: …`). É perda de diagnóstico, não
  // de segurança: recuperá-la exige propagar o erro tipado em vez de embrulhá-lo,
  // o que muda o contrato das etapas e não cabe nesta fatia.
  it('registra a classe do erro, ainda que o SQLSTATE se perca no embrulho da etapa', async () => {
    mockGetClientes.mockRejectedValue(erroDoPostgrestComDadoDeCliente());

    await new SyncService().processJob('job-1', ESCOPO);

    const linha = saidaDoLog.join('\n');
    expect(linha).toContain('"erro":"Error"');
    expect(linha).not.toContain('23505');
  });

  // `processJob` roda dentro de `after()`, depois do 202 já ter saído: uma
  // rejeição aqui vira promise não observada e o job fica `queued` para sempre.
  it('não rejeita quando `acquireLease` lança', async () => {
    mockAcquireLease.mockRejectedValue(new Error('Falha ao adquirir lease do job job-1: timeout'));
    const service = new SyncService();

    await expect(service.processJob('job-1', ESCOPO)).resolves.toEqual({ _tag: 'PreparationFailed' });
  });

  // Uma rejeição de `acquireLease` é resultado **ambíguo**: a RPC pode ter
  // concedido a lease e a resposta ter se perdido, e pode haver outra callback
  // processando o mesmo job agora. `concluir_job_sync` atualiza
  // incondicionalmente por id e limpa a lease — encerrar aqui derrubaria o job
  // que a outra execução está tocando e abriria caminho para concorrência.
  it('não encerra o job quando a aquisição da lease é ambígua, mesmo com outro processo rodando', async () => {
    mockGetJobStatus.mockResolvedValue({
      status: 'running',
      progress: { clientes_processados: 12, produtos_processados: 0, pedidos_processados: 0 },
    });
    mockAcquireLease.mockRejectedValue(new Error('Falha ao adquirir lease do job job-1: timeout'));
    const service = new SyncService();

    // O resultado da tentativa é explícito: nada foi executado. Sem isso, quem
    // chama confundiria "ninguém conseguiu começar" com "alguém está tocando".
    await expect(service.processJob('job-1', ESCOPO)).resolves.toEqual({ _tag: 'PreparationFailed' });

    expect(mockCompleteJob).not.toHaveBeenCalled();
    // A falha fica registrada; quem decide o destino do job é o TTL da lease.
    expect(saidaDoLog.join('\n')).toContain('sync.preparar');
  });

  it('não rejeita quando `releaseExpiredLeases` lança', async () => {
    mockReleaseExpiredLeases.mockRejectedValue(new Error('rpc indisponível'));
    const service = new SyncService();

    await expect(service.processJob('job-1', ESCOPO)).resolves.toEqual({ _tag: 'PreparationFailed' });
    expect(mockAcquireLease).not.toHaveBeenCalled();
  });

  // Se marcar como falho também falhar, não há mais nada a fazer — mas ainda
  // assim não se pode rejeitar, pelo mesmo motivo.
  it('não rejeita quando até a conclusão do job falha', async () => {
    mockGetClientes.mockRejectedValue(new Error('etapa quebrou'));
    mockCompleteJob.mockRejectedValue(new Error('banco fora do ar'));
    const service = new SyncService();

    await expect(service.processJob('job-1', ESCOPO)).resolves.toEqual({ _tag: 'JobFinished' });
    expect(saidaDoLog.join('\n')).toContain('sync.concluir_apos_falha');
  });

  it('não marca falho o job cuja lease pertence a outro processo', async () => {
    mockAcquireLease.mockResolvedValue(false);
    const service = new SyncService();

    await service.processJob('job-1', ESCOPO);

    expect(mockCompleteJob).not.toHaveBeenCalled();
  });
});

describe('SyncService.syncAll — o chamador distingue falha de "já rodando"', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockReleaseExpiredLeases.mockResolvedValue(0);
    mockEnqueueJob.mockResolvedValue({ jobId: 'job-1', status: 'queued', isNew: true });
    mockCompleteJob.mockResolvedValue(undefined);
  });

  it('devolve status `failed` quando o job falhou', async () => {
    mockAcquireLease.mockResolvedValue(true);
    mockGetClientes.mockRejectedValue(new Error('etapa quebrou'));
    mockGetJobStatus.mockResolvedValue({
      status: 'failed',
      progress: { clientes_processados: 0, produtos_processados: 0, pedidos_processados: 0 },
    });

    await expect(new SyncService().syncAll(ESCOPO)).resolves.toMatchObject({
      success: false,
      status: 'failed',
    });
  });

  it('devolve status `running` quando outro processo já detinha a lease', async () => {
    mockAcquireLease.mockResolvedValue(false);
    mockGetJobStatus.mockResolvedValue({
      status: 'running',
      progress: { clientes_processados: 3, produtos_processados: 0, pedidos_processados: 0 },
    });

    await expect(new SyncService().syncAll(ESCOPO)).resolves.toMatchObject({
      success: false,
      status: 'running',
    });
  });

  it('devolve `unknown` quando o job some entre processar e consultar', async () => {
    mockAcquireLease.mockResolvedValue(false);
    mockGetJobStatus.mockResolvedValue(null);

    await expect(new SyncService().syncAll(ESCOPO)).resolves.toMatchObject({
      success: false,
      status: 'unknown',
    });
  });
});
