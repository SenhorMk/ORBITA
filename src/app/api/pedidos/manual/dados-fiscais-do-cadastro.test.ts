/**
 * PRE-010 — o adapter de produção lê o tipo de pessoa e o indicador de IE
 * gravados no cadastro, dentro da organização verificada, e não completa o que
 * falta. Um valor ausente ou fora do contrato vira `null`: a venda então pede a
 * escolha em vez de cadastrar o contato no Bling.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const CLIENTE_ID = '33333333-3333-4333-8333-333333333333';

const consulta = vi.hoisted(() => ({
  linha: null as Record<string, unknown> | null,
  colunas: '',
  filtros: [] as Array<[string, unknown]>,
}));

vi.mock('@/lib/supabaseServer', () => ({
  supabaseServer: {
    from: (tabela: string) => {
      if (tabela !== 'clientes') throw new Error(`tabela inesperada: ${tabela}`);
      const encadeado = {
        eq: (coluna: string, valor: unknown) => {
          consulta.filtros.push([coluna, valor]);
          return encadeado;
        },
        maybeSingle: () => Promise.resolve({ data: consulta.linha, error: null }),
      };
      return {
        select: (colunas: string) => {
          consulta.colunas = colunas;
          return encadeado;
        },
      };
    },
  },
}));

vi.mock('@/services/bling', () => ({ bling: { forVerifiedOrganization: () => ({}) } }));

const { criarManualOrderDependencies } = await import('./dependencias');

/** SAFETY: marca opaca do escopo verificado; no teste ela é entrada. */
const scope = { organizationId: ORG_ID, actorId: 'ator', role: 'owner' } as unknown as VerifiedOrganizationScope;

function linha(tipo: unknown, indicador_ie: unknown) {
  return {
    id: CLIENTE_ID, nome: 'Cliente Sintético', bling_id: null, email: null, telefone: null,
    cpf_cnpj: '11222333000181', tipo, indicador_ie, excluido_no_bling_em: null, exclusao_pendente_desde: null,
  };
}

beforeEach(() => {
  consulta.linha = null;
  consulta.colunas = '';
  consulta.filtros = [];
});

describe('findClienteById: dados fiscais do cadastro', () => {
  it('lê tipo e indicador_ie filtrando pela organização verificada', async () => {
    consulta.linha = linha('J', 2);

    const cliente = await criarManualOrderDependencies(scope).store.findClienteById(scope, CLIENTE_ID);

    expect(consulta.colunas.split(',').map((c) => c.trim())).toEqual(expect.arrayContaining(['tipo', 'indicador_ie']));
    expect(consulta.filtros).toEqual([['organizacao_id', ORG_ID], ['id', CLIENTE_ID]]);
    expect(cliente?.dadosFiscais).toEqual({ tipo: 'J', indicadorIe: 2 });
  });

  it.each([
    ['indicador ausente com CNPJ', 'J', null],
    ['tipo ausente', null, 9],
    ['os dois ausentes', null, null],
    ['indicador fora do contrato', 'J', 5],
    ['tipo fora do contrato', 'X', 1],
  ])('%s: `null`, sem completar pelo documento', async (_caso, tipo, indicador) => {
    consulta.linha = linha(tipo, indicador);

    const cliente = await criarManualOrderDependencies(scope).store.findClienteById(scope, CLIENTE_ID);

    expect(cliente?.dadosFiscais).toBeNull();
  });
});
