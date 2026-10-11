import { describe, expect, it } from 'vitest';

import { buildDespesaRequest } from '@/lib/config/despesaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import { fakeBling, type FakeBling } from './__testkit__/blingContasPagarFake';
import { depsDeTeste, fakeStore, quitacaoDeTeste, reconciliacaoDeTeste, type FakeStore } from './__testkit__/despesaFakes';
import { createDespesaHandler } from './despesaHandler';
import * as Reconciliacao from './reconciliacaoDaOperacao';
import { pendenciaDaOperacao } from './reconciliacaoDeContaPagar';

/**
 * Segunda revisão independente do PR #109 (HEAD `bc5cf2d`): pagamento sem prova,
 * conta de terceiro por coincidência de campos, quitação recusada invisível,
 * título inconsistente e reabertura em outro dia. Cada caso pela API de
 * reconciliação/quitação, com os contadores do Bling fake.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const ATOR = '22222222-2222-4222-8222-222222222222';
const CHAVE = '55555555-5555-4555-8555-555555555555';
/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scope = { organizationId: ORG, actorId: ATOR, role: 'owner' } as unknown as VerifiedOrganizationScope;

async function lancar(bling: FakeBling, store: FakeStore, overrides: Record<string, unknown> = {}, hoje = '2026-10-09') {
  const corpo = buildDespesaRequest({
    descricao: 'Aluguel', valor: 1200, dataVencimento: '2026-10-20', chaveIdempotencia: CHAVE,
    categoriaId: '33333333-3333-4333-8333-333333333333', ...overrides,
  });
  return (await createDespesaHandler(depsDeTeste(scope, { bling, store, hoje: () => hoje }))(
    new Request('https://orbita.test/api/financeiro', { method: 'POST', body: JSON.stringify(corpo) }),
  )).status;
}

const reconciliar = (bling: FakeBling, store: FakeStore) =>
  Reconciliacao.reconciliarOperacao(scope, CHAVE, 'corr', reconciliacaoDeTeste(bling, store));
const quitar = (bling: FakeBling, store: FakeStore, hoje = '2026-10-10') =>
  Reconciliacao.quitarOperacao(scope, CHAVE, 'corr', quitacaoDeTeste(bling, store, hoje));
const operacao = async (store: FakeStore) => {
  const lida = await store.operacoes().lerOperacao(scope, CHAVE);
  if (lida._tag !== 'Encontrada') throw new Error('operação esperada');
  return lida.operacao;
};
const pendentes = async (store: FakeStore) => {
  const lista = await store.operacoes().listarPendentes(scope);
  return lista._tag === 'Listadas' ? lista.operacoes.map((o) => o.ref) : [];
};
const contaRemota = (bling: FakeBling, id = '88123') => {
  const conta = bling.remotas.get(id);
  if (!conta) throw new Error(`conta ${id} esperada`);
  return conta;
};

/** Criação confirmada pela conferência, com a quitação pedida e ainda não feita. */
async function quitacaoPendente() {
  const bling = fakeBling({ modo: 'perde-ack' });
  const store = fakeStore();
  await lancar(bling, store, { pago: true });
  await reconciliar(bling, store);
  return { bling, store };
}

describe('P1-1 — "Pago" sem saldo comprovado não marca o título como pago', () => {
  it.each([
    ['saldo ausente', null],
    ['saldo diferente de zero', 10],
  ])('quitar com conta Pago e %s: nada é enviado e o título continua aberto', async (_caso, saldo) => {
    const { bling, store } = await quitacaoPendente();
    Object.assign(contaRemota(bling), { situacao: 2, saldo });

    const resultado = await quitar(bling, store);

    expect(resultado).toMatchObject({ resultado: 'conta_inconsistente' });
    expect(store.salvos[0]?.situacao).toBe('aberto');
    expect(bling.baixasEnviadas()).toBe(0);
    expect(await pendentes(store)).toEqual([CHAVE]);
  });

  it('quitar com conta Pago e saldo zero: pagamento confirmado, sem baixa do ORBITA', async () => {
    const { bling, store } = await quitacaoPendente();
    Object.assign(contaRemota(bling), { situacao: 2, saldo: 0, borderos: ['9999'] });

    expect(await quitar(bling, store)).toMatchObject({ resultado: 'ja_quitada_no_bling' });
    expect(store.salvos[0]?.situacao).toBe('pago');
    expect(store.baixas).toHaveLength(0);
    expect(bling.baixasEnviadas()).toBe(0);
  });

  it('reparo do título com conta Pago e saldo ausente: o título nasce aberto, não pago', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore({ falhasDeTitulo: 1 });
    await lancar(bling, store);
    await reconciliar(bling, store);
    Object.assign(contaRemota(bling), { situacao: 2, saldo: null });

    await reconciliar(bling, store);

    expect(store.salvos).toHaveLength(1);
    expect(store.salvos[0]?.situacao).toBe('aberto');
  });
});

