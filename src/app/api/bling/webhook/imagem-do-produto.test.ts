import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Produto } from '../../../../types';

/**
 * Webhook de produto × espelho `imagem_url`, tri-estado: imagem confirmada
 * grava a URL; leitura COMPLETA sem imagem grava `null`; payload incompleto
 * com o GET complementar falho mantém o valor local.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const BLING_ID = '16656037809';
const URL_ANTIGA = 'https://orgbling.s3.amazonaws.com/org/antiga.jpg';
const URL_NOVA = 'https://orgbling.s3.amazonaws.com/org/nova.jpg';

const gravados: Produto[] = [];
let local: Partial<Produto> | null;
let detalhe: unknown;
const getProduto = vi.fn(async () => detalhe);

vi.mock('./autorizacao', () => ({
  authorizeWebhookTenant: async () => ({
    _tag: 'Authorized',
    blingClient: { getProduto },
    organizationScope: { organizationId: ORG, actorId: ORG, role: 'owner' },
    conexaoId: null,
  }),
}));
vi.mock('../../../../services/blingInboxService', () => ({
  generateBlingIdempotencyKey: () => 'chave',
  blingInboxService: {
    registerEvent: async () => ({ eventoId: 'evt', isDuplicate: false, status: 'received', cachedResponse: null }),
    markProcessed: async () => undefined,
    markFailed: async () => undefined,
  },
}));
vi.mock('../../../../lib/supabaseServer', () => ({ supabaseServer: {} }));
vi.mock('../../../../repositories/produtoRepository', () => ({
  produtoRepository: {
    getByBlingId: async () => local,
    upsert: async (_scope: unknown, produto: Produto) => { gravados.push(produto); return produto; },
  },
}));

/** O detalhe do `GET /produtos/{id}`, com o bloco de mídia completo. */
const midia = (internas: Array<{ link: string }>) => ({ midia: { imagens: { externas: [], internas, imagensURL: [] } } });

async function evento(data: Record<string, unknown>) {
  const { POST } = await import('./route');
  const resposta = await POST(new NextRequest('https://orbita.test/api/bling/webhook', {
    method: 'POST',
    headers: { 'x-bling-signature-256': 'sha256=ok', 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'product.updated', data }),
  }));
  expect(resposta.status).toBe(200);
  return gravados.at(-1)!;
}

beforeEach(() => {
  gravados.length = 0;
  local = { bling_id: BLING_ID, nome: 'Kuripe Cobra', preco: 80, estoque: 1, imagem_url: URL_ANTIGA };
  detalhe = null;
  getProduto.mockClear();
});

describe('webhook de produto: imagem_url tri-estado', () => {
  it('webhook completo sem imagem zera o espelho (ausência confirmada)', async () => {
    const gravado = await evento({ id: BLING_ID, nome: 'Kuripe Cobra', preco: 80, ...midia([]) });
    expect(gravado.imagem_url).toBeNull();
    expect(getProduto).not.toHaveBeenCalled();
  });

  it('payload incompleto + GET completo sem imagem: zera o espelho', async () => {
    detalhe = { id: Number(BLING_ID), nome: 'Kuripe Cobra', preco: 80, imagemURL: null, ...midia([]) };
    const gravado = await evento({ idProduto: BLING_ID, saldoFisico: 3 });
    expect(getProduto).toHaveBeenCalledWith(BLING_ID);
    expect(gravado.imagem_url).toBeNull();
  });

  it('payload incompleto + GET falhou: o valor local fica', async () => {
    detalhe = null;
    const gravado = await evento({ idProduto: BLING_ID, saldoFisico: 3 });
    expect(gravado.imagem_url).toBe(URL_ANTIGA);
  });

  it('GET que volta sem o bloco de mídia não prova ausência: o valor local fica', async () => {
    detalhe = { id: Number(BLING_ID), nome: 'Kuripe Cobra', preco: 80 };
    const gravado = await evento({ idProduto: BLING_ID });
    expect(gravado.imagem_url).toBe(URL_ANTIGA);
  });

  it('remoto com imagem atualiza a URL', async () => {
    const gravado = await evento({ id: BLING_ID, nome: 'Kuripe Cobra', preco: 80, ...midia([{ link: URL_NOVA }]) });
    expect(gravado.imagem_url).toBe(URL_NOVA);
  });

  it('o webhook nunca envia a foto do ORBITA, a confirmação nem o lease', async () => {
    const gravado = await evento({ id: BLING_ID, nome: 'Kuripe Cobra', preco: 80, ...midia([]) });
    for (const campo of ['imagem_storage_path', 'imagem_bling_sync_path', 'imagem_bling_sync_lease_token', 'imagem_bling_sync_lease_expires_at']) {
      expect(gravado).not.toHaveProperty(campo);
    }
  });
});
