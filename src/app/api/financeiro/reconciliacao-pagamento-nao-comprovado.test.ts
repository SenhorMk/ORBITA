import { describe, expect, it } from 'vitest';

import { buildDespesaRequest } from '@/lib/config/despesaContract';
import { respostaDaReconciliacaoSchema, situacaoParaOOperador } from '@/lib/config/operacaoFinanceiraContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import { fakeBling, type FakeBling } from './__testkit__/blingContasPagarFake';
import { depsDeTeste, fakeStore, quitacaoDeTeste, type FakeStore } from './__testkit__/despesaFakes';
import { createDespesaHandler } from './despesaHandler';
import { createOperacoesHandlers } from './operacoes/operacoesHandler';

/**
 * Revisão final do PR #109 (HEAD `56a7e03`): "Pago" sem saldo comprovado.
 * A API não pode declarar a operação consistente, e uma sincronização que
 * grave `pago` por cima do título não pode apagar a pendência.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const CHAVE = '55555555-5555-4555-8555-555555555555';
/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scope = { organizationId: ORG, actorId: '22222222-2222-4222-8222-222222222222', role: 'owner' } as unknown as VerifiedOrganizationScope;

async function contaPagaSemSaldo() {
  const bling = fakeBling({ modo: 'perde-ack' });
  const store = fakeStore();
  const corpo = buildDespesaRequest({
    descricao: 'Aluguel', valor: 1200, dataVencimento: '2026-10-20', chaveIdempotencia: CHAVE,
    categoriaId: '33333333-3333-4333-8333-333333333333',
  });
  await createDespesaHandler(depsDeTeste(scope, { bling, store, hoje: () => '2026-10-09' }))(
    new Request('https://orbita.test/api/financeiro', { method: 'POST', body: JSON.stringify(corpo) }),
  );
  const conta = bling.remotas.get('88123');
  if (!conta) throw new Error('conta esperada');
  Object.assign(conta, { situacao: 2, saldo: null });
  return { bling, store };
}

function handlers(bling: FakeBling, store: FakeStore) {
  return createOperacoesHandlers({
    ...quitacaoDeTeste(bling, store),
    correlationId: () => 'corr',
    async autorizar() { return { _tag: 'Autorizado' as const, scope }; },
  });
}

const post = () => new Request(`https://orbita.test/api/financeiro/operacoes/${CHAVE}/reconciliar`, { method: 'POST' });

describe('P1/P2 — a API distingue criação comprovada, registro feito e pagamento não comprovado', () => {
  it('a conferência confirma a criação, mas NÃO declara a projeção consistente', async () => {
    const { bling, store } = await contaPagaSemSaldo();

    const corpo = respostaDaReconciliacaoSchema.parse(await (await handlers(bling, store).reconciliar(post(), CHAVE)).json());

    expect(corpo).toMatchObject({ resultado: 'confirmada', projecaoLocal: 'divergente', operacao: { pendencia: 'pagamento_nao_comprovado' } });
    expect(situacaoParaOOperador(corpo)).toBe('pagamento_nao_comprovado');
  });

  it('uma nova conferência sem evidência continua divergente; com saldo zero, consistente', async () => {
    const { bling, store } = await contaPagaSemSaldo();
    const h = handlers(bling, store);
    await h.reconciliar(post(), CHAVE);

    expect(respostaDaReconciliacaoSchema.parse(await (await h.reconciliar(post(), CHAVE)).json()))
      .toMatchObject({ resultado: 'revisao_manual', projecaoLocal: 'divergente' });
    const conta = bling.remotas.get('88123');
    if (conta) conta.saldo = 0;
    expect(respostaDaReconciliacaoSchema.parse(await (await h.reconciliar(post(), CHAVE)).json()))
      .toMatchObject({ resultado: 'reparo_local', projecaoLocal: 'consistente', operacao: { pendencia: null } });
  });
});

describe('P1 — uma gravação de "pago" fora da comprovação não apaga a pendência', () => {
  it('o upsert da sincronização (Pago, sem saldo) mantém o título aberto e a pendência visível', async () => {
    const { bling, store } = await contaPagaSemSaldo();
    await handlers(bling, store).reconciliar(post(), CHAVE);

    // O que `toTitulo()` da sincronização grava para a mesma conta remota.
    const salvo = await store.salvarTitulo(scope, {
      blingId: '88123', valor: 1200, dataVencimento: '2026-10-20', descricao: 'Conta a Pagar #88123', situacao: 'pago', situacaoBling: 2,
    });

    expect(salvo.situacao).toBe('aberto');
    const lista = await store.operacoes().listarPendentes(scope);
    expect(lista._tag === 'Listadas' ? lista.operacoes.map((o) => o.ref) : []).toEqual([CHAVE]);
  });
});
