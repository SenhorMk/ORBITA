import { describe, expect, it } from 'vitest';
import { NextResponse } from 'next/server';

import { buildDespesaRequest, type DespesaRequest } from '@/lib/config/despesaContract';
import { listaDeOperacoesSchema, respostaDaQuitacaoSchema, respostaDaReconciliacaoSchema } from '@/lib/config/operacaoFinanceiraContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import { fakeBling, type FakeBling } from '../__testkit__/blingContasPagarFake';
import { depsDeTeste, fakeStore, quitacaoDeTeste, type FakeStore } from '../__testkit__/despesaFakes';
import { createDespesaHandler } from '../despesaHandler';
import { createOperacoesHandlers } from './operacoesHandler';

const ORG = '11111111-1111-4111-8111-111111111111';
const ORG_B = '44444444-4444-4444-8444-444444444444';
const CHAVE = '55555555-5555-4555-8555-555555555555';
/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scopeA = { organizationId: ORG, actorId: '22222222-2222-4222-8222-222222222222', role: 'owner' } as unknown as VerifiedOrganizationScope;
/** SAFETY: idem, organização B. */
const scopeB = { organizationId: ORG_B, actorId: '22222222-2222-4222-8222-222222222222', role: 'owner' } as unknown as VerifiedOrganizationScope;

async function comOperacaoPendente(): Promise<{ bling: FakeBling; store: FakeStore }> {
  const bling = fakeBling({ modo: 'perde-ack' });
  const store = fakeStore();
  const corpo: DespesaRequest = buildDespesaRequest({
    descricao: 'Aluguel', valor: 1200, dataVencimento: '2026-10-20', chaveIdempotencia: CHAVE,
  });
  await createDespesaHandler(depsDeTeste(scopeA, { bling, store, hoje: () => '2026-10-09' }))(
    new Request('https://orbita.test/api/financeiro', { method: 'POST', body: JSON.stringify(corpo) }),
  );
  return { bling, store };
}

function handlers(bling: FakeBling, store: FakeStore, autorizacao: 'A' | 'B' | 'negado' = 'A') {
  return createOperacoesHandlers({
    ...quitacaoDeTeste(bling, store),
    correlationId: () => 'corr-teste',
    async autorizar() {
      if (autorizacao === 'negado') {
        return { _tag: 'Negado', response: NextResponse.json({ success: false, error: 'Acesso negado' }, { status: 403 }) };
      }
      return { _tag: 'Autorizado', scope: autorizacao === 'A' ? scopeA : scopeB };
    },
  });
}

const req = (corpo?: unknown) => new Request('https://orbita.test/api/financeiro/operacoes', {
  method: corpo === undefined ? 'GET' : 'POST',
  ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
});

