import { describe, expect, it } from 'vitest';

import { buildDespesaRequest } from '@/lib/config/despesaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import { fakeBling, type FakeBling } from './__testkit__/blingContasPagarFake';
import { depsDeTeste, fakeStore, reconciliacaoDeTeste, type FakeStore } from './__testkit__/despesaFakes';
import { createDespesaHandler } from './despesaHandler';
import { reconciliarOperacao } from './reconciliacaoDaOperacao';
import { referenciaNoBling } from './tentativaDeContaPagar';

/**
 * PRE-002 de ponta a ponta: a rota de despesa REAL deixa a operação pendente,
 * e a reconciliação REAL — que só lê o Bling — a resolve com prova ou a manda
 * para revisão manual. Os contadores do Bling fake contam o que EXISTE lá.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const ORG_B = '44444444-4444-4444-8444-444444444444';
const ATOR = '22222222-2222-4222-8222-222222222222';
const CHAVE = '55555555-5555-4555-8555-555555555555';
/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scope = { organizationId: ORG, actorId: ATOR, role: 'owner' } as unknown as VerifiedOrganizationScope;
/** SAFETY: idem, organização B. */
const scopeB = { organizationId: ORG_B, actorId: ATOR, role: 'owner' } as unknown as VerifiedOrganizationScope;

function corpo(overrides: Record<string, unknown> = {}) {
  return buildDespesaRequest({
    descricao: 'Aluguel', valor: 1200, dataVencimento: '2026-10-20', chaveIdempotencia: CHAVE,
    categoriaId: '33333333-3333-4333-8333-333333333333', ...overrides,
  });
}

async function lancar(bling: FakeBling, store: FakeStore, overrides: Record<string, unknown> = {}) {
  const handler = createDespesaHandler(depsDeTeste(scope, { bling, store, hoje: () => '2026-10-09' }));
  const resposta = await handler(new Request('https://orbita.test/api/financeiro', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo(overrides)),
  }));
  return resposta.status;
}

const reconciliar = (bling: FakeBling, store: FakeStore, s = scope, correlationId = 'corr-1') =>
  reconciliarOperacao(s, CHAVE, correlationId, reconciliacaoDeTeste(bling, store));

describe('PRE-002 — contraprova da criação', () => {
  it('POST processado, ACK perdido, conferência acha a prova: confirmada, título uma vez, UM POST', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore();

    expect(await lancar(bling, store)).toBe(202);
    expect(store.tentativa(ORG, CHAVE)?.estado).toBe('indeterminada');
    // A referência opaca foi no POST.
    expect(bling.posts[0]?.numeroDocumento).toBe(referenciaNoBling(CHAVE));

    const resultado = await reconciliar(bling, store);

    expect(bling.posts).toHaveLength(1);
    expect(bling.contasCriadasNoBling()).toBe(1);
    expect(resultado).toMatchObject({ _tag: 'Reconciliada', resultado: 'confirmada', motivo: null });
    expect(store.tentativa(ORG, CHAVE)).toMatchObject({ estado: 'confirmada', blingContaId: '88123', tituloId: 'titulo-1' });
    expect(store.salvos).toEqual([expect.objectContaining({ blingId: '88123', valor: 1200, situacao: 'aberto', descricao: 'Aluguel' })]);
    // Recibo: quem decidiu, com qual evidência.
    expect(store.recibos).toEqual([expect.objectContaining({ alvo: 'criacao', resultado: 'confirmada', blingContaId: '88123', atorId: ATOR })]);
  });

  it('conferir de novo não cria título nem recibo de confirmação outra vez', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore();
    await lancar(bling, store);
    await reconciliar(bling, store);

    const de_novo = await reconciliar(bling, store);

    expect(de_novo).toMatchObject({ resultado: 'nada_pendente' });
    expect(store.salvos).toHaveLength(1);
    expect(store.recibos).toHaveLength(1);
    expect(bling.posts).toHaveLength(1);
  });

  it('retry humano depois da confirmação: reenviar o mesmo lançamento devolve sucesso sem POST', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore();
    await lancar(bling, store);
    await reconciliar(bling, store);

    expect(await lancar(bling, store)).toBe(200);
    expect(bling.posts).toHaveLength(1);
    expect(store.salvos).toHaveLength(1);
  });
});

