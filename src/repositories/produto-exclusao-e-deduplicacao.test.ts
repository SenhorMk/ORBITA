import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';

/**
 * Todo caminho que remove uma linha de `produtos`, e o que ele faz com a foto
 * do ORBITA (`imagem_storage_path`).
 *
 * O Supabase falso é uma tabela em memória: aplica de verdade os filtros
 * `eq`/`is`, faz `DELETE ... RETURNING`, recusa o `UPDATE` que viola o único
 * `(organizacao_id, bling_id)` e resolve o `upsert` por esse conflito — então
 * os testes provam qual linha muda, e não só quais filtros existem.
 * `antesDoDelete` roda imediatamente antes de um `DELETE`: é a outra transação
 * que se intercala.
 */

type Linha = Record<string, unknown>;
type Cadeia = Array<[string, ...unknown[]]>;
const cadeias: Cadeia[] = [];
let linhas: Linha[] = [];
let antesDoDelete: (() => void) | null = null;
/** O `DELETE` responde erro de banco (ex.: FK de pedido) e não remove nada. */
let deleteFalha = false;

function construtor() {
  const cadeia: Cadeia = [];
  cadeias.push(cadeia);
  const filtrar = () => linhas.filter((l) => cadeia.every(([op, col, v]) => {
    if (op === 'eq') return l[col as string] === v;
    if (op === 'is') return (l[col as string] ?? null) === v;
    return true;
  }));
  const executar = (): { data: Linha[] | null; error: unknown } => {
    const [op, valores] = cadeia[0]!;
    if (op === 'delete') {
      antesDoDelete?.();
      antesDoDelete = null;
      if (deleteFalha) {
        return { data: null, error: { code: '23503', message: 'update or delete on table "produtos" violates foreign key constraint "itens_pedido_produto_id_fkey"' } };
      }
      const alvo = filtrar();
      linhas = linhas.filter((l) => !alvo.includes(l));
      return { data: alvo.map((l) => ({ ...l })), error: null };
    }
    if (op === 'update') {
      const novos = valores as Linha;
      const alvo = filtrar();
      const colide = linhas.some((l) => !alvo.includes(l)
        && l.organizacao_id === (novos.organizacao_id ?? alvo[0]?.organizacao_id) && l.bling_id === novos.bling_id);
      if (colide) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_produtos_org_bling"' } };
      for (const l of alvo) Object.assign(l, novos);
      return { data: alvo, error: null };
    }
    if (op === 'upsert') {
      const novos = valores as Linha;
      const existente = linhas.find((l) => l.organizacao_id === novos.organizacao_id && l.bling_id === novos.bling_id);
      if (existente) Object.assign(existente, novos);
      else linhas.push({ id: 'criado', ...novos });
      return { data: [existente ?? linhas.at(-1)!], error: null };
    }
    return { data: filtrar(), error: null };
  };
  const proxy: Record<string, unknown> = new Proxy({}, {
    get(_obj, prop: string) {
      if (prop === 'then') {
        return (ok: (v: unknown) => unknown, falha: (e: unknown) => unknown) => Promise.resolve(executar()).then(ok, falha);
      }
      if (prop === 'maybeSingle' || prop === 'single') {
        return async () => {
          const r = executar();
          return { data: r.data?.[0] ?? null, error: r.error };
        };
      }
      return (...args: unknown[]) => { cadeia.push([prop, ...args]); return proxy; };
    },
  });
  return proxy;
}

vi.mock('../lib/supabaseServer', () => ({ supabaseServer: { from: () => construtor() } }));

const ORG = '11111111-1111-4111-8111-111111111111';
/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scope = { organizationId: ORG, actorId: ORG, role: 'owner' } as unknown as VerifiedOrganizationScope;
const A = '33333333-3333-4333-8333-333333333333';
const B = '44444444-4444-4444-8444-444444444444';
const FOTO_DE_B = `${ORG}/${B}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`;

const operacoes = () => cadeias.map((c) => c[0]?.[0]);
const linha = (id: string) => linhas.find((l) => l.id === id);

beforeEach(() => {
  cadeias.length = 0;
  antesDoDelete = null;
  deleteFalha = false;
  linhas = [
    { id: A, organizacao_id: ORG, bling_id: 'LOCAL-A', nome: 'Editado', imagem_storage_path: null },
    { id: B, organizacao_id: ORG, bling_id: '77', nome: 'Espelho do Bling', imagem_storage_path: null },
  ];
});

/** A edição do formulário: A passa a apontar para o produto 77 do Bling. */
async function salvarA() {
  const { produtoRepository } = await import('./produtoRepository');
  return produtoRepository.upsert(scope, { id: A, bling_id: '77', nome: 'Editado v2', preco: 1, estoque: 1 });
}

