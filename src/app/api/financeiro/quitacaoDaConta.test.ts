import { describe, expect, it } from 'vitest';

import { buildDespesaRequest } from '@/lib/config/despesaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import { fakeBling } from './__testkit__/blingContasPagarFake';
import { depsDeTeste, fakeStore } from './__testkit__/despesaFakes';
import { createDespesaHandler } from './despesaHandler';
import { quitar } from './quitacaoDaConta';

const ORG = '11111111-1111-4111-8111-111111111111';
const CHAVE = '55555555-5555-4555-8555-555555555555';
/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scope = { organizationId: ORG, actorId: '22222222-2222-4222-8222-222222222222', role: 'owner' } as unknown as VerifiedOrganizationScope;

const corpo = buildDespesaRequest({
  descricao: 'Aluguel', valor: 1200, dataVencimento: '2026-10-20', chaveIdempotencia: CHAVE, pago: true,
  categoriaId: '33333333-3333-4333-8333-333333333333',
});

async function contaConfirmada(baixa: 'confirma' | 'ambigua-sem-efeito' | 'sem-credencial' = 'ambigua-sem-efeito') {
  const bling = fakeBling({ baixa });
  const store = fakeStore();
  const deps = depsDeTeste(scope, { bling, store });
  // Lança sem quitar: a conta fica confirmada e a quitação é chamada à mão.
  await createDespesaHandler(deps)(new Request('https://orbita.test/api/financeiro', {
    method: 'POST', body: JSON.stringify({ ...corpo, pago: false }),
  }));
  const tentativa = store.tentativa(ORG, CHAVE);
  if (!tentativa?.blingContaId) throw new Error('conta confirmada esperada');
  return { bling, store, deps, conta: { ref: CHAVE, tentativaId: tentativa.id, blingContaId: tentativa.blingContaId } };
}

describe('quitação — uma intenção, uma baixa', () => {
  it('a intenção existe antes do POST /baixar', async () => {
    const { store, deps, conta } = await contaConfirmada('confirma');
    let noInstante: string | undefined;
    const baixarOriginal = deps.bling.baixarContaPagar;
    const bling = { ...deps.bling, async baixarContaPagar(...args: Parameters<typeof baixarOriginal>) {
      noInstante = store.baixas[0]?.estado;
      return baixarOriginal(...args);
    } };

    await quitar(scope, conta, corpo, 900, { ...deps, bling });

    expect(noInstante).toBe('em_voo');
  });

  it('segundo executor da mesma quitação (baixa ambígua): nenhum segundo POST', async () => {
    const { bling, store, deps, conta } = await contaConfirmada();

    const primeira = await quitar(scope, conta, corpo, 900, deps);
    const segunda = await quitar(scope, conta, corpo, 900, deps);

    expect(bling.baixasEnviadas()).toBe(1);
    expect(store.baixas).toHaveLength(1);
    expect(store.baixas[0]?.estado).toBe('indeterminada');
    expect(primeira.quitada).toBe(false);
    expect(segunda.avisos.join(' ')).toContain('não foi enviada nesta requisição');
  });

  it('quitação comprovadamente não enviada reabre a MESMA intenção', async () => {
    const { store, deps, conta } = await contaConfirmada('sem-credencial');
    await quitar(scope, conta, corpo, 900, deps);
    expect(store.baixas[0]).toMatchObject({ estado: 'nao_enviada', epoca: 1 });

    const bling = fakeBling({ baixa: 'confirma' });
    const resultado = await quitar(scope, conta, corpo, 900, { ...deps, bling: { ...deps.bling, baixarContaPagar: bling.baixarContaPagar } });

    expect(resultado.quitada).toBe(true);
    expect(store.baixas).toHaveLength(1);
    expect(store.baixas[0]).toMatchObject({ estado: 'confirmada', epoca: 2 });
  });

  it('conta não confirmada não tem baixa: nada é enviado', async () => {
    const { bling, deps, conta } = await contaConfirmada();

    const resultado = await quitar(scope, { ...conta, blingContaId: '999' }, corpo, 900, deps);

    expect(bling.baixasEnviadas()).toBe(0);
    expect(resultado.quitada).toBe(false);
  });
});
