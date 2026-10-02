import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import type { Produto } from '../types';

/**
 * Sincronização de catálogo × espelho `imagem_url`, tri-estado. A listagem do
 * Bling confirma imagem presente, mas não prova ausência: sem imagem na
 * listagem e com imagem no local, UMA leitura de detalhe decide.
 */

const { gravados, imagensLocais, mockGetProdutos, mockGetProduto } = vi.hoisted(() => ({
  gravados: [] as Produto[],
  imagensLocais: new Map<string, string | null>(),
  mockGetProdutos: vi.fn(),
  mockGetProduto: vi.fn(),
}));

vi.mock('../repositories/syncJobRepository', () => ({
  enqueueJob: vi.fn(),
  acquireLease: async () => true,
  advanceCheckpoint: async () => undefined,
  completeJob: async () => undefined,
  getJobStatus: vi.fn(),
  releaseExpiredLeases: async () => 0,
}));
vi.mock('../lib/supabaseServer', () => ({ supabaseServer: {} }));
vi.mock('./syncCheckpoint', async () => {
  const real = await vi.importActual<typeof import('./syncCheckpoint')>('./syncCheckpoint');
  return { ...real, touchSyncState: async () => {}, getLastSyncedAt: async () => null };
});
vi.mock('../repositories/produtoRepository', () => ({
  produtoRepository: {
    imagensPorBlingId: async () => imagensLocais,
    upsert: async (_scope: unknown, produto: Produto) => { gravados.push(produto); return produto; },
  },
}));
vi.mock('./bling', async () => {
  const real = await vi.importActual<typeof import('./bling')>('./bling');
  return {
    ...real,
    bling: {
      forVerifiedOrganization: () => ({
        getClientes: async () => [],
        getProdutos: mockGetProdutos,
        getProduto: mockGetProduto,
        getEstoquesSaldos: async () => [],
        getPedidos: async () => [],
        getPedido: async () => null,
      }),
    },
  };
});

import { SyncService } from './sync';

const ESCOPO = {
  organizationId: '10000000-0000-4000-8000-000000000001',
  actorId: '10000000-0000-4000-8000-000000000002',
  role: 'owner',
} as VerifiedOrganizationScope;
const KURIPE = '16656037809';
const URL_ANTIGA = 'https://orgbling.s3.amazonaws.com/org/antiga.jpg';
const URL_NOVA = 'https://orgbling.s3.amazonaws.com/org/nova.jpg';

/** Um item da LISTAGEM `GET /produtos`, como o Bling devolve (sem bloco de mídia). */
const itemDaListagem = (imagemURL: string | null) => ({ id: Number(KURIPE), nome: 'Kuripe Cobra', codigo: 'KC', preco: 80, imagemURL });
/** O DETALHE `GET /produtos/{id}`, autoritativo sobre mídia. */
const detalhe = (internas: Array<{ link: string }>) => ({
  id: Number(KURIPE), nome: 'Kuripe Cobra', imagemURL: null, midia: { imagens: { externas: [], internas, imagensURL: [] } },
});

async function sincronizarCom(item: unknown) {
  mockGetProdutos.mockImplementation(async (pagina: number) => (pagina === 1 ? [item] : []));
  await new SyncService().processJob('job-1', ESCOPO);
  return gravados.find((p) => p.bling_id === KURIPE)!;
}

beforeEach(() => {
  gravados.length = 0;
  imagensLocais.clear();
  mockGetProdutos.mockReset();
  mockGetProduto.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('sincronização de catálogo: imagem_url tri-estado', () => {
  it('regressão Kuripe Cobra: local com URL antiga, Bling autoritativo sem imagem → imagem_url = null', async () => {
    imagensLocais.set(KURIPE, URL_ANTIGA);
    mockGetProduto.mockResolvedValue(detalhe([]));
    const gravado = await sincronizarCom(itemDaListagem(null));
    expect(mockGetProduto).toHaveBeenCalledTimes(1);
    expect(mockGetProduto).toHaveBeenCalledWith(KURIPE);
    expect(gravado.imagem_url).toBeNull();
  });

  it('remoto com imagem na listagem atualiza a URL, sem leitura extra', async () => {
    imagensLocais.set(KURIPE, URL_ANTIGA);
    const gravado = await sincronizarCom(itemDaListagem(URL_NOVA));
    expect(gravado.imagem_url).toBe(URL_NOVA);
    expect(mockGetProduto).not.toHaveBeenCalled();
  });

  it('sem imagem na listagem e sem imagem local: nada a decidir, nenhum GET extra', async () => {
    imagensLocais.set(KURIPE, null);
    const gravado = await sincronizarCom(itemDaListagem(null));
    expect(mockGetProduto).not.toHaveBeenCalled();
    expect(gravado.imagem_url).toBeUndefined();
  });

  it('leitura de detalhe que falhou: desconhecido, a URL local fica', async () => {
    imagensLocais.set(KURIPE, URL_ANTIGA);
    mockGetProduto.mockResolvedValue(null);
    const gravado = await sincronizarCom(itemDaListagem(null));
    expect(gravado.imagem_url).toBe(URL_ANTIGA);
  });

  it('leitura de detalhe que lança: desconhecido, a URL local fica e a sincronização segue', async () => {
    imagensLocais.set(KURIPE, URL_ANTIGA);
    mockGetProduto.mockRejectedValue(new Error('rede'));
    const gravado = await sincronizarCom(itemDaListagem(null));
    expect(gravado.imagem_url).toBe(URL_ANTIGA);
  });

  it('a sincronização nunca envia a foto do ORBITA, a confirmação nem o lease', async () => {
    imagensLocais.set(KURIPE, URL_ANTIGA);
    mockGetProduto.mockResolvedValue(detalhe([]));
    const gravado = await sincronizarCom(itemDaListagem(null));
    for (const campo of ['imagem_storage_path', 'imagem_bling_sync_path', 'imagem_bling_sync_lease_token', 'imagem_bling_sync_lease_expires_at']) {
      expect(gravado).not.toHaveProperty(campo);
    }
  });
});