describe('P1-2 — coincidência de campos não prova que a conta é desta operação', () => {
  /** Operação sem referência (anterior à migration 74), com a conta dela e uma conta independente idêntica. */
  async function duasContasIdenticas() {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore();
    await lancar(bling, store);
    const [t] = store.tentativas;
    if (!t) throw new Error('tentativa esperada');
    store.tentativas[0] = { ...t, numeroDocumento: null };
    contaRemota(bling).numeroDocumento = null;
    bling.semear({ id: '99999', valor: 1200, vencimento: '2026-10-20', contatoId: 7001, dataEmissao: '2026-10-09' });
    await reconciliar(bling, store);
    return { bling, store };
  }

  it('sem referência e sem declaração do operador: a conta apontada NÃO é vinculada', async () => {
    const { bling, store } = await duasContasIdenticas();

    const manual = await Reconciliacao.confirmarManualmente(scope, CHAVE, '99999', 'corr', reconciliacaoDeTeste(bling, store));

    expect(manual).toMatchObject({ resultado: 'revisao_manual', motivo: 'sem_evidencia_positiva' });
    expect(store.tentativa(ORG, CHAVE)?.estado).toBe('indeterminada');
    expect(store.salvos).toHaveLength(0);
    expect(await pendentes(store)).toEqual([CHAVE]);
  });

  it('com a declaração explícita do operador: vincula, e o recibo diz que é declaração, com o ator', async () => {
    const { bling, store } = await duasContasIdenticas();

    const manual = await Reconciliacao.confirmarManualmente(
      scope, CHAVE, '88123', 'corr', reconciliacaoDeTeste(bling, store), { declaracaoDoOperador: true },
    );

    expect(manual).toMatchObject({ resultado: 'confirmada' });
    expect(store.recibos.at(-1)).toMatchObject({ metodo: 'declaracao_do_operador', atorId: ATOR, blingContaId: '88123' });
    expect(bling.posts).toHaveLength(1);
  });

  it('declaração não vence os fatos: conta divergente continua recusada', async () => {
    const { bling, store } = await duasContasIdenticas();
    contaRemota(bling, '99999').valor = 1300;

    const manual = await Reconciliacao.confirmarManualmente(
      scope, CHAVE, '99999', 'corr', reconciliacaoDeTeste(bling, store), { declaracaoDoOperador: true },
    );

    expect(manual).toMatchObject({ resultado: 'revisao_manual', motivo: 'candidato_divergente' });
  });

  it('a referência da operação na conta é evidência positiva: dispensa a declaração', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore();
    await lancar(bling, store);

    const manual = await Reconciliacao.confirmarManualmente(scope, CHAVE, '88123', 'corr', reconciliacaoDeTeste(bling, store));

    expect(manual).toMatchObject({ resultado: 'confirmada' });
    expect(store.recibos.at(-1)).toMatchObject({ metodo: 'confirmacao_manual' });
  });
});

describe('P1-3 — quitação pedida e não realizada nunca some da lista', () => {
  async function quitacaoRecusada() {
    const bling = fakeBling({ falhaBaixa: 'Portador inválido' });
    const store = fakeStore();
    await lancar(bling, store, { pago: true });
    return { bling, store };
  }

  it('baixa recusada com o título aberto: pendência visível', async () => {
    const { store } = await quitacaoRecusada();

    expect(store.baixas[0]?.estado).toBe('recusada');
    expect(pendenciaDaOperacao(await operacao(store))).toBe('quitacao_recusada');
    expect(await pendentes(store)).toEqual([CHAVE]);
  });

  it('recusada e ainda aberta no Bling: a conferência não envia nada e a pendência continua', async () => {
    const { bling, store } = await quitacaoRecusada();

    expect(await reconciliar(bling, store)).toMatchObject({ resultado: 'revisao_manual', motivo: 'conta_nao_quitada' });
    expect(bling.baixasEnviadas()).toBe(1);
    expect(await pendentes(store)).toEqual([CHAVE]);
  });

  it('recusada e depois quitada pelo operador no Bling: o título passa a pago, sem atribuir a baixa ao ORBITA', async () => {
    const { bling, store } = await quitacaoRecusada();
    Object.assign(contaRemota(bling), { situacao: 2, saldo: 0, borderos: ['9999'] });

    expect(await reconciliar(bling, store)).toMatchObject({ resultado: 'revisao_manual', motivo: 'quitada_sem_autoria', projecaoLocal: 'consistente' });

    expect(store.salvos[0]?.situacao).toBe('pago');
    expect(store.baixas[0]?.estado).toBe('recusada');
    expect(store.recibos.at(-1)).toMatchObject({ alvo: 'baixa', resultado: 'revisao_manual', motivo: 'quitada_sem_autoria' });
    expect(bling.baixasEnviadas()).toBe(1);
    expect(await pendentes(store)).toEqual([]);
  });

  it('recusada e Bling com "Pago" sem saldo: não marca pago', async () => {
    const { bling, store } = await quitacaoRecusada();
    Object.assign(contaRemota(bling), { situacao: 2, saldo: null, borderos: ['9999'] });

    expect(await reconciliar(bling, store)).toMatchObject({ resultado: 'revisao_manual', motivo: 'saldo_ausente' });
    expect(store.salvos[0]?.situacao).toBe('aberto');
    expect(await pendentes(store)).toEqual([CHAVE]);
  });

  it('quitação recusada não é reenviada pela ação de quitar', async () => {
    const { bling, store } = await quitacaoRecusada();

    expect(await quitar(bling, store)).toMatchObject({ resultado: 'nada_pendente' });
    expect(bling.baixasEnviadas()).toBe(1);
  });
});

