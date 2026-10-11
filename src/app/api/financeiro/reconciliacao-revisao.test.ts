import { describe, expect, it } from 'vitest';

import { buildDespesaRequest } from '@/lib/config/despesaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import { fakeBling, type FakeBling } from './__testkit__/blingContasPagarFake';
import { depsDeTeste, fakeStore, quitacaoDeTeste, reconciliacaoDeTeste, type FakeStore } from './__testkit__/despesaFakes';
import { createDespesaHandler } from './despesaHandler';
import * as Reconciliacao from './reconciliacaoDaOperacao';

/**
 * Revisão independente do PR #109 — os cinco defeitos, reproduzidos pela API de
 * reconciliação (nunca pelo reenvio do formulário). Cada recuperação acontece
 * numa NOVA chamada de reconciliação, e os contadores do Bling fake provam que
 * nenhum POST se repete.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const ATOR = '22222222-2222-4222-8222-222222222222';
const CHAVE = '55555555-5555-4555-8555-555555555555';
/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scope = { organizationId: ORG, actorId: ATOR, role: 'owner' } as unknown as VerifiedOrganizationScope;

async function lancar(bling: FakeBling, store: FakeStore, overrides: Record<string, unknown> = {}) {
  const corpo = buildDespesaRequest({
    descricao: 'Aluguel', valor: 1200, dataVencimento: '2026-10-20', chaveIdempotencia: CHAVE,
    categoriaId: '33333333-3333-4333-8333-333333333333', ...overrides,
  });
  return (await createDespesaHandler(depsDeTeste(scope, { bling, store, hoje: () => '2026-10-09' }))(
    new Request('https://orbita.test/api/financeiro', { method: 'POST', body: JSON.stringify(corpo) }),
  )).status;
}

const reconciliar = (bling: FakeBling, store: FakeStore) =>
  Reconciliacao.reconciliarOperacao(scope, CHAVE, 'corr', reconciliacaoDeTeste(bling, store));

const pendentes = async (store: FakeStore) => {
  const lista = await store.operacoes().listarPendentes(scope);
  return lista._tag === 'Listadas' ? lista.operacoes.map((o) => o.ref) : [];
};

describe('defeito 1 — criação confirmada sem título é reparada por nova conferência', () => {
  it('salvarTitulo falha depois da confirmação: a segunda conferência grava e vincula o título, sem POST', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore({ falhasDeTitulo: 1 });
    await lancar(bling, store);

    const primeira = await reconciliar(bling, store);
    expect(primeira).toMatchObject({ resultado: 'confirmada', projecaoLocal: 'pendente' });
    expect(await pendentes(store)).toEqual([CHAVE]);

    const segunda = await reconciliar(bling, store);

    expect(segunda).toMatchObject({ projecaoLocal: 'consistente' });
    expect(store.salvos).toHaveLength(1);
    expect(store.tentativa(ORG, CHAVE)?.tituloId).toBe('titulo-1');
    expect(bling.posts).toHaveLength(1);
    expect(await pendentes(store)).toEqual([]);
  });

  it('vincularTitulo devolve NaoGravado: a conferência não se declara concluída, e a seguinte vincula o MESMO título', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore({ falhasDeVinculo: 1 });
    await lancar(bling, store);

    expect(await reconciliar(bling, store)).toMatchObject({ projecaoLocal: 'pendente' });
    expect(await reconciliar(bling, store)).toMatchObject({ projecaoLocal: 'consistente' });

    expect(store.salvos).toHaveLength(1);
    expect(store.tentativa(ORG, CHAVE)?.tituloId).toBe('titulo-1');
    expect(bling.posts).toHaveLength(1);
  });
});

describe('defeito 2 — baixa confirmada com título ainda aberto', () => {
  it('marcarTituloPago falha: a conferência seguinte marca o título pago, sem nova baixa', async () => {
    const bling = fakeBling({ baixa: 'perde-ack' });
    const store = fakeStore({ falhasDeTituloPago: 1 });
    await lancar(bling, store, { pago: true });

    expect(await reconciliar(bling, store)).toMatchObject({ resultado: 'confirmada', projecaoLocal: 'pendente' });
    expect(store.salvos[0]?.situacao).toBe('aberto');
    expect(await pendentes(store)).toEqual([CHAVE]);

    expect(await reconciliar(bling, store)).toMatchObject({ projecaoLocal: 'consistente' });

    expect(store.salvos[0]?.situacao).toBe('pago');
    expect(bling.baixasEnviadas()).toBe(1);
    expect(await pendentes(store)).toEqual([]);
  });
});

describe('defeito 3 — "pago: true" sobrevive ao ACK perdido da criação', () => {
  it('a conferência confirma a criação, NÃO quita sozinha e deixa a quitação solicitada pendente', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore();
    await lancar(bling, store, { pago: true });

    await reconciliar(bling, store);

    expect(bling.baixasEnviadas()).toBe(0);
    expect(await pendentes(store)).toEqual([CHAVE]);
  });

  it('quitar é uma ação explícita, com intenção durável: uma baixa, e repetir não envia outra', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore();
    await lancar(bling, store, { pago: true });
    await reconciliar(bling, store);

    const primeira = await Reconciliacao.quitarOperacao(scope, CHAVE, 'corr', quitacaoDeTeste(bling, store, '2026-10-10'));
    const segunda = await Reconciliacao.quitarOperacao(scope, CHAVE, 'corr', quitacaoDeTeste(bling, store, '2026-10-10'));

    expect(primeira).toMatchObject({ resultado: 'quitada' });
    expect(segunda).toMatchObject({ resultado: 'nada_pendente' });
    expect(bling.baixasEnviadas()).toBe(1);
    expect(store.baixas).toHaveLength(1);
    expect(store.salvos[0]?.situacao).toBe('pago');
    expect(await pendentes(store)).toEqual([]);
  });
});

describe('defeito 4 — revisão manual tem saída auditável', () => {
  it('evidência manual: o operador aponta a conta, o servidor a confere por id e grava o recibo com o ator', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore();
    await lancar(bling, store);
    const [t] = store.tentativas;
    if (!t) throw new Error('tentativa esperada');
    // Operação anterior à referência: nem a intenção nem a conta remota a têm.
    store.tentativas[0] = { ...t, numeroDocumento: null };
    const remota = bling.remotas.get('88123');
    if (remota) remota.numeroDocumento = null;
    expect(await reconciliar(bling, store)).toMatchObject({ resultado: 'revisao_manual', motivo: 'sem_referencia' });

    // Sem referência na conta, só a declaração explícita do operador vincula.
    const manual = await Reconciliacao.confirmarManualmente(
      scope, CHAVE, '88123', 'corr', reconciliacaoDeTeste(bling, store), { declaracaoDoOperador: true },
    );

    expect(manual).toMatchObject({ resultado: 'confirmada' });
    expect(store.recibos.at(-1)).toMatchObject({ resultado: 'confirmada', metodo: 'declaracao_do_operador', atorId: ATOR });
    expect(store.salvos).toHaveLength(1);
    expect(bling.posts).toHaveLength(1);
  });
});

describe('defeito 5 — conta paga não prova que a baixa do ORBITA aconteceu', () => {
  async function baixaAmbiguaEPagaPorTerceiro(alterar: (c: NonNullable<ReturnType<FakeBling['remotas']['get']>>) => void) {
    const bling = fakeBling({ baixa: 'ambigua-sem-efeito' });
    const store = fakeStore();
    await lancar(bling, store, { pago: true });
    const conta = bling.remotas.get('88123');
    if (!conta) throw new Error('conta esperada');
    alterar(conta);
    return { bling, store, resultado: await reconciliar(bling, store) };
  }

  it('paga por terceiro (borderô sem a referência da baixa): revisão manual, baixa não é confirmada', async () => {
    const { bling, store, resultado } = await baixaAmbiguaEPagaPorTerceiro((c) => {
      c.situacao = 2; c.saldo = 0; c.borderos.push('9999');
    });

    expect(resultado).toMatchObject({ resultado: 'revisao_manual', motivo: 'quitada_sem_autoria' });
    expect(store.baixas[0]?.estado).toBe('indeterminada');
    expect(bling.baixasEnviadas()).toBe(1);
  });

  it('paga sem borderô: revisão manual', async () => {
    const { resultado } = await baixaAmbiguaEPagaPorTerceiro((c) => { c.situacao = 2; c.saldo = 0; });
    expect(resultado).toMatchObject({ resultado: 'revisao_manual', motivo: 'bordero_ausente' });
  });

  it('paga sem saldo informado: revisão manual', async () => {
    const { resultado } = await baixaAmbiguaEPagaPorTerceiro((c) => { c.situacao = 2; c.saldo = null; c.borderos.push('9999'); });
    expect(resultado).toMatchObject({ resultado: 'revisao_manual', motivo: 'saldo_ausente' });
  });
});

describe('proteções em volta das recuperações', () => {
  const CHAVE_2 = '66666666-6666-4666-8666-666666666666';
  const quitarOperacao = (bling: FakeBling, store: FakeStore) =>
    Reconciliacao.quitarOperacao(scope, CHAVE, 'corr', quitacaoDeTeste(bling, store, '2026-10-10'));

  it('reparo sem conseguir ler a conta: continua pendente, sem POST e sem título inventado', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore({ falhasDeTitulo: 1 });
    await lancar(bling, store);
    await reconciliar(bling, store);
    bling.remotas.delete('88123');

    expect(await reconciliar(bling, store)).toMatchObject({ resultado: 'reparo_local', motivo: 'conta_ausente', projecaoLocal: 'pendente' });
    expect(store.salvos).toHaveLength(0);
    expect(bling.posts).toHaveLength(1);
  });

  it('quitar conta já paga por terceiro: nada é enviado, e a baixa não é atribuída ao ORBITA', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore();
    await lancar(bling, store, { pago: true });
    await reconciliar(bling, store);
    const conta = bling.remotas.get('88123');
    if (conta) Object.assign(conta, { situacao: 2, saldo: 0, borderos: ['9999'] });

    expect(await quitarOperacao(bling, store)).toMatchObject({ resultado: 'ja_quitada_no_bling', projecaoLocal: 'consistente' });
    expect(bling.baixasEnviadas()).toBe(0);
    expect(store.baixas).toHaveLength(0);
    expect(store.salvos[0]?.situacao).toBe('pago');
  });

  it('quitação com ACK perdido: não quita de novo; só a conferência pelo borderô a confirma', async () => {
    const bling = fakeBling({ modo: 'perde-ack', baixa: 'perde-ack' });
    const store = fakeStore();
    await lancar(bling, store, { pago: true });
    await reconciliar(bling, store);

    expect(await quitarOperacao(bling, store)).toMatchObject({ resultado: 'quitacao_nao_confirmada' });
    expect(await quitarOperacao(bling, store)).toMatchObject({ resultado: 'nada_pendente' });
    expect(await reconciliar(bling, store)).toMatchObject({ resultado: 'confirmada', projecaoLocal: 'consistente' });

    expect(bling.baixasEnviadas()).toBe(1);
    expect(store.recibos.at(-1)).toMatchObject({ alvo: 'baixa', metodo: 'leitura_de_borderos', borderoId: '7001' });
    expect(store.salvos[0]?.situacao).toBe('pago');
    expect(await pendentes(store)).toEqual([]);
  });

  it('confirmação manual de uma conta com a referência de outra operação: recusada', async () => {
    const bling = fakeBling();
    const store = fakeStore();
    await lancar(bling, store);
    await lancar(bling, store, { chaveIdempotencia: CHAVE_2, valor: 900 });
    const t2 = store.tentativa(ORG, CHAVE_2);
    if (t2) t2.estado = 'indeterminada';

    const manual = await Reconciliacao.confirmarManualmente(scope, CHAVE_2, '88123', 'corr', reconciliacaoDeTeste(bling, store));

    expect(manual).toMatchObject({ resultado: 'revisao_manual', motivo: 'referencia_de_outra_operacao' });
    expect(store.tentativa(ORG, CHAVE_2)?.estado).toBe('indeterminada');
  });

  it('a conta remota já ligada a outra operação nunca é confirmada para uma segunda', async () => {
    const bling = fakeBling();
    const store = fakeStore();
    await lancar(bling, store);
    await lancar(bling, store, { chaveIdempotencia: CHAVE_2 });
    const t2 = store.tentativa(ORG, CHAVE_2);
    if (t2) Object.assign(t2, { estado: 'indeterminada', blingContaId: null, numeroDocumento: null });
    const remota = bling.remotas.get('88123');
    if (remota) remota.numeroDocumento = null;

    const manual = await Reconciliacao.confirmarManualmente(
      scope, CHAVE_2, '88123', 'corr', reconciliacaoDeTeste(bling, store), { declaracaoDoOperador: true },
    );

    expect(manual).toMatchObject({ resultado: 'divergente', motivo: 'conta_de_outra_operacao' });
    expect(store.tentativa(ORG, CHAVE_2)?.estado).toBe('indeterminada');
  });

  it('confirmação manual de operação sem pendência de criação: nada muda', async () => {
    const bling = fakeBling();
    const store = fakeStore();
    await lancar(bling, store);

    expect(await Reconciliacao.confirmarManualmente(scope, CHAVE, '88123', 'corr', reconciliacaoDeTeste(bling, store)))
      .toMatchObject({ resultado: 'nada_pendente' });
    expect(store.recibos).toHaveLength(0);
  });
});