describe('PRE-002 — contraprova da baixa', () => {
  it('POST /baixar processado, ACK perdido, conta lida quitada: baixa confirmada, título pago, UMA baixa', async () => {
    const bling = fakeBling({ baixa: 'perde-ack' });
    const store = fakeStore();

    expect(await lancar(bling, store, { pago: true })).toBe(200);
    expect(store.baixas.map((b) => b.estado)).toEqual(['indeterminada']);
    expect(store.salvos[0]?.situacao).toBe('aberto');

    const resultado = await reconciliar(bling, store);

    expect(bling.baixasEnviadas()).toBe(1);
    expect(resultado).toMatchObject({ resultado: 'confirmada' });
    expect(store.baixas[0]).toMatchObject({ estado: 'confirmada', borderoId: '7001' });
    expect(store.salvos[0]?.situacao).toBe('pago');
    expect(store.recibos).toEqual([expect.objectContaining({ alvo: 'baixa', resultado: 'confirmada' })]);
    expect(bling.posts).toHaveLength(1);
  });

  it('baixa ambígua e conta ainda aberta no Bling: revisão manual, nenhuma nova baixa', async () => {
    const bling = fakeBling({ baixa: 'ambigua-sem-efeito' });
    const store = fakeStore();
    await lancar(bling, store, { pago: true });

    const resultado = await reconciliar(bling, store);

    expect(resultado).toMatchObject({ resultado: 'revisao_manual', motivo: 'conta_nao_quitada' });
    expect(store.baixas[0]?.estado).toBe('indeterminada');
    expect(bling.baixasEnviadas()).toBe(1);
    expect(bling.posts).toHaveLength(1);
  });

  it('retry humano da quitação reutiliza a intenção: reenviar o lançamento não envia outra baixa', async () => {
    const bling = fakeBling({ baixa: 'ambigua-sem-efeito' });
    const store = fakeStore();
    await lancar(bling, store, { pago: true });

    await lancar(bling, store, { pago: true });

    expect(bling.baixasEnviadas()).toBe(1);
    expect(store.baixas).toHaveLength(1);
  });
});

describe('PRE-002 — sem prova, revisão manual e zero efeitos', () => {
  it.each([
    ['lookup vazio (o POST não criou nada, mas isso não é prova)', { modo: 'timeout-sem-criar' as const }, 'nenhum_candidato', 0],
    ['listagem com timeout', { modo: 'perde-ack' as const, falhaDeListagem: 'timeout' as const }, 'consulta_incompleta', 1],
    ['listagem com 429', { modo: 'perde-ack' as const, falhaDeListagem: 'limite' as const }, 'consulta_incompleta', 1],
    ['listagem com 5xx', { modo: 'perde-ack' as const, falhaDeListagem: 'erro-5xx' as const }, 'consulta_incompleta', 1],
    ['listagem com corpo inválido', { modo: 'perde-ack' as const, falhaDeListagem: 'invalida' as const }, 'consulta_incompleta', 1],
    ['listagem incompleta', { modo: 'perde-ack' as const, falhaDeListagem: 'incompleta' as const }, 'listagem_incompleta', 1],
    ['leitura por id com falha de rede', { modo: 'perde-ack' as const, falhaDeLeitura: 'timeout' as const }, 'consulta_incompleta', 1],
    ['conta some entre listagem e leitura', { modo: 'perde-ack' as const, someEntreLeituras: true }, 'leitura_inconsistente', 1],
  ])('%s → %s', async (_caso, opcoes, motivo, contas) => {
    const bling = fakeBling(opcoes);
    const store = fakeStore();
    await lancar(bling, store);

    const resultado = await reconciliar(bling, store);

    expect(resultado).toMatchObject({ resultado: 'revisao_manual', motivo });
    expect(store.tentativa(ORG, CHAVE)?.estado).toBe('indeterminada');
    expect(bling.posts).toHaveLength(1);
    expect(bling.contasCriadasNoBling()).toBe(contas);
    expect(bling.baixasEnviadas()).toBe(0);
    expect(store.salvos).toHaveLength(0);
    expect(store.recibos).toEqual([expect.objectContaining({ resultado: 'revisao_manual', motivo })]);
  });

  it('múltiplos candidatos com a referência: revisão manual, nenhum escolhido', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore();
    await lancar(bling, store);
    bling.semear({ id: '99', valor: 1200, vencimento: '2026-10-20', contatoId: 7001, dataEmissao: '2026-10-09', numeroDocumento: referenciaNoBling(CHAVE) });

    expect(await reconciliar(bling, store)).toMatchObject({ resultado: 'revisao_manual', motivo: 'multiplos_candidatos' });
    expect(store.tentativa(ORG, CHAVE)?.blingContaId).toBeNull();
  });

  it('conta idêntica de terceiros sem a referência não confirma nada', async () => {
    const bling = fakeBling({ modo: 'timeout-sem-criar' });
    const store = fakeStore();
    await lancar(bling, store);
    bling.semear({ id: '77', valor: 1200, vencimento: '2026-10-20', contatoId: 7001, dataEmissao: '2026-10-09' });

    expect(await reconciliar(bling, store)).toMatchObject({ resultado: 'revisao_manual', motivo: 'nenhum_candidato' });
  });

  it('tentativa anterior à migration 74 (sem referência): revisão manual mesmo com uma conta igual', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore();
    await lancar(bling, store);
    const [t] = store.tentativas;
    if (!t) throw new Error('tentativa esperada');
    store.tentativas[0] = { ...t, numeroDocumento: null };

    expect(await reconciliar(bling, store)).toMatchObject({ resultado: 'revisao_manual', motivo: 'sem_referencia' });
  });
});

