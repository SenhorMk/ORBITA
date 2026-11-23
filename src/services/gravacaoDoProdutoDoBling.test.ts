import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';

const upsert = vi.fn(async () => ({}));
const registrarExclusaoNoBling = vi.fn(async () => 'registrado');
vi.mock('../repositories/produtoRepository', () => ({ produtoRepository: { upsert, registrarExclusaoNoBling } }));
const { gravarProdutoDoBling } = await import('./gravacaoDoProdutoDoBling');

const scope = { organizationId: '11111111-1111-4111-8111-111111111111', actorId: '33333333-3333-4333-8333-333333333333' } as VerifiedOrganizationScope;
const lido = { bling_id: '16656037809', nome: 'Kuripe Cobra', preco: 80, estoque: 1 };

describe('sincronização: gravação de um produto lido do Bling', () => {
  beforeEach(() => { upsert.mockClear(); registrarExclusaoNoBling.mockClear(); });

  it('situação E (excluído no Bling) arquiva pelo tombstone e não regrava', async () => {
    await gravarProdutoDoBling(scope, 'E', lido);
    expect(registrarExclusaoNoBling).toHaveBeenCalledWith(scope, '16656037809', null);
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each([['A', 'ativo'], ['I', 'inativo'], [undefined, undefined]] as const)('situação %s grava com situação local %s', async (noBling, local) => {
    await gravarProdutoDoBling(scope, noBling, lido);
    expect(upsert).toHaveBeenCalledWith(scope, { ...lido, situacao: local });
    expect(registrarExclusaoNoBling).not.toHaveBeenCalled();
  });
});