describe('rotas de operações financeiras', () => {
  it('lista a operação pendente pelo contrato público, sem ids internos nem referência do Bling', async () => {
    const { bling, store } = await comOperacaoPendente();

    const corpo = await (await handlers(bling, store).listar(req())).json();

    const lido = listaDeOperacoesSchema.parse(corpo);
    expect(lido.operacoes).toEqual([expect.objectContaining({ ref: CHAVE, criacao: 'indeterminada', baixa: null })]);
    expect(JSON.stringify(corpo)).not.toMatch(/tentativa-|ORB-/u);
  });

  it('reconciliar confirma e devolve o desfecho', async () => {
    const { bling, store } = await comOperacaoPendente();

    const resposta = await handlers(bling, store).reconciliar(req({}), CHAVE);

    expect(resposta.status).toBe(200);
    expect(respostaDaReconciliacaoSchema.parse(await resposta.json())).toMatchObject({
      resultado: 'confirmada', operacao: { criacao: 'confirmada', blingContaId: '88123' },
    });
    expect(bling.posts).toHaveLength(1);
  });

  it('sem capacidade: negado antes de qualquer leitura no banco ou no Bling', async () => {
    const { bling, store } = await comOperacaoPendente();
    const negado = handlers(bling, store, 'negado');

    expect((await negado.listar(req())).status).toBe(403);
    expect((await negado.consultar(req(), CHAVE)).status).toBe(403);
    expect((await negado.reconciliar(req({}), CHAVE)).status).toBe(403);
    expect((await negado.confirmarManual(req({ blingContaId: '88123' }), CHAVE)).status).toBe(403);
    expect((await negado.quitar(req({}), CHAVE)).status).toBe(403);
    expect(store.recibos).toHaveLength(0);
    expect(bling.baixasEnviadas()).toBe(0);
    expect(store.tentativa(ORG, CHAVE)?.estado).toBe('indeterminada');
  });

  it('organização B: a operação de A é 404, igual a uma inexistente, e nada é gravado', async () => {
    const { bling, store } = await comOperacaoPendente();
    const deB = handlers(bling, store, 'B');

    expect((await deB.consultar(req(), CHAVE)).status).toBe(404);
    expect((await deB.reconciliar(req({}), CHAVE)).status).toBe(404);
    expect((await deB.confirmarManual(req({ blingContaId: '88123' }), CHAVE)).status).toBe(404);
    expect((await deB.quitar(req({}), CHAVE)).status).toBe(404);
    expect(listaDeOperacoesSchema.parse(await (await deB.listar(req())).json()).operacoes).toEqual([]);
    expect(store.recibos).toHaveLength(0);
  });

  it('organizacao_id no corpo não muda de quem é a operação', async () => {
    const { bling, store } = await comOperacaoPendente();

    const resposta = await handlers(bling, store, 'B').reconciliar(req({ organizacao_id: ORG }), CHAVE);

    expect(resposta.status).toBe(404);
    expect(store.recibos).toHaveLength(0);
  });

  it('ref inválida: 400; ref aleatória: 404', async () => {
    const { bling, store } = await comOperacaoPendente();
    const h = handlers(bling, store);

    expect((await h.reconciliar(req({}), 'nao-e-uuid')).status).toBe(400);
    expect((await h.consultar(req(), '99999999-9999-4999-8999-999999999999')).status).toBe(404);
  });

  it('confirmação manual: corpo inválido é 400 e nada é lido ou gravado', async () => {
    const { bling, store } = await comOperacaoPendente();
    const h = handlers(bling, store);

    expect((await h.confirmarManual(req({ blingContaId: '88 123' }), CHAVE)).status).toBe(400);
    expect((await h.confirmarManual(req({}), CHAVE)).status).toBe(400);
    expect((await h.confirmarManual(req({ blingContaId: '88123' }), 'nao-e-uuid')).status).toBe(400);
    expect(store.recibos).toHaveLength(0);
  });

  it('confirmação manual válida: o recibo leva o ator verificado, e a resposta segue o contrato', async () => {
    const { bling, store } = await comOperacaoPendente();

    const resposta = await handlers(bling, store).confirmarManual(req({ blingContaId: '88123' }), CHAVE);

    expect(respostaDaReconciliacaoSchema.parse(await resposta.json())).toMatchObject({
      resultado: 'confirmada', projecaoLocal: 'consistente', operacao: { pendencia: null },
    });
    expect(store.recibos.at(-1)).toMatchObject({ metodo: 'confirmacao_manual', atorId: scopeA.actorId });
    expect(bling.posts).toHaveLength(1);
  });

  it('quitação: sem quitação pedida, nada é enviado', async () => {
    const { bling, store } = await comOperacaoPendente();
    await handlers(bling, store).reconciliar(req({}), CHAVE);

    const resposta = await handlers(bling, store).quitar(req({}), CHAVE);

    expect(respostaDaQuitacaoSchema.parse(await resposta.json())).toMatchObject({ resultado: 'nada_pendente' });
    expect(bling.baixasEnviadas()).toBe(0);
  });

  it('a lista diz o total e se está incompleta', async () => {
    const { bling, store } = await comOperacaoPendente();
    const operacoes = store.operacoes();
    const h = createOperacoesHandlers({
      ...quitacaoDeTeste(bling, store),
      operacoes: {
        ...operacoes,
        async listarPendentes(s) {
          const lidas = await operacoes.listarPendentes(s);
          return lidas._tag === 'Listadas'
            ? { ...lidas, total: 140, proximo: { criadaEm: '2026-01-01T00:00:00.000001+00:00', ref: CHAVE } }
            : lidas;
        },
      },
      correlationId: () => 'corr-teste',
      async autorizar() { return { _tag: 'Autorizado', scope: scopeA }; },
    });

    const comMais = listaDeOperacoesSchema.parse(await (await h.listar(req())).json());
    expect(comMais).toMatchObject({ total: 140, incompleta: true });
    expect(comMais.proximoCursor).toEqual(expect.any(String));
    expect(listaDeOperacoesSchema.parse(await (await handlers(bling, store).listar(req())).json()))
      .toMatchObject({ total: 1, incompleta: false });
  });

  it('confirmação manual: a declaração viaja no corpo e só vale como booleano', async () => {
    const { bling, store } = await comOperacaoPendente();
    const t = store.tentativa(ORG, CHAVE);
    if (t) store.tentativas[store.tentativas.indexOf(t)] = { ...t, numeroDocumento: null };
    const remota = bling.remotas.get('88123');
    if (remota) remota.numeroDocumento = null;
    const h = handlers(bling, store);

    expect((await h.confirmarManual(req({ blingContaId: '88123', declaracaoDoOperador: 'sim' }), CHAVE)).status).toBe(400);
    expect(respostaDaReconciliacaoSchema.parse(await (await h.confirmarManual(req({ blingContaId: '88123' }), CHAVE)).json()))
      .toMatchObject({ resultado: 'revisao_manual', motivo: 'sem_evidencia_positiva' });
    expect(respostaDaReconciliacaoSchema.parse(await (await h.confirmarManual(req({ blingContaId: '88123', declaracaoDoOperador: true }), CHAVE)).json()))
      .toMatchObject({ resultado: 'confirmada', operacao: { ultimaReconciliacao: { metodo: 'declaracao_do_operador' } } });
    expect(store.recibos.at(-1)).toMatchObject({ metodo: 'declaracao_do_operador', atorId: scopeA.actorId });
  });
});

