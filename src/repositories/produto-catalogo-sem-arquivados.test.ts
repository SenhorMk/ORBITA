import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';

/**
 * O catálogo da tela não lista produto arquivado.
 *
 * Antes, `POST /api/produtos/arquivar` arquivava o produto, mas `getAll`
 * devolvia todas as linhas da organização e a lista de Estoque & Produtos
 * continuava mostrando o produto: para quem usava, a remoção "não funcionava".
 *
 * O Supabase falso é uma tabela em memória que aplica de verdade `eq`, `neq` e
 * `order`, então o teste prova quais linhas voltam, não só quais filtros
 * foram chamados.
 */

type Linha = Record<string, unknown>;
let linhas: Linha[] = [];

function construtor() {
  const filtros: Array<(l: Linha) => boolean> = [];
  let ordem: string | null = null;
  const executar = () => {
    const resultado = linhas.filter((l) => filtros.every((f) => f(l)));
    if (ordem) {
      const coluna = ordem;
      resultado.sort((a, b) => String(a[coluna]).localeCompare(String(b[coluna])));
    }
    return { data: resultado.map((l) => ({ ...l })), error: null };
  };
  const consulta = {
    select: () => consulta,
    eq: (coluna: string, valor: unknown) => { filtros.push((l) => l[coluna] === valor); return consulta; },
    neq: (coluna: string, valor: unknown) => { filtros.push((l) => l[coluna] !== valor); return consulta; },
    order: (coluna: string) => { ordem = coluna; return consulta; },
    then: (ok: (v: unknown) => unknown, falha: (e: unknown) => unknown) => Promise.resolve(executar()).then(ok, falha),
  };
  return consulta;
}

vi.mock('../lib/supabaseServer', () => ({
  supabaseServer: { from: () => construtor() },
}));

const { produtoRepository } = await import('./produtoRepository');

const ORG = '11111111-1111-4111-8111-111111111111';
const OUTRA_ORG = '22222222-2222-4222-8222-222222222222';
const scope = { organizationId: ORG, actorId: '33333333-3333-4333-8333-333333333333' } as unknown as VerifiedOrganizationScope;

function produto(id: string, nome: string, situacao: string, organizacao_id = ORG): Linha {
  return { id, nome, situacao, organizacao_id, bling_id: `LOCAL-${id.length}`, preco: 10, estoque: 1 };
}

describe('produtoRepository.getAll — catálogo da tela', () => {
  beforeEach(() => {
    linhas = [
      produto('p-ativo', 'Bermuda', 'ativo'),
      produto('p-inativo', 'Camiseta', 'inativo'),
      produto('p-arquivado', 'Produto DEMO', 'arquivado'),
      produto('p-outra-org', 'Alheio', 'ativo', OUTRA_ORG),
    ];
  });

  it('não devolve produto arquivado', async () => {
    const lista = await produtoRepository.getAll(scope);
    expect(lista.map((p) => p.id)).not.toContain('p-arquivado');
  });

  it('continua devolvendo ativos e inativos da organização, em ordem de nome', async () => {
    const lista = await produtoRepository.getAll(scope);
    expect(lista.map((p) => p.id)).toEqual(['p-ativo', 'p-inativo']);
  });

  it('não mistura produtos de outra organização', async () => {
    const lista = await produtoRepository.getAll(scope);
    expect(lista.every((p) => (p as unknown as Linha).organizacao_id === ORG)).toBe(true);
  });
});

describe('produtoRepository.getArquivados — aba de arquivados', () => {
  beforeEach(() => {
    linhas = [
      produto('p-ativo', 'Bermuda', 'ativo'),
      produto('p-arquivado', 'Produto DEMO', 'arquivado'),
      produto('p-arquivado-outra', 'Arquivado de outra org', 'arquivado', OUTRA_ORG),
    ];
  });

  it('devolve só os arquivados da organização do escopo', async () => {
    const arquivados = await produtoRepository.getArquivados(scope);
    expect(arquivados.map((p) => p.id)).toEqual(['p-arquivado']);
  });
});
