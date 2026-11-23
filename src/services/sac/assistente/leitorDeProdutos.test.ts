import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { criarLeitorDeProdutos } from './leitorDeProdutos';

const ORG = 'c75eb92d-9222-49cc-ac0f-6aebaf8fa69f';

/** Dublê mínimo do PostgREST: registra a consulta e devolve o resultado dado. */
function bancoQueDevolve(resultado: { data: unknown; error: unknown }) {
  const chamadas: Record<string, unknown> = {};
  const consulta = {
    select(colunas: string) { chamadas.colunas = colunas; return consulta; },
    eq(coluna: string, valor: string) { chamadas.filtro = [coluna, valor]; return consulta; },
    limit(n: number) { chamadas.limite = n; return Promise.resolve(resultado); },
  };
  const banco = { from(tabela: string) { chamadas.tabela = tabela; return consulta; } } as unknown as SupabaseClient;
  return { banco, chamadas };
}

describe('leitor do catálogo (service role, escopo explícito)', () => {
  it('filtra pela organização, só colunas de vitrine, e normaliza a categoria', async () => {
    const { banco, chamadas } = bancoQueDevolve({ data: [
      { nome: 'Kuripe Cobra', preco: '80.00', estoque: 1, estoque_reservado: 0, situacao: 'ativo', arquivado_em: null, categoria: { descricao: 'Kuripe' } },
      { nome: 'Rapé', preco: 40, estoque: 3, estoque_reservado: 1, situacao: 'ativo', arquivado_em: null, categoria: [{ descricao: 'Rapé' }] },
      { nome: 'Sem categoria', preco: null, estoque: 0, estoque_reservado: null, situacao: 'ativo', arquivado_em: null, categoria: null },
    ], error: null });
    const linhas = await criarLeitorDeProdutos(banco).lerProdutos(ORG);
    expect(chamadas).toMatchObject({ tabela: 'produtos', filtro: ['organizacao_id', ORG], limite: 500 });
    expect(String(chamadas.colunas)).not.toMatch(/custo|fornecedor|imagem/u);
    expect(linhas.map((l) => l.categoria)).toEqual([{ descricao: 'Kuripe' }, { descricao: 'Rapé' }, null]);
  });

  it('formato inesperado ou erro do banco: catálogo indisponível, sem dado parcial', async () => {
    await expect(criarLeitorDeProdutos(bancoQueDevolve({ data: [{ nome: 1 }], error: null }).banco).lerProdutos(ORG))
      .rejects.toThrow('Catálogo indisponível.');
    await expect(criarLeitorDeProdutos(bancoQueDevolve({ data: null, error: { message: 'x' } }).banco).lerProdutos(ORG))
      .rejects.toThrow('Catálogo indisponível.');
  });
});
