import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

/**
 * O adaptador Supabase da lista de pendências: a RPC escolhe a página; as
 * leituras seguintes não podem entregar menos do que ela escolheu sem dizer.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scope = { organizationId: ORG, actorId: '22222222-2222-4222-8222-222222222222', role: 'owner' } as unknown as VerifiedOrganizationScope;

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const tentativa = (id: string, chave: string) => ({
  id, chave, estado: 'indeterminada', valor: 10, data_vencimento: '2026-10-20', data_emissao: '2026-10-09',
  contato_bling_id: null, numero_documento: null, quitacao_solicitada: false, bling_conta_id: null, titulo_id: null,
});

const estado = {
  rpc: [] as unknown[],
  tabelas: {} as Record<string, unknown[]>,
  filtros: [] as Array<{ tabela: string; coluna: string; valor: unknown }>,
};

vi.mock('@/lib/supabaseServer', () => {
  function consulta(tabela: string) {
    const builder = {
      select: () => builder,
      eq: (coluna: string, valor: unknown) => { estado.filtros.push({ tabela, coluna, valor }); return builder; },
      in: () => builder,
      order: () => builder,
      then: (resolver: (r: { data: unknown; error: null }) => unknown) => resolver({ data: estado.tabelas[tabela] ?? [], error: null }),
    };
    return builder;
  }
  return {
    supabaseServer: {
      from: (tabela: string) => consulta(tabela),
      rpc: async () => ({ data: estado.rpc, error: null }),
    },
  };
});

const { operacoesDeContaPagarStore } = await import('./operacoesDeContaPagarStore');

beforeEach(() => {
  estado.filtros = [];
  estado.rpc = [
    { tentativa_id: ID_A, chave: '00000000-0000-4000-8000-000000000002', created_at: '2026-01-01T00:00:02+00:00', total: 2 },
    { tentativa_id: ID_B, chave: '00000000-0000-4000-8000-000000000001', created_at: '2026-01-01T00:00:01+00:00', total: 2 },
  ];
  estado.tabelas = {
    tentativas_conta_pagar: [tentativa(ID_A, '00000000-0000-4000-8000-000000000002'), tentativa(ID_B, '00000000-0000-4000-8000-000000000001')],
    baixas_conta_pagar: [],
    reconciliacoes_conta_pagar: [],
  };
});

describe('operacoesDeContaPagarStore.listarPendentes', () => {
  it('entrega exatamente as operações que a RPC escolheu, na ordem dela, filtrando a organização', async () => {
    const lidas = await operacoesDeContaPagarStore.listarPendentes(scope);

    expect(lidas).toMatchObject({ _tag: 'Listadas', total: 2, proximo: null });
    if (lidas._tag === 'Listadas') expect(lidas.operacoes.map((o) => o.tentativaId)).toEqual([ID_A, ID_B]);
    expect(estado.filtros.filter((f) => f.coluna === 'organizacao_id').every((f) => f.valor === ORG)).toBe(true);
  });

  it('uma operação escolhida pela RPC some entre as leituras: falha explícita, sem lista parcial', async () => {
    estado.tabelas.tentativas_conta_pagar = [tentativa(ID_A, '00000000-0000-4000-8000-000000000002')];

    expect(await operacoesDeContaPagarStore.listarPendentes(scope)).toEqual({ _tag: 'Indisponivel' });
  });
});
