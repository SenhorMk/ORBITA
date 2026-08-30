import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regressão de comportamento da etapa de pedidos.
 *
 * `bling-schemas.test.ts` guarda a forma dos tipos; este teste guarda o que a
 * sincronização faz com eles. Dois defeitos ao mesmo tempo, ambos por confiar
 * num tipo que nunca foi conferido contra o schema oficial:
 *
 * 1. `situacao.valor` é `integer`, e `mapBlingStatus` fazia `.trim()` —
 *    `e.trim is not a function`, etapa de pedidos inteira no chão.
 * 2. `GET /pedidos/vendas` (lista) não devolve `itens`; eles só existem no
 *    detalhe. O código iterava `bp.itens` da listagem, que é `undefined`.
 */

const ATOR = '10000000-0000-4000-8000-000000000002';

const { fakePort, upsertPedido, addItems, getClienteByBlingId, getProdutoByBlingId } = vi.hoisted(() => ({
  fakePort: {
    getClientes: vi.fn().mockResolvedValue([]),
    getProdutos: vi.fn().mockResolvedValue([]),
    getEstoquesSaldos: vi.fn().mockResolvedValue([]),
    getPedidos: vi.fn(),
    getPedido: vi.fn(),
  },
  upsertPedido: vi.fn(),
  addItems: vi.fn().mockResolvedValue(undefined),
  getClienteByBlingId: vi.fn(),
  getProdutoByBlingId: vi.fn(),
}));

vi.mock('../lib/verifiedOrganizationScope', () => ({
  verifyOrganizationScope: vi.fn().mockResolvedValue({
    _tag: 'OrganizationScopeVerified',
    scope: {
      organizationId: '10000000-0000-4000-8000-000000000001',
      actorId: '10000000-0000-4000-8000-000000000002',
    },
  }),
}));

vi.mock('../lib/organizationContext', () => ({
  resolveTenantOrgId: vi.fn().mockResolvedValue('10000000-0000-4000-8000-000000000001'),
}));

vi.mock('../repositories/syncJobRepository', () => ({
  enqueueJob: vi.fn(),
  acquireLease: vi.fn().mockResolvedValue(true),
  advanceCheckpoint: vi.fn().mockResolvedValue(undefined),
  completeJob: vi.fn().mockResolvedValue(undefined),
  getJobStatus: vi.fn(),
  releaseExpiredLeases: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/supabaseServer', () => ({ supabaseServer: {} }));

vi.mock('./bling', () => ({
  bling: { forVerifiedOrganization: () => fakePort },
  extractBlingImageUrl: () => undefined,
}));

vi.mock('../repositories/clienteRepository', () => ({
  clienteRepository: { getByBlingId: getClienteByBlingId, upsert: vi.fn() },
}));

vi.mock('../repositories/produtoRepository', () => ({
  produtoRepository: { getByBlingId: getProdutoByBlingId, upsert: vi.fn() },
}));

vi.mock('../repositories/pedidoRepository', () => ({
  pedidoRepository: { upsert: upsertPedido, addItems },
}));

// O laço de paginação é o real; só os dois marcadores que tocam o banco saem.
vi.mock('./syncCheckpoint', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./syncCheckpoint')>()),
  getLastSyncedAt: vi.fn().mockResolvedValue(null),
  touchSyncState: vi.fn().mockResolvedValue(undefined),
}));

import { completeJob } from '../repositories/syncJobRepository';
import { SyncService } from './sync';

/** Resumo do pedido como a LISTA devolve: sem `itens`, com números. */
const RESUMO_DA_LISTA = {
  id: 77001,
  numero: 123,
  data: '2026-08-30',
  total: 149.8,
  situacao: { id: 9, valor: 1 },
  contato: { id: 55001, nome: 'Contato do Bling' },
};

/** O mesmo pedido como o DETALHE devolve: com `itens`. */
const DETALHE = {
  ...RESUMO_DA_LISTA,
  itens: [{ quantidade: 2, valor: 74.9, descricao: 'Camiseta', produto: { id: 88001 } }],
};

const CONTEXTO = { actorId: ATOR, role: 'dono', tenant: { id: ATOR } } as never;

describe('etapa de pedidos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakePort.getClientes.mockResolvedValue([]);
    fakePort.getProdutos.mockResolvedValue([]);
    fakePort.getPedidos.mockImplementation((pagina: number) =>
      Promise.resolve(pagina === 1 ? [RESUMO_DA_LISTA] : []),
    );
    fakePort.getPedido.mockResolvedValue(DETALHE);
    getClienteByBlingId.mockResolvedValue({ id: 'cliente-uuid', bling_id: '55001' });
    getProdutoByBlingId.mockResolvedValue({ id: 'produto-uuid', bling_id: '88001' });
    upsertPedido.mockResolvedValue({ id: 'pedido-uuid' });
  });

  it('conclui o job — o código numérico de situação não derruba mais a etapa', async () => {
    await new SyncService().processJob('job-1', CONTEXTO);

    expect(completeJob).toHaveBeenCalledWith(expect.anything(), 'job-1', 'completed');
  });

  it('busca o detalhe de cada pedido, porque a listagem não traz itens', async () => {
    await new SyncService().processJob('job-1', CONTEXTO);

    expect(fakePort.getPedido).toHaveBeenCalledWith('77001');
  });

  it('traduz o código 1 para Atendido, e não para Novo', async () => {
    await new SyncService().processJob('job-1', CONTEXTO);

    expect(upsertPedido).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'Atendido', bling_id: '77001', numero: '123' }),
    );
  });

  it('grava o item usando `valor`, o nome real do campo no schema oficial', async () => {
    await new SyncService().processJob('job-1', CONTEXTO);

    expect(addItems).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({ produto_id: 'produto-uuid', quantidade: 2, valor_unitario: 74.9 }),
    ]);
  });

  it('procura o cliente pelo bling_id como texto, não como número', async () => {
    await new SyncService().processJob('job-1', CONTEXTO);

    expect(getClienteByBlingId).toHaveBeenCalledWith(expect.anything(), '55001');
  });
});