describe('deduplicação por bling_id', () => {
  it('1. duplicado sem foto: DELETE por id + organização + imagem_storage_path IS NULL, na MESMA instrução, e A assume o bling_id', async () => {
    await salvarA();
    const exclusao = cadeias.find((c) => c[0]?.[0] === 'delete')!;
    expect(exclusao).toEqual([
      ['delete'], ['eq', 'id', B], ['eq', 'organizacao_id', ORG], ['is', 'imagem_storage_path', null], ['select', 'id'],
    ]);
    expect(linha(B)).toBeUndefined();
    expect(linha(A)).toMatchObject({ bling_id: '77', nome: 'Editado v2' });
    expect(operacoes()).not.toContain('upsert');
  });

  it('2. corrida: a foto aparece em B antes do DELETE — nada é excluído, nada vai para B, e a gravação pede reconciliação', async () => {
    antesDoDelete = () => { linha(B)!.imagem_storage_path = FOTO_DE_B; };
    const { ReconciliacaoDeProdutoNecessaria } = await import('./produtoRepository');

    await expect(salvarA()).rejects.toBeInstanceOf(ReconciliacaoDeProdutoNecessaria);

    // A primeira leitura viu `null`, o DELETE condicionado não achou a linha e
    // a releitura viu a foto.
    expect(operacoes()).toEqual(['select', 'delete', 'select']);
    expect(linha(B)).toEqual({ id: B, organizacao_id: ORG, bling_id: '77', nome: 'Espelho do Bling', imagem_storage_path: FOTO_DE_B });
    expect(linha(A)).toMatchObject({ bling_id: 'LOCAL-A', nome: 'Editado' });
  });

  it('3. duplicado que já tinha foto: nenhum DELETE, nenhum update/upsert — A continua A, B continua B', async () => {
    linha(B)!.imagem_storage_path = FOTO_DE_B;
    const { ReconciliacaoDeProdutoNecessaria } = await import('./produtoRepository');

    const falha = await salvarA().catch((erro: unknown) => erro);
    expect(falha).toBeInstanceOf(ReconciliacaoDeProdutoNecessaria);
    expect((falha as InstanceType<typeof ReconciliacaoDeProdutoNecessaria>).motivo).toBe('duplicado_com_foto');

    expect(operacoes()).toEqual(['select']);
    expect(linha(A)).toMatchObject({ id: A, bling_id: 'LOCAL-A', nome: 'Editado' });
    expect(linha(B)).toMatchObject({ id: B, bling_id: '77', nome: 'Espelho do Bling', imagem_storage_path: FOTO_DE_B });
  });

  it('4. duplicado removido por outra operação entre a leitura e o DELETE: a releitura prova a ausência e a gravação segue', async () => {
    antesDoDelete = () => { linhas = linhas.filter((l) => l.id !== B); };
    await expect(salvarA()).resolves.toMatchObject({ id: A, bling_id: '77' });
    expect(operacoes()).toEqual(['select', 'delete', 'select', 'update']);
  });

  it('zero linhas com o duplicado ainda presente e sem foto é estado inesperado: falha explícita', async () => {
    // O DELETE "perde" a linha (outra organização a assume por um instante) e
    // ela volta antes da releitura: nada explica as zero linhas.
    const original = linha(B)!;
    antesDoDelete = () => {
      original.organizacao_id = 'outra';
      queueMicrotask(() => { original.organizacao_id = ORG; });
    };
    const { ReconciliacaoDeProdutoNecessaria } = await import('./produtoRepository');
    const falha = await salvarA().catch((erro: unknown) => erro);
    expect(falha).toBeInstanceOf(ReconciliacaoDeProdutoNecessaria);
    expect((falha as InstanceType<typeof ReconciliacaoDeProdutoNecessaria>).motivo).toBe('estado_inesperado_na_deduplicacao');
    expect(linha(A)).toMatchObject({ bling_id: 'LOCAL-A' });
  });

  it('a mensagem de reconciliação é pública: sem SQL, sem código de erro, sem caminho de foto', async () => {
    linha(B)!.imagem_storage_path = FOTO_DE_B;
    const falha = await salvarA().catch((erro: unknown) => erro);
    const mensagem = (falha as Error).message;
    for (const vazamento of ['23505', 'constraint', 'imagem_storage_path', ORG, '.png', 'DELETE']) {
      expect(mensagem).not.toContain(vazamento);
    }
    expect(mensagem).toContain('reconciliados');
  });
});