describe('P1/P2-4 — um UUID não é um título', () => {
  it('título vinculado que não é encontrado: operação inconsistente e visível', async () => {
    const bling = fakeBling();
    const store = fakeStore();
    await lancar(bling, store);
    store.salvos.splice(0, 1);

    const lida = await operacao(store);
    expect(lida.tituloSituacao).toBeNull();
    expect(pendenciaDaOperacao(lida)).toBe('titulo_inconsistente');
    expect(await pendentes(store)).toEqual([CHAVE]);
    expect(await reconciliar(bling, store)).toMatchObject({ resultado: 'revisao_manual', motivo: 'titulo_inconsistente', projecaoLocal: 'pendente' });
    expect(store.salvos).toHaveLength(0);
  });

  it('baixa confirmada e título cancelado localmente: inconsistente, não concluída', async () => {
    const bling = fakeBling();
    const store = fakeStore();
    await lancar(bling, store, { pago: true });
    const titulo = store.salvos[0];
    if (titulo) titulo.situacao = 'cancelado';

    expect(pendenciaDaOperacao(await operacao(store))).toBe('titulo_inconsistente');
  });

  it('situação local desconhecida: inconsistente', () => {
    expect(pendenciaDaOperacao({
      estado: 'confirmada', tituloId: 't', tituloSituacao: 'misterioso', quitacaoSolicitada: false, baixa: null,
    })).toBe('titulo_inconsistente');
  });

  it('reparo do título: leitura de OUTRA conta remota não reconstrói o título', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore({ falhasDeTitulo: 1 });
    await lancar(bling, store);
    await reconciliar(bling, store);
    bling.remotas.set('88123', { ...contaRemota(bling), id: '77777' });

    expect(await reconciliar(bling, store)).toMatchObject({ resultado: 'reparo_local', motivo: 'leitura_inconsistente', projecaoLocal: 'pendente' });
    expect(store.salvos).toHaveLength(0);
  });

  it('reparo do título: conta com valor divergente da intenção não reconstrói o título', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore({ falhasDeTitulo: 1 });
    await lancar(bling, store);
    await reconciliar(bling, store);
    contaRemota(bling).valor = 1300;

    expect(await reconciliar(bling, store)).toMatchObject({ resultado: 'reparo_local', motivo: 'candidato_divergente', projecaoLocal: 'pendente' });
    expect(store.salvos).toHaveLength(0);
  });
});

describe('P2-6 — reabertura comprovadamente não despachada em outro dia', () => {
  it('criação: o reenvio do dia seguinte grava a nova emissão, e a conferência acha a conta por ela', async () => {
    const store = fakeStore();
    await lancar(fakeBling({ modo: 'sem-credencial' }), store, {}, '2026-10-09');
    expect(store.tentativa(ORG, CHAVE)).toMatchObject({ estado: 'nao_enviada', epoca: 1 });

    const bling = fakeBling({ modo: 'perde-ack' });
    await lancar(bling, store, {}, '2026-10-10');

    expect(store.tentativa(ORG, CHAVE)).toMatchObject({ estado: 'indeterminada', epoca: 2, dataEmissao: '2026-10-10' });
    expect(contaRemota(bling).dataEmissao).toBe('2026-10-10');
    expect(await reconciliar(bling, store)).toMatchObject({ resultado: 'confirmada' });
    expect(bling.posts).toHaveLength(1);
  });

  it('baixa: a quitação reaberta no dia seguinte é provada pelo borderô com a nova data', async () => {
    const bling = fakeBling({ modo: 'perde-ack', baixa: 'sem-credencial' });
    const store = fakeStore();
    await lancar(bling, store, { pago: true });
    await reconciliar(bling, store);
    await quitar(bling, store, '2026-10-10');
    expect(store.baixas[0]).toMatchObject({ estado: 'nao_enviada', dataBaixa: '2026-10-10' });

    bling.mudarModoDeBaixa('perde-ack');
    const resultado = await quitar(bling, store, '2026-10-11');

    expect(resultado).toMatchObject({ resultado: 'quitacao_nao_confirmada' });
    expect(store.baixas[0]).toMatchObject({ estado: 'indeterminada', epoca: 2, dataBaixa: '2026-10-11' });
    expect(await reconciliar(bling, store)).toMatchObject({ resultado: 'confirmada', projecaoLocal: 'consistente' });
  });
});
