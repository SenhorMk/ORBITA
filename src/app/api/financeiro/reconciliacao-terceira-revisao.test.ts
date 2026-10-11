import { describe, expect, it } from 'vitest';

import { buildDespesaRequest } from '@/lib/config/despesaContract';
import { listaDeOperacoesSchema } from '@/lib/config/operacaoFinanceiraContract';
import type { LeituraRemota } from '@/lib/integrations/bling/operacaoRemotaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { BorderoLido, ContaPagarDetalhada } from '@/services/blingPort';

import { fakeBling, type FakeBling } from './__testkit__/blingContasPagarFake';
import { depsDeTeste, fakeStore, quitacaoDeTeste, reconciliacaoDeTeste, type FakeStore } from './__testkit__/despesaFakes';
import { createDespesaHandler } from './despesaHandler';
import { createOperacoesHandlers } from './operacoes/operacoesHandler';
import * as Reconciliacao from './reconciliacaoDaOperacao';
import { decidirAutoriaDaBaixa } from './reconciliacaoDeContaPagar';

/**
 * Terceira revisão independente do PR #109 (HEAD `6aec59b`): quitação de conta
 * incompatível, autoria do borderô por correspondência ambígua e pendências
 * além da primeira página.
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
  await createDespesaHandler(depsDeTeste(scope, { bling, store, hoje: () => '2026-10-09' }))(
    new Request('https://orbita.test/api/financeiro', { method: 'POST', body: JSON.stringify(corpo) }),
  );
}

const reconciliar = (bling: FakeBling, store: FakeStore) =>
  Reconciliacao.reconciliarOperacao(scope, CHAVE, 'corr', reconciliacaoDeTeste(bling, store));
const contaRemota = (bling: FakeBling) => {
  const conta = bling.remotas.get('88123');
  if (!conta) throw new Error('conta esperada');
  return conta;
};

describe('P1 — quitar só uma conta compatível com a intenção original', () => {
  async function quitacaoPendente() {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore();
    await lancar(bling, store, { pago: true });
    await reconciliar(bling, store);
    return { bling, store };
  }

  it.each([
    ['id diferente do confirmado', { id: '77777' }],
    ['valor divergente', { valor: 1300 }],
    ['vencimento divergente', { vencimento: '2026-10-21' }],
    ['emissão divergente', { dataEmissao: '2026-10-08' }],
    ['fornecedor divergente', { contatoId: 9999 }],
  ])('%s: nada é enviado, nenhuma intenção de baixa nasce', async (_caso, mudanca) => {
    const { bling, store } = await quitacaoPendente();
    bling.remotas.set('88123', { ...contaRemota(bling), ...mudanca });

    const resultado = await Reconciliacao.quitarOperacao(scope, CHAVE, 'corr', quitacaoDeTeste(bling, store));

    expect(resultado).toMatchObject({ resultado: 'conta_divergente' });
    expect(bling.baixasEnviadas()).toBe(0);
    expect(store.baixas).toHaveLength(0);
    expect(store.salvos[0]?.situacao).toBe('aberto');
  });

  it.each([
    ['saldo ausente', null],
    ['saldo zerado', 0],
    ['saldo parcial', 600],
  ])('em aberto com %s (situação e saldo contraditórios): nada é enviado', async (_caso, saldo) => {
    const { bling, store } = await quitacaoPendente();
    contaRemota(bling).saldo = saldo;

    expect(await Reconciliacao.quitarOperacao(scope, CHAVE, 'corr', quitacaoDeTeste(bling, store)))
      .toMatchObject({ resultado: 'conta_inconsistente' });
    expect(bling.baixasEnviadas()).toBe(0);
    expect(store.baixas).toHaveLength(0);
  });

  it('conta compatível, em aberto com o saldo integral: quita uma vez', async () => {
    const { bling, store } = await quitacaoPendente();

    expect(await Reconciliacao.quitarOperacao(scope, CHAVE, 'corr', quitacaoDeTeste(bling, store)))
      .toMatchObject({ resultado: 'quitada' });
    expect(bling.baixasEnviadas()).toBe(1);
  });
});

describe('P1/P2 — autoria do borderô só por correspondência inequívoca', () => {
  const BAIXA = { referencia: 'ORBQ-0123456789ABCDEF', dataBaixa: '2026-10-09' };
  const conta = (borderos: string[]): ContaPagarDetalhada => ({
    id: '88123', situacao: 2, valor: 1200, vencimento: '2026-10-20', contatoId: 7001, dataEmissao: '2026-10-09',
    numeroDocumento: 'ORB-0123456789ABCDEF', saldo: 0, historico: 'Aluguel', categoriaId: 900, borderos,
  });
  const lido = (b: Partial<BorderoLido>): LeituraRemota<BorderoLido> => ({
    _tag: 'RemotoPresente', valor: { id: '7001', data: '2026-10-09', historico: 'Aluguel [ORBQ-0123456789ABCDEF]', ...b },
  });

  it.each([
    ['referência como prefixo de outra maior', 'Aluguel [ORBQ-0123456789ABCDEF00]'],
    ['referência sem os delimitadores', 'Aluguel ORBQ-0123456789ABCDEF'],
    ['referência dentro de outra sequência', 'Aluguel XORBQ-0123456789ABCDEFX'],
  ])('%s: não atribui a autoria', (_caso, historico) => {
    expect(decidirAutoriaDaBaixa(BAIXA, conta(['7001']), [lido({ historico })]))
      .toMatchObject({ _tag: 'RevisaoManual', motivo: 'quitada_sem_autoria' });
  });

  it('borderô devolvido com id diferente do pedido: leitura inconsistente', () => {
    expect(decidirAutoriaDaBaixa(BAIXA, conta(['7001']), [lido({ id: '9999' })]))
      .toMatchObject({ _tag: 'RevisaoManual', motivo: 'leitura_inconsistente' });
  });

  it('leituras que não correspondem aos borderôs da conta: leitura inconsistente', () => {
    expect(decidirAutoriaDaBaixa(BAIXA, conta(['7001', '7002']), [lido({})]))
      .toMatchObject({ _tag: 'RevisaoManual', motivo: 'leitura_inconsistente' });
  });

  it('o mesmo borderô listado duas vezes não vira duas evidências nem uma prova', () => {
    expect(decidirAutoriaDaBaixa(BAIXA, conta(['7001', '7001']), [lido({}), lido({})]))
      .toMatchObject({ _tag: 'RevisaoManual' });
  });

  it('pela API: o Bling devolve outro borderô no lugar do pedido — a baixa continua sem desfecho', async () => {
    const bling = fakeBling({ baixa: 'perde-ack' });
    const store = fakeStore();
    await lancar(bling, store, { pago: true });
    const real = bling.borderos.get('7001');
    if (!real) throw new Error('borderô esperado');
    bling.borderos.set('7001', { ...real, id: '7002' });

    expect(await reconciliar(bling, store)).toMatchObject({ resultado: 'revisao_manual', motivo: 'leitura_inconsistente' });
    expect(store.baixas[0]?.estado).toBe('indeterminada');
  });
});

describe('P2 — todas as pendências alcançáveis pela API, por cursor estável', () => {
  const req = (cursor?: string) => new Request(
    `https://orbita.test/api/financeiro/operacoes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
  );
  const chaveDe = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  function comPendentes(store: FakeStore, n: number) {
    for (let i = 1; i <= n; i++) {
      store.tentativas.push({
        id: `t-${i}`, org: ORG, chave: chaveDe(i), digest: String(i).padStart(64, '0'), valor: 10, dataVencimento: '2026-10-20',
        dataEmissao: '2026-10-09', numeroDocumento: null, quitacaoSolicitada: false, estado: 'indeterminada', epoca: 1,
        blingContaId: null, tituloId: null, contatoBlingId: null, motivo: 'sem_resposta',
        criadaEm: `2026-01-01T00:00:00.${String(i).padStart(6, '0')}+00:00`,
      });
    }
  }

  function handlers(store: FakeStore) {
    return createOperacoesHandlers({
      ...quitacaoDeTeste(fakeBling(), store),
      correlationId: () => 'corr',
      async autorizar() { return { _tag: 'Autorizado' as const, scope }; },
    });
  }

  async function paginas(store: FakeStore, entreAsPaginas?: (pagina: number) => void) {
    const h = handlers(store);
    const lidas: Array<{ refs: string[]; total: number }> = [];
    let cursor: string | undefined;
    for (let pagina = 0; pagina < 20; pagina++) {
      const resposta = await h.listar(req(cursor));
      expect(resposta.status).toBe(200);
      const corpo = listaDeOperacoesSchema.parse(await resposta.json());
      lidas.push({ refs: corpo.operacoes.map((o) => o.ref), total: corpo.total });
      if (corpo.proximoCursor === null) return lidas;
      cursor = corpo.proximoCursor;
      entreAsPaginas?.(pagina);
    }
    throw new Error('paginação não terminou');
  }

  it.each([
    [101, [100, 1]],
    [520, [100, 100, 100, 100, 100, 20]],
  ])('%i pendências: todas alcançadas, sem repetição, em ordem determinística', async (n, tamanhos) => {
    const store = fakeStore();
    comPendentes(store, n);

    const lidas = await paginas(store);

    expect(lidas.map((p) => p.refs.length)).toEqual(tamanhos);
    expect(lidas.every((p) => p.total === n)).toBe(true);
    const todas = lidas.flatMap((p) => p.refs);
    expect(new Set(todas).size).toBe(n);
    expect(todas).toEqual(Array.from({ length: n }, (_, i) => chaveDe(n - i)));
  });

  it('mudanças entre páginas: nada repete, nenhuma pendência antiga é pulada', async () => {
    const store = fakeStore();
    comPendentes(store, 250);

    const lidas = await paginas(store, (pagina) => {
      if (pagina !== 0) return;
      // Entre a 1ª e a 2ª página: uma pendência da 2ª se resolve e outra, nova, nasce.
      const resolvida = store.tentativas.find((t) => t.chave === chaveDe(120));
      if (resolvida) resolvida.estado = 'recusada';
      store.tentativas.push({ ...store.tentativas[0]!, id: 't-nova', chave: chaveDe(999), digest: 'f'.repeat(64),
        criadaEm: '2026-02-01T00:00:00.000000+00:00' });
    });

    const todas = lidas.flatMap((p) => p.refs);
    expect(new Set(todas).size).toBe(todas.length);
    const esperadas = Array.from({ length: 250 }, (_, i) => chaveDe(250 - i)).filter((c) => c !== chaveDe(120));
    expect(todas).toEqual(esperadas);
    expect(lidas.at(-1)?.total).toBe(250);
  });

  it('cursor adulterado: 400, sem leitura', async () => {
    const store = fakeStore();
    comPendentes(store, 3);
    const h = handlers(store);

    expect((await h.listar(req('nao-e-um-cursor'))).status).toBe(400);
    expect((await h.listar(req(Buffer.from('2026|x').toString('base64url')))).status).toBe(400);
  });

  it('o cursor não carrega nem amplia a organização', async () => {
    const store = fakeStore();
    comPendentes(store, 150);
    const deB = createOperacoesHandlers({
      ...quitacaoDeTeste(fakeBling(), store),
      correlationId: () => 'corr',
      async autorizar() {
        return {
          _tag: 'Autorizado' as const,
          scope: { ...scope, organizationId: '44444444-4444-4444-8444-444444444444' } as unknown as VerifiedOrganizationScope,
        };
      },
    });
    const primeira = listaDeOperacoesSchema.parse(await (await handlers(store).listar(req())).json());

    const corpo = listaDeOperacoesSchema.parse(await (await deB.listar(req(primeira.proximoCursor ?? undefined))).json());

    expect(corpo).toMatchObject({ operacoes: [], total: 0, proximoCursor: null });
  });
});