describe('PRE-002 — concorrência e quedas', () => {
  it('duas conferências simultâneas: uma confirma, a outra vê a confirmação; um título, um vínculo', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore();
    await lancar(bling, store);

    const [a, b] = await Promise.all([reconciliar(bling, store, scope, 'corr-a'), reconciliar(bling, store, scope, 'corr-b')]);

    const resultados = [a, b].map((r) => (r._tag === 'Reconciliada' ? r.resultado : r._tag)).sort();
    expect(resultados).toEqual(['confirmada', 'ja_confirmada']);
    expect(store.salvos).toHaveLength(1);
    expect(store.tentativa(ORG, CHAVE)?.tituloId).toBe('titulo-1');
    expect(bling.posts).toHaveLength(1);
  });

  it('queda depois da leitura e antes do commit: nada gravado, e a próxima conferência resolve', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore({ registroDeReconciliacaoFalha: true });
    await lancar(bling, store);

    expect(await reconciliar(bling, store)).toEqual({ _tag: 'Indisponivel' });
    expect(store.recibos).toHaveLength(0);
    expect(store.tentativa(ORG, CHAVE)?.estado).toBe('indeterminada');
  });

  it('queda depois do commit, antes do título: a próxima conferência grava o título uma vez', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore({ falhasDeTitulo: 1 });
    await lancar(bling, store);

    await reconciliar(bling, store);
    expect(store.tentativa(ORG, CHAVE)).toMatchObject({ estado: 'confirmada', tituloId: null });
    expect(store.salvos).toHaveLength(0);

    // Confirmada sem título não está mais pendente de criação; a jornada de
    // repetição (PRE-001) é que grava o título, sem POST.
    expect(await lancar(bling, store)).toBe(200);
    expect(store.salvos).toHaveLength(1);
    expect(store.tentativa(ORG, CHAVE)?.tituloId).toBe('titulo-1');
    expect(bling.posts).toHaveLength(1);
  });
});

describe('PRE-002 — organização', () => {
  it('a organização B não confere a operação de A, nem com a ref', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore();
    await lancar(bling, store);

    expect(await reconciliar(bling, store, scopeB)).toEqual({ _tag: 'NaoEncontrada' });
    expect(store.recibos).toHaveLength(0);
    expect(store.tentativa(ORG, CHAVE)?.estado).toBe('indeterminada');
  });

  it('ref aleatória: não encontrada, sem leitura no Bling', async () => {
    const bling = fakeBling();
    const store = fakeStore();

    const resultado = await reconciliarOperacao(scope, '99999999-9999-4999-8999-999999999999', 'c', reconciliacaoDeTeste(bling, store));

    expect(resultado).toEqual({ _tag: 'NaoEncontrada' });
    expect(store.recibos).toHaveLength(0);
  });
});
