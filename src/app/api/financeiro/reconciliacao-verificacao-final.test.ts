import { describe, expect, it } from 'vitest';

import { buildDespesaRequest } from '@/lib/config/despesaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import { fakeBling, type FakeBling } from './__testkit__/blingContasPagarFake';
import { depsDeTeste, fakeStore, reconciliacaoDeTeste, type FakeStore } from './__testkit__/despesaFakes';
import { createDespesaHandler } from './despesaHandler';
import * as Reconciliacao from './reconciliacaoDaOperacao';

/**
 * Verificação final do PR #109 (HEAD `2f710be`): a conta que o Bling diz "Pago"
 * sem saldo comprovado não pode sumir da fila — o título fica aberto e a
 * divergência continua visível e recuperável, em todos os caminhos.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const CHAVE = '55555555-5555-4555-8555-555555555555';
/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scope = { organizationId: ORG, actorId: '22222222-2222-4222-8222-222222222222', role: 'owner' } as unknown as VerifiedOrganizationScope;

async function lancar(bling: FakeBling, store: FakeStore) {
  const corpo = buildDespesaRequest({
    descricao: 'Aluguel', valor: 1200, dataVencimento: '2026-10-20', chaveIdempotencia: CHAVE,
    categoriaId: '33333333-3333-4333-8333-333333333333',
  });
  await createDespesaHandler(depsDeTeste(scope, { bling, store, hoje: () => '2026-10-09' }))(
    new Request('https://orbita.test/api/financeiro', { method: 'POST', body: JSON.stringify(corpo) }),
  );
}

const reconciliar = (bling: FakeBling, store: FakeStore) =>
  Reconciliacao.reconciliarOperacao(scope, CHAVE, 'corr', reconciliacaoDeTeste(bling, store));
const pendentes = async (store: FakeStore) => {
  const lista = await store.operacoes().listarPendentes(scope);
  return lista._tag === 'Listadas' ? lista.operacoes.map((o) => [o.ref, o.tituloSituacao]) : [];
};
const conta = (bling: FakeBling) => {
  const c = bling.remotas.get('88123');
  if (!c) throw new Error('conta esperada');
  return c;
};

describe('P1 — "Pago" sem saldo comprovado continua na fila', () => {
  it.each([
    ['saldo ausente', null],
    ['saldo diferente de zero', 10],
  ])('reconciliação automática, %s: título aberto, operação visível', async (_caso, saldo) => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore();
    await lancar(bling, store);
    Object.assign(conta(bling), { situacao: 2, saldo });

    expect(await reconciliar(bling, store)).toMatchObject({ resultado: 'confirmada' });

    expect(store.salvos[0]?.situacao).toBe('aberto');
    expect(await pendentes(store)).toEqual([[CHAVE, 'aberto']]);
  });

  it('confirmação manual por declaração, conta "Pago" com saldo restante: visível', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore();
    await lancar(bling, store);
    const [t] = store.tentativas;
    if (!t) throw new Error('tentativa esperada');
    store.tentativas[0] = { ...t, numeroDocumento: null };
    Object.assign(conta(bling), { numeroDocumento: null, situacao: 2, saldo: 10 });

    await Reconciliacao.confirmarManualmente(scope, CHAVE, '88123', 'corr', reconciliacaoDeTeste(bling, store), { declaracaoDoOperador: true });

    expect(store.salvos[0]?.situacao).toBe('aberto');
    expect(await pendentes(store)).toEqual([[CHAVE, 'aberto']]);
  });

  it('reparo do título com conta "Pago" sem saldo: visível', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore({ falhasDeTitulo: 1 });
    await lancar(bling, store);
    await reconciliar(bling, store);
    Object.assign(conta(bling), { situacao: 2, saldo: null });

    await reconciliar(bling, store);

    expect(store.salvos[0]?.situacao).toBe('aberto');
    expect(await pendentes(store)).toEqual([[CHAVE, 'aberto']]);
  });

  it('recuperável: com o saldo zerado depois, a conferência marca pago, sem POST', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore();
    await lancar(bling, store);
    Object.assign(conta(bling), { situacao: 2, saldo: null });
    await reconciliar(bling, store);

    conta(bling).saldo = 0;
    await reconciliar(bling, store);

    expect(store.salvos).toHaveLength(1);
    expect(store.salvos[0]?.situacao).toBe('pago');
    expect(await pendentes(store)).toEqual([]);
    expect(bling.posts).toHaveLength(1);
    expect(bling.baixasEnviadas()).toBe(0);
  });

  it('recuperável: se o Bling volta a "Em aberto", a conferência fecha a divergência sem marcar pago', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore();
    await lancar(bling, store);
    Object.assign(conta(bling), { situacao: 2, saldo: null });
    await reconciliar(bling, store);

    Object.assign(conta(bling), { situacao: 1, saldo: 1200 });
    await reconciliar(bling, store);

    expect(store.salvos[0]?.situacao).toBe('aberto');
    expect(await pendentes(store)).toEqual([]);
  });

  it('sem evidência ainda: a conferência mantém a pendência e não marca nada', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore();
    await lancar(bling, store);
    Object.assign(conta(bling), { situacao: 2, saldo: null });
    await reconciliar(bling, store);

    expect(await reconciliar(bling, store)).toMatchObject({ resultado: 'revisao_manual', motivo: 'saldo_ausente' });
    expect(store.salvos[0]?.situacao).toBe('aberto');
    expect(await pendentes(store)).toEqual([[CHAVE, 'aberto']]);
  });
});
