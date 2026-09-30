import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';

/**
 * Todo caminho que remove uma linha de `produtos` e o que ele faz com a foto
 * do ORBITA (`imagem_storage_path`).
 *
 * O Supabase falso grava cada cadeia de chamadas por `from(...)` e responde o
 * que o teste prepara.
 */

type Cadeia = Array<[string, ...unknown[]]>;
const cadeias: Cadeia[] = [];
let linhaDuplicada: Record<string, unknown> | null = null;
let linhasExcluidas: Array<Record<string, unknown>> = [];

function construtor() {
  const cadeia: Cadeia = [];
  cadeias.push(cadeia);
  const resposta = () => {
    const primeiro = cadeia[0]?.[0];
    if (primeiro === 'delete') return { data: linhasExcluidas, error: null };
    if (primeiro === 'update') return { data: null, error: { code: '23505' } };
    return { data: { id: 'salvo' }, error: null };
  };
  const proxy: Record<string, unknown> = new Proxy({}, {
    get(_obj, prop: string) {
      if (prop === 'then') {
        return (ok: (v: unknown) => unknown, falha: (e: unknown) => unknown) => Promise.resolve(resposta()).then(ok, falha);
      }
      if (prop === 'maybeSingle') return async () => ({ data: linhaDuplicada, error: null });
      if (prop === 'single') return async () => resposta();
      return (...args: unknown[]) => { cadeia.push([prop, ...args]); return proxy; };
    },
  });
  return proxy;
}

vi.mock('../lib/supabaseServer', () => ({ supabaseServer: { from: () => construtor() } }));

const ORG = '11111111-1111-4111-8111-111111111111';
/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scope = { organizationId: ORG, actorId: ORG, role: 'owner' } as unknown as VerifiedOrganizationScope;
const EDITADO = '33333333-3333-4333-8333-333333333333';
const DUPLICADO = '44444444-4444-4444-8444-444444444444';
const FOTO_DO_DUPLICADO = `${ORG}/${DUPLICADO}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`;

const excluiu = () => cadeias.some((c) => c[0]?.[0] === 'delete');

beforeEach(() => {
  cadeias.length = 0;
  linhaDuplicada = null;
  linhasExcluidas = [];
});

describe('ProdutoRepository.delete', () => {
  it('exclui por id + organização e devolve o caminho da foto que a PRÓPRIA linha tinha (RETURNING)', async () => {
    const { produtoRepository } = await import('./produtoRepository');
    linhasExcluidas = [{ imagem_storage_path: FOTO_DO_DUPLICADO }];
    expect(await produtoRepository.delete(scope, DUPLICADO)).toBe(FOTO_DO_DUPLICADO);
    expect(cadeias[0]).toEqual([
      ['delete'], ['eq', 'id', DUPLICADO], ['eq', 'organizacao_id', ORG], ['select', 'imagem_storage_path'],
    ]);
  });

  it('sem foto, ou nenhuma linha excluída: null', async () => {
    const { produtoRepository } = await import('./produtoRepository');
    linhasExcluidas = [{ imagem_storage_path: null }];
    expect(await produtoRepository.delete(scope, DUPLICADO)).toBeNull();
    linhasExcluidas = [];
    expect(await produtoRepository.delete(scope, DUPLICADO)).toBeNull();
  });
});

describe('deduplicação por bling_id em ProdutoRepository.upsert', () => {
  const salvarEditado = async () => {
    const { produtoRepository } = await import('./produtoRepository');
    await produtoRepository.upsert(scope, { id: EDITADO, bling_id: '77', nome: 'X', preco: 1, estoque: 1 });
  };

  it('duplicado COM foto do ORBITA não é excluído: a foto não some nem vira órfã', async () => {
    linhaDuplicada = { id: DUPLICADO, imagem_storage_path: FOTO_DO_DUPLICADO };
    await salvarEditado();
    expect(excluiu()).toBe(false);
    // Segue pelo caminho já existente: o update esbarra no único e o upsert por
    // conflito grava na linha que tem a foto — sem mencionar a foto.
    expect(cadeias.map((c) => c[0]?.[0])).toEqual(['select', 'update', 'upsert']);
    const upsert = cadeias.find((c) => c[0]?.[0] === 'upsert')!;
    expect(upsert[0]![1]).not.toHaveProperty('imagem_storage_path');
  });

  it('duplicado SEM foto continua sendo excluído, como antes', async () => {
    linhaDuplicada = { id: DUPLICADO, imagem_storage_path: null };
    await salvarEditado();
    expect(excluiu()).toBe(true);
  });

  it('a leitura do duplicado traz o caminho da foto para decidir', async () => {
    linhaDuplicada = null;
    await salvarEditado();
    expect(cadeias[0]).toContainEqual(['select', 'id, imagem_storage_path']);
  });
});

describe('todos os caminhos de exclusão de produto estão tratados', () => {
  const RAIZ = path.resolve(__dirname, '..');
  function fontes(dir: string): string[] {
    return readdirSync(dir).flatMap((nome) => {
      const completo = path.join(dir, nome);
      if (statSync(completo).isDirectory()) return fontes(completo);
      return /\.tsx?$/u.test(nome) && !/\.test\.tsx?$/u.test(nome) ? [completo] : [];
    });
  }
  const relativo = (f: string) => path.relative(RAIZ, f).replaceAll('\\', '/');

  it('só a rota de exclusão e a deduplicação chamam ProdutoRepository.delete', () => {
    const chamadores = fontes(RAIZ)
      .filter((f) => /produtoRepository\.delete\(|this\.delete\(/u.test(readFileSync(f, 'utf8')))
      .map(relativo)
      .sort();
    expect(chamadores).toEqual(['app/api/produtos/delete/route.ts', 'repositories/produtoRepository.ts']);
  });

  it('a rota de exclusão passa pela orquestração que limpa a foto depois da linha', () => {
    const rota = readFileSync(path.join(RAIZ, 'app/api/produtos/delete/route.ts'), 'utf8');
    expect(rota).toContain('await excluirProdutoComFoto(scope, id, {');
    expect(rota).toMatch(/excluirLinha: \(escopo, produtoId\) => produtoRepository\.delete\(escopo, produtoId\)/u);
    expect(rota.match(/produtoRepository\.delete\(/gu)).toHaveLength(1);
  });

  it('nenhum outro código de aplicação exclui de produtos diretamente', () => {
    const diretos = fontes(RAIZ)
      .filter((f) => /from\('produtos'\)[\s\S]{0,120}?\.delete\(/u.test(readFileSync(f, 'utf8')))
      .map(relativo);
    expect(diretos).toEqual(['repositories/produtoRepository.ts']);
  });
});
