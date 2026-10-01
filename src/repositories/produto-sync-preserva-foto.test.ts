import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';

/**
 * A sincronização e o webhook do Bling gravam produtos por
 * `produtoRepository.upsert`. Eles podem mudar `imagem_url` (o espelho do
 * Bling) à vontade — e nunca a foto escolhida no ORBITA.
 *
 * O Supabase falso grava cada payload enviado a `update`/`upsert`; o teste
 * confere o que sairia para o banco.
 */

const payloads: Array<{ metodo: 'update' | 'upsert'; valores: Record<string, unknown> }> = [];
let atualizacaoEncontraLinha = true;

function construtor() {
  const alvo: Record<string, unknown> = {};
  const proxy: Record<string, unknown> = new Proxy(alvo, {
    get(_obj, prop: string) {
      if (prop === 'update' || prop === 'upsert') {
        return (valores: Record<string, unknown>) => { payloads.push({ metodo: prop, valores }); return proxy; };
      }
      if (prop === 'single') {
        return async () => {
          const ultimo = payloads.at(-1);
          if (ultimo?.metodo === 'update' && !atualizacaoEncontraLinha) return { data: null, error: { code: 'PGRST116' } };
          return { data: { id: 'p', ...ultimo?.valores }, error: null };
        };
      }
      if (prop === 'maybeSingle') return async () => ({ data: null, error: null });
      return () => proxy;
    },
  });
  return proxy;
}

vi.mock('../lib/supabaseServer', () => ({ supabaseServer: { from: () => construtor() } }));

const ORG = '11111111-1111-4111-8111-111111111111';
/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scope = { organizationId: ORG, actorId: ORG, role: 'owner' } as unknown as VerifiedOrganizationScope;
const FOTO = `${ORG}/33333333-3333-4333-8333-333333333333/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png`;

beforeEach(() => {
  payloads.length = 0;
  atualizacaoEncontraLinha = true;
});

describe('sincronização Bling → ORBITA preserva a foto do ORBITA', () => {
  it('produto novo do Bling: grava a imagem do Bling e não envia imagem_storage_path', async () => {
    const { produtoRepository } = await import('./produtoRepository');
    await produtoRepository.upsert(scope, {
      bling_id: '77', nome: 'X', preco: 1, estoque: 1,
      imagem_url: 'https://bling/nova.jpg',
      imagem_storage_path: FOTO,
    });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.valores.imagem_url).toBe('https://bling/nova.jpg');
    expect(payloads[0]!.valores).not.toHaveProperty('imagem_storage_path');
  });

  it('produto existente (update, e o upsert de reserva): nenhum dos dois caminhos leva o campo', async () => {
    const { produtoRepository } = await import('./produtoRepository');
    atualizacaoEncontraLinha = false;
    await produtoRepository.upsert(scope, {
      id: '33333333-3333-4333-8333-333333333333', bling_id: '77', nome: 'X', preco: 1, estoque: 1,
      imagem_url: 'https://bling/trocada.jpg',
      imagem_storage_path: null,
    });
    expect(payloads.map((p) => p.metodo)).toEqual(['update', 'upsert']);
    for (const { valores } of payloads) {
      expect(valores.imagem_url).toBe('https://bling/trocada.jpg');
      expect(valores).not.toHaveProperty('imagem_storage_path');
    }
  });

  it('nenhum caminho de sincronização monta imagem_storage_path', () => {
    const raiz = path.resolve(__dirname, '..');
    for (const arquivo of ['services/sync.ts', 'app/api/bling/webhook/route.ts']) {
      expect(readFileSync(path.join(raiz, arquivo), 'utf8'), arquivo).not.toContain('imagem_storage_path');
    }
  });
});
