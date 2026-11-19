import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const ORG_ID = '10000000-0000-4000-8000-000000000001';
const ACTOR_ID = '10000000-0000-4000-8000-000000000002';
const PRODUTO_ID = '20000000-0000-4000-8000-000000000003';

const { escopo } = vi.hoisted(() => ({ escopo: { resolvido: true } }));
vi.mock('@/lib/requestOrganizationContext', () => ({
  resolveVerifiedOrganizationScope: vi.fn(async () =>
    escopo.resolvido
      ? { _tag: 'RequestScopeResolved' as const, scope: { organizationId: ORG_ID, actorId: ACTOR_ID, role: 'member' } }
      : { _tag: 'RequestScopeRejected' as const, response: NextResponse.json({ error: 'Não autenticado' }, { status: 401 }) },
  ),
}));

const { consulta } = vi.hoisted(() => ({
  consulta: {
    filtros: [] as Array<[string, string]>,
    tabela: '',
    limite: 0,
    resultado: { data: [] as unknown[] | null, error: null as { message: string } | null },
  },
}));
vi.mock('@/lib/supabaseServer', () => ({
  supabaseServer: {
    from: (tabela: string) => {
      consulta.tabela = tabela;
      const builder = {
        select: () => builder,
        eq: (coluna: string, valor: string) => {
          consulta.filtros.push([coluna, valor]);
          return builder;
        },
        order: () => builder,
        limit: async (n: number) => {
          consulta.limite = n;
          return consulta.resultado;
        },
      };
      return builder;
    },
  },
}));

import { GET } from './route';

function pedir(query: string): Request {
  return new Request(`https://orbita.test/api/produtos/movimentacoes${query}`);
}

describe('GET /api/produtos/movimentacoes', () => {
  beforeEach(() => {
    escopo.resolvido = true;
    consulta.filtros = [];
    consulta.tabela = '';
    consulta.limite = 0;
    consulta.resultado = { data: [], error: null };
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('sem sessão verificada responde a recusa do escopo e não consulta nada', async () => {
    escopo.resolvido = false;

    const resposta = await GET(pedir(`?produto=${PRODUTO_ID}`));

    expect(resposta.status).toBe(401);
    expect(consulta.tabela).toBe('');
  });

  it('recusa produto que não é UUID antes de consultar', async () => {
    const resposta = await GET(pedir('?produto=1%20or%201=1'));

    expect(resposta.status).toBe(400);
    expect(consulta.tabela).toBe('');
  });

  it('lê só a organização verificada e o produto pedido, com limite', async () => {
    consulta.resultado = {
      data: [{ id: 'm1', tipo: 'SAIDA', origem: 'BAIXA_ORGANIZACAO_VERIFICADA', quantidade: 2, created_at: '2026-11-19T20:00:00Z' }],
      error: null,
    };

    const resposta = await GET(pedir(`?produto=${PRODUTO_ID}`));

    expect(resposta.status).toBe(200);
    expect(consulta.tabela).toBe('movimentacao_estoque');
    expect(consulta.filtros).toEqual([
      ['organizacao_id', ORG_ID],
      ['produto_id', PRODUTO_ID],
    ]);
    expect(consulta.limite).toBe(20);
    await expect(resposta.json()).resolves.toEqual({
      success: true,
      movimentacoes: [{ id: 'm1', tipo: 'SAIDA', origem: 'BAIXA_ORGANIZACAO_VERIFICADA', quantidade: 2, created_at: '2026-11-19T20:00:00Z' }],
    });
  });

  it('falha do banco vira mensagem pública, sem o diagnóstico', async () => {
    consulta.resultado = { data: null, error: { message: 'permission denied for table movimentacao_estoque' } };

    const resposta = await GET(pedir(`?produto=${PRODUTO_ID}`));

    expect(resposta.status).toBe(500);
    expect(JSON.stringify(await resposta.json())).not.toContain('permission denied');
  });
});