describe('erro de banco no DELETE condicionado da deduplicação', () => {
  it('não segue para update/upsert: A continua A, B continua B, e a gravação termina em reconciliação', async () => {
    deleteFalha = true;
    const antesA = { ...linha(A) };
    const antesB = { ...linha(B) };
    const { ReconciliacaoDeProdutoNecessaria } = await import('./produtoRepository');

    const falha = await salvarA().catch((erro: unknown) => erro);

    expect(falha).toBeInstanceOf(ReconciliacaoDeProdutoNecessaria);
    expect((falha as InstanceType<typeof ReconciliacaoDeProdutoNecessaria>).motivo).toBe('falha_ao_remover_duplicado');
    expect(operacoes()).toEqual(['select', 'delete']);
    expect(linha(A)).toEqual(antesA);
    expect(linha(B)).toEqual(antesB);
    expect(linhas).toHaveLength(2);
  });

  it('pela rota de produto: a resposta é a de reconciliação, sem SQL, código, constraint nem caminho de foto', async () => {
    deleteFalha = true;
    const { produtoRepository } = await import('./produtoRepository');
    const { createProdutoUpdateHandler } = await import('../app/api/produtos/update/handler');
    const { buildProdutoRequest } = await import('../lib/config/produtoContract');
    const ok = { _tag: 'BlingOk' as const, value: undefined };
    const handler = createProdutoUpdateHandler({
      auth: { async authorize() { return { _tag: 'Authorized' as const, scope }; } },
      bling: {
        async buscarPorCodigo() { return { _tag: 'BlingOk' as const, value: null }; },
        async criar() { return { _tag: 'BlingOk' as const, value: { id: '77' } }; },
        async atualizar() { return ok; },
        async definirSaldo() { return ok; },
      },
      categorias: { async resolverBlingId() { return null; } },
      // A mesma tradução de `route.ts`, sobre o repositório real.
      store: {
        async upsert(escopo, p) {
          const salvo = await produtoRepository.upsert(escopo, {
            id: p.id, bling_id: p.blingId, nome: p.nome, codigo: p.codigo ?? '', preco: p.preco, estoque: p.estoque,
          });
          return {
            id: String(salvo.id), blingId: String(salvo.bling_id), nome: salvo.nome,
            codigo: salvo.codigo ?? null, preco: salvo.preco, estoque: salvo.estoque,
          };
        },
      },
    });

    const resposta = await handler(new Request('https://orbita.test/api/produtos/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildProdutoRequest({ id: A, blingId: '77', nome: 'Editado v2', preco: 1, estoque: 1 })),
    }));
    const corpo = await resposta.json() as { success: boolean; error: string };

    expect(resposta.status).toBe(500);
    expect(corpo.success).toBe(false);
    expect(corpo.error).toContain('Produto salvo no Bling (id 77), mas falhou ao gravar no ORBITA');
    expect(corpo.error).toContain('precisam ser reconciliados');
    expect(corpo.error).toContain('Sincronize o catálogo para reconciliar');
    for (const vazamento of ['23503', '23505', 'constraint', 'itens_pedido', 'foreign key', 'imagem_storage_path', '.png', ORG]) {
      expect(corpo.error).not.toContain(vazamento);
    }
    expect(linha(A)).toMatchObject({ bling_id: 'LOCAL-A', nome: 'Editado' });
    expect(linha(B)).toMatchObject({ bling_id: '77', nome: 'Espelho do Bling' });
    expect(operacoes()).not.toContain('upsert');
    expect(operacoes()).not.toContain('update');
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
  const repositorio = readFileSync(path.join(RAIZ, 'repositories/produtoRepository.ts'), 'utf8');

  it('nenhuma rota exclui produto: a ação da tela arquiva (PRE-003); só a deduplicação exclui, com condição', () => {
    const chamadores = fontes(RAIZ)
      .filter((f) => /produtoRepository\.delete\(|this\.delete\(/u.test(readFileSync(f, 'utf8')))
      .map(relativo);
    expect(chamadores).toEqual([]);
    expect(repositorio).toContain('await this.excluirDuplicadoSemFoto(scope, duplicado.id)');
  });

  it('a rota da tela arquiva pelo comando do banco e nunca exclui', () => {
    const rota = readFileSync(path.join(RAIZ, 'app/api/produtos/arquivar/route.ts'), 'utf8');
    expect(rota).toContain('produtoRepository.arquivar(scope, id)');
    expect(rota).not.toMatch(/\.delete\(/u);
  });

  it('nenhum outro código de aplicação exclui de produtos diretamente', () => {
    const diretos = fontes(RAIZ)
      .filter((f) => /from\('produtos'\)[\s\S]{0,120}?\.delete\(/u.test(readFileSync(f, 'utf8')))
      .map(relativo);
    expect(diretos).toEqual(['repositories/produtoRepository.ts']);
    // Uma exclusão no repositório: a condicional da deduplicação. Produto com
    // pedido ou movimentação, nem ela apaga (migration 75).
    expect(repositorio.match(/\.delete\(\)/gu)).toHaveLength(1);
  });
});
