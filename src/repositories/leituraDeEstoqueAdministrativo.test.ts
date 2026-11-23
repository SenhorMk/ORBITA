import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import { lerSaldoDoProduto } from './leituraDeEstoqueAdministrativo';

it('aplica o mesmo filtro de tenant e produto ativo à busca por SKU e nome', async () => {
  const filtros: string[][][] = [];
  const banco = { from: vi.fn(() => {
    const filtro: string[][] = [];
    filtros.push(filtro);
    const query = {
      select: () => query,
      eq: (coluna: string, valor: string) => { filtro.push([coluna, valor]); return query; },
      ilike: (coluna: string, valor: string) => { filtro.push([coluna, valor]); return query; },
      order: () => query,
      limit: () => query,
      then: (resolver: (r: unknown) => void) => resolver({ data: [], error: null }),
    };
    return query;
  }) };
  await lerSaldoDoProduto(banco as unknown as SupabaseClient,
    { organizationId: 'empresa-A' } as VerifiedOrganizationScope, 'DEMO_%');
  expect(filtros).toEqual([
    [['organizacao_id', 'empresa-A'], ['situacao', 'ativo'], ['codigo', 'DEMO_%']],
    [['organizacao_id', 'empresa-A'], ['situacao', 'ativo'], ['nome', '%DEMO\\_\\%%']],
  ]);
});
