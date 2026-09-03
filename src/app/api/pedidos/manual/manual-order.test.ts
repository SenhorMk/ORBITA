import { describe, expect, it } from 'vitest';

import {
  createManualOrderHandler,
  type DesfechoDaTentativa,
  type ManualOrderBlingPort,
  type ManualOrderCliente,
  type ManualOrderDependencies,
  type ManualOrderProduto,
  type ManualOrderResponseBody,
  type BuscaDePedidoPorNumeroLoja,
  type ManualOrderStorePort,
  type PersistManualOrderInput,
  type ReivindicacaoDeTentativa,
  type TentativaRegistrada,
} from './handler';
import { buildManualOrderRequest, manualOrderRequestSchema } from '@/lib/config/manualOrderContract';
import { pedidoVendaPayloadSchema, type PedidoVendaPayload } from '@/lib/integrations/bling/pedidoVendaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';
const CLIENTE = '44444444-4444-4444-8444-444444444444';
const PRODUTO = '55555555-5555-4555-8555-555555555555';
const PRODUTO_SEM_BLING = '66666666-6666-4666-8666-666666666666';

/**
 * SAFETY: `VerifiedOrganizationScope` é uma marca opaca que só a verificação
 * contra a associação persistida produz. Nos testes o escopo é a entrada, não
 * o que está sob teste, então o cast é a mesma convenção já usada em
 * `invitationService.test.ts` e `e2e/saas-lifecycle.test.ts`.
 */
function scopeFor(organizacaoId: string): VerifiedOrganizationScope {
  return { organizationId: organizacaoId, actorId: ACTOR, role: 'owner' } as unknown as VerifiedOrganizationScope;
}

const scopeA = scopeFor(ORG_A);

function produto(overrides: Partial<ManualOrderProduto> = {}): ManualOrderProduto {
  return { id: PRODUTO, nome: 'Camiseta', codigo: 'CAM-01', blingId: '77', preco: 49.9, estoqueDisponivel: 10, ...overrides };
}

function cliente(overrides: Partial<ManualOrderCliente> = {}): ManualOrderCliente {
  return { id: CLIENTE, nome: 'Ana', blingId: '4321', email: null, telefone: null, cpfCnpj: null, ...overrides };
}

interface FakeStore extends ManualOrderStorePort {
  readonly persisted: PersistManualOrderInput[];
  readonly vinculos: Array<{ clienteId: string; blingId: string }>;
  readonly desfechosRegistrados: DesfechoDaTentativa[];
  /** Fingerprints que o handler calculou e mandou reivindicar (5ª rodada). */
  readonly fingerprintsReivindicados: string[];
}

function fakeStore(options: {
  clientes?: Record<string, ManualOrderCliente>;
  produtos?: ManualOrderProduto[];
  /** Simula `PersistVendaFalhouDefinitivamente` — o servidor respondeu com um erro estruturado. */
  persistDefinitiveError?: Error;
  /** Simula `PersistVendaAmbigua` — a chamada falhou sem resposta do servidor (timeout/conexão perdida). */
  persistAmbiguousError?: Error;
  /**
   * Ticket 30, fatia 3 — simula a venda que `persistVenda` reporta como falha
   * mas que, na verdade, já foi (ou será) commitada. Quando definido,
   * `findVendaManualJaRegistrada` devolve este `pedidoId` a partir da
   * `vendaApareceNaTentativa`-ésima chamada (1-based; padrão 1 = já na
   * primeira leitura).
   */
  vendaJaRegistradaPedidoId?: string;
  vendaApareceNaTentativa?: number;
  /**
   * Ticket 30, fatia 3, 3ª rodada — força o resultado de `reivindicarTentativa`,
   * para simular uma retentativa com a MESMA `referenciaLocal` de uma
   * tentativa anterior (concluída, indeterminada, ou em andamento).
   */
  reivindicacaoForcada?: ReivindicacaoDeTentativa;
  /** 5ª rodada — o que `lerTentativaPorReferencia` (reconciliação) devolve. */
  tentativaRegistrada?: TentativaRegistrada;
} = {}): FakeStore {
  const clientesPorOrg = options.clientes ?? { [ORG_A]: cliente() };
  const produtos = options.produtos ?? [produto()];
  const persisted: PersistManualOrderInput[] = [];
  const vinculos: Array<{ clienteId: string; blingId: string }> = [];
  const desfechosRegistrados: DesfechoDaTentativa[] = [];
  const fingerprintsReivindicados: string[] = [];
  const apareceNaTentativa = options.vendaApareceNaTentativa ?? 1;
  let tentativasDeConfirmacao = 0;

  return {
    persisted,
    vinculos,
    desfechosRegistrados,
    fingerprintsReivindicados,
    async reivindicarTentativa(_scope, _referencia, fingerprint) {
      fingerprintsReivindicados.push(fingerprint);
      return options.reivindicacaoForcada ?? { _tag: 'TentativaNova', tentativaId: 'tentativa-fake-1' };
    },
    async registrarDesfechoDaTentativa(_scope, _tentativaId, desfecho) {
      desfechosRegistrados.push(desfecho);
    },
    async lerTentativaPorReferencia() {
      return options.tentativaRegistrada ?? null;
    },
    async findClienteById(scope, clienteId) {
      const found = clientesPorOrg[scope.organizationId];
      return found && found.id === clienteId ? found : null;
    },
    async linkClienteBlingId(_scope, clienteId, blingId) {
      vinculos.push({ clienteId, blingId });
    },
    async findProdutosByIds(scope, produtoIds) {
      if (scope.organizationId !== ORG_A) return [];
      return produtos.filter((p) => produtoIds.includes(p.id));
    },
    async persistVenda(input) {
      if (options.persistDefinitiveError) {
        return { _tag: 'PersistVendaFalhouDefinitivamente', causa: options.persistDefinitiveError };
      }
      if (options.persistAmbiguousError) {
        return { _tag: 'PersistVendaAmbigua', causa: options.persistAmbiguousError };
      }
      persisted.push(input);
      return { _tag: 'PersistVendaOk', pedidoId: 'pedido-local-1' };
    },
    async findVendaManualJaRegistrada() {
      tentativasDeConfirmacao += 1;
      if (!options.vendaJaRegistradaPedidoId) return null;
      return tentativasDeConfirmacao >= apareceNaTentativa ? { pedidoId: options.vendaJaRegistradaPedidoId } : null;
    },
  };
}

/** `Dormir` de teste: nunca espera de verdade — só conta as chamadas. */
function dormirInstantaneo(): { readonly dormir: (ms: number) => Promise<void>; readonly chamadas: number[] } {
  const chamadas: number[] = [];
  return {
    chamadas,
    dormir: async (ms: number) => {
      chamadas.push(ms);
    },
  };
}

interface FakeBling extends ManualOrderBlingPort {
  readonly payloads: PedidoVendaPayload[];
  readonly estoqueLancado: string[];
  readonly contatosCriados: number;
  /** Pedidos que a compensacao mandou cancelar no Bling. */
  readonly cancelados: string[];
  /** Referências consultadas por `buscarPedidoPorNumeroLoja` (reconciliação, 5ª rodada). */
  readonly numerosLojaConsultados: string[];
}

function fakeBling(options: {
  createFailure?: { message: string; duplicateSale?: boolean; status?: number; type?: string };
  /** 5ª rodada — a chamada de criação LANÇA (timeout/conexão perdida). */
  createThrows?: unknown;
  estoqueFailure?: string;
  formaPagamentoFailure?: string;
  alertas?: string[];
  cancelamentoFailure?: string;
  /** 5ª rodada — o que a busca por `numeroLoja` (reconciliação) encontra. */
  pedidoEncontrado?: BuscaDePedidoPorNumeroLoja;
  buscaFailure?: string;
} = {}): FakeBling {
  const payloads: PedidoVendaPayload[] = [];
  const estoqueLancado: string[] = [];
  const cancelados: string[] = [];
  const numerosLojaConsultados: string[] = [];
  let contatosCriados = 0;

  const port = {
    payloads,
    estoqueLancado,
    cancelados,
    numerosLojaConsultados,
    get contatosCriados() {
      return contatosCriados;
    },
    async getDefaultFormaPagamentoId() {
      if (options.formaPagamentoFailure) {
        return { _tag: 'BlingFailed' as const, failure: { _tag: 'BlingProviderFailure' as const, type: 'RESOURCE_NOT_FOUND', status: 404, message: options.formaPagamentoFailure, duplicateSale: false } };
      }
      return { _tag: 'BlingOk' as const, value: 12 };
    },
    async createContato() {
      contatosCriados += 1;
      return { _tag: 'BlingOk' as const, value: { id: 9001 } };
    },
    async createPedidoVenda(payload: PedidoVendaPayload) {
      payloads.push(payload);
      // 5ª rodada: o ACK perdido da PRÓPRIA criação — a chamada lança, e o
      // pedido pode ter sido criado assim mesmo.
      if (options.createThrows) {
        throw options.createThrows;
      }
      if (options.createFailure) {
        return {
          _tag: 'BlingFailed' as const,
          failure: {
            _tag: 'BlingProviderFailure' as const,
            type: options.createFailure.type ?? 'VALIDATION_ERROR',
            status: options.createFailure.status ?? 400,
            message: options.createFailure.message,
            duplicateSale: options.createFailure.duplicateSale ?? false,
          },
        };
      }
      return { _tag: 'BlingOk' as const, value: { id: '918273', alertas: options.alertas ?? [] } };
    },
    async buscarPedidoPorNumeroLoja(numeroLoja: string) {
      numerosLojaConsultados.push(numeroLoja);
      if (options.buscaFailure) {
        return { _tag: 'BlingFailed' as const, failure: { _tag: 'BlingProviderFailure' as const, type: 'SERVER_ERROR', status: 500, message: options.buscaFailure, duplicateSale: false } };
      }
      return { _tag: 'BlingOk' as const, value: options.pedidoEncontrado ?? { _tag: 'NenhumPedido' as const } };
    },
    async lancarEstoquePedido(pedidoBlingId: string) {
      if (options.estoqueFailure) {
        return { _tag: 'BlingFailed' as const, failure: { _tag: 'BlingProviderFailure' as const, type: 'BAD_REQUEST', status: 400, message: options.estoqueFailure, duplicateSale: false } };
      }
      estoqueLancado.push(pedidoBlingId);
      return { _tag: 'BlingOk' as const, value: undefined };
    },
    async cancelarPedidoVenda(pedidoBlingId: string) {
      if (options.cancelamentoFailure) {
        return { _tag: 'BlingFailed' as const, failure: { _tag: 'BlingProviderFailure' as const, type: 'BAD_REQUEST', status: 400, message: options.cancelamentoFailure, duplicateSale: false } };
      }
      cancelados.push(pedidoBlingId);
      return { _tag: 'BlingOk' as const, value: undefined };
    },
  };

  return port as unknown as FakeBling;
}

function deps(overrides: Partial<ManualOrderDependencies> = {}): ManualOrderDependencies {
  return {
    auth: {
      async authenticate() {
        return { actorId: ACTOR };
      },
      async resolveScope() {
        return { _tag: 'Resolved', scope: scopeA };
      },
    },
    store: fakeStore(),
    bling: fakeBling(),
    now: () => new Date('2026-08-29T15:30:00.000Z'),
    newLocalReference: () => 'ORBITA-REF-1',
    dormir: dormirInstantaneo().dormir,
    ...overrides,
  };
}

function requestWith(body: unknown): Request {
  return new Request('https://orbita.test/api/pedidos/manual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Corpo válido, montado pelo mesmo builder que o modal usa. */
function corpoValido(overrides: Record<string, unknown> = {}) {
  return buildManualOrderRequest({
    syncBling: true,
    clienteId: CLIENTE,
    itens: [{ produtoId: PRODUTO, quantidade: 2 }],
    desconto: 0,
    frete: 0,
    ...overrides,
  });
}

describe('fronteira modal <-> rota do pedido manual', () => {
  it('o corpo montado pelo builder do cliente é aceito pelo schema que a rota executa', () => {
    const corpo = buildManualOrderRequest({
      syncBling: true,
      clienteId: CLIENTE,
      itens: [{ produtoId: PRODUTO, quantidade: 3 }],
      observacoes: 'Venda no balcão',
      formaPagamentoId: 12,
      formaPagamentoRotulo: 'Dinheiro',
    });

    expect(manualOrderRequestSchema.safeParse(corpo).success).toBe(true);
  });

  it('não existe campo total no contrato: o cliente não pode ditar o valor da venda', () => {
    const comTotal = { ...corpoValido(), total: 0.01 };
    const parsed = manualOrderRequestSchema.parse(comTotal);

    expect('total' in parsed).toBe(false);
  });

  it('recusa corpo sem itens em vez de estourar ao iterar', async () => {
    const handler = createManualOrderHandler(deps());
    const response = await handler(requestWith({ syncBling: false, clienteId: CLIENTE }));
    const body = (await response.json()) as ManualOrderResponseBody;

    expect(response.status).toBe(400);
    expect(body.error).toContain('itens');
  });

  it('recusa corpo que não é JSON', async () => {
    const handler = createManualOrderHandler(deps());
    const request = new Request('https://orbita.test/api/pedidos/manual', { method: 'POST', body: 'nao-e-json' });
    const response = await handler(request);

    expect(response.status).toBe(400);
  });
});

describe('fronteira rota <-> API do Bling', () => {
  it('o payload enviado ao Bling satisfaz o schema oficial de POST /pedidos/vendas', async () => {
    const bling = fakeBling();
    const handler = createManualOrderHandler(deps({ bling }));

    const response = await handler(requestWith(corpoValido()));

    expect(response.status).toBe(201);
    expect(bling.payloads).toHaveLength(1);
    expect(pedidoVendaPayloadSchema.safeParse(bling.payloads[0]).success).toBe(true);
  });

  it('envia os campos obrigatórios que a versão anterior omitia', async () => {
    const bling = fakeBling();
    const handler = createManualOrderHandler(deps({ bling }));
    await handler(requestWith(corpoValido()));

    const payload = bling.payloads[0]!;
    expect(payload.data).toBe('2026-08-29');
    expect(payload.dataPrevista).toBe('2026-08-29');
    expect(payload.dataSaida).toBe('2026-08-29');
    expect(payload.parcelas).toHaveLength(1);
    expect(payload.itens[0]!.valorLista).toBe(49.9);
  });

  it('não fixa situacao no payload, porque os ids de situação são por conta', async () => {
    const bling = fakeBling();
    const handler = createManualOrderHandler(deps({ bling }));
    await handler(requestWith(corpoValido()));

    expect('situacao' in bling.payloads[0]!).toBe(false);
  });

  it('usa a forma de pagamento padrão da conta quando o cliente não informa uma', async () => {
    const bling = fakeBling();
    const handler = createManualOrderHandler(deps({ bling }));
    await handler(requestWith(corpoValido()));

    expect(bling.payloads[0]!.parcelas[0]!.formaPagamento.id).toBe(12);
  });

  it('recusa a venda com mensagem clara quando a conta não tem forma de pagamento padrão', async () => {
    const bling = fakeBling({ formaPagamentoFailure: 'Nenhuma forma de pagamento encontrada' });
    const handler = createManualOrderHandler(deps({ bling }));
    const response = await handler(requestWith(corpoValido()));
    const body = (await response.json()) as ManualOrderResponseBody;

    expect(response.status).toBe(400);
    expect(body.error).toContain('forma de pagamento');
  });

  it('dá baixa de estoque pelo endpoint vinculado ao pedido, não por ajuste manual solto', async () => {
    const bling = fakeBling();
    const handler = createManualOrderHandler(deps({ bling }));
    await handler(requestWith(corpoValido()));

    expect(bling.estoqueLancado).toEqual(['918273']);
  });

  it('recusa item sem bling_id numérico com mensagem acionável em vez de deixar o Bling rejeitar', async () => {
    const store = fakeStore({ produtos: [produto({ id: PRODUTO_SEM_BLING, nome: 'Boné', blingId: null })] });
    const handler = createManualOrderHandler(deps({ store }));
    const response = await handler(requestWith(corpoValido({ itens: [{ produtoId: PRODUTO_SEM_BLING, quantidade: 1 }] })));
    const body = (await response.json()) as ManualOrderResponseBody;

    expect(response.status).toBe(400);
    expect(body.error).toContain('Boné');
    expect(body.error).toContain('sincronizados com o Bling');
  });

  it('cadastra o contato no Bling e guarda o id devolvido quando o cliente ainda não tem cadastro', async () => {
    const store = fakeStore({ clientes: { [ORG_A]: cliente({ blingId: null }) } });
    const bling = fakeBling();
    const handler = createManualOrderHandler(deps({ store, bling }));

    await handler(requestWith(corpoValido()));

    expect(store.vinculos).toEqual([{ clienteId: CLIENTE, blingId: '9001' }]);
    expect(bling.payloads[0]!.contato.id).toBe(9001);
  });
});

describe('resultado real da venda', () => {
  it('não grava a venda localmente quando o Bling recusa o pedido', async () => {
    const store = fakeStore();
    const bling = fakeBling({ createFailure: { message: 'Campo obrigatório não informado' } });
    const handler = createManualOrderHandler(deps({ store, bling }));

    const response = await handler(requestWith(corpoValido()));
    const body = (await response.json()) as ManualOrderResponseBody;

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain('Campo obrigatório não informado');
    expect(store.persisted).toHaveLength(0);
  });

  it('sinaliza venda duplicada pelo resultado tipado do provedor', async () => {
    const bling = fakeBling({ createFailure: { message: 'Informações idênticas a última venda salva', duplicateSale: true } });
    const handler = createManualOrderHandler(deps({ bling }));

    const body = (await (await handler(requestWith(corpoValido()))).json()) as ManualOrderResponseBody;

    expect(body.vendaDuplicada).toBe(true);
  });

  it('grava a venda e devolve o id real do Bling, sem inventar identificador', async () => {
    const store = fakeStore();
    const handler = createManualOrderHandler(deps({ store }));

    const body = (await (await handler(requestWith(corpoValido()))).json()) as ManualOrderResponseBody;

    expect(body.success).toBe(true);
    expect(body.blingPedidoId).toBe('918273');
    expect(store.persisted[0]!.blingPedidoId).toBe('918273');
  });

  it('não grava id do Bling quando a venda não foi sincronizada', async () => {
    const store = fakeStore();
    const handler = createManualOrderHandler(deps({ store }));

    const body = (await (await handler(requestWith(corpoValido({ syncBling: false })))).json()) as ManualOrderResponseBody;

    expect(body.blingPedidoId).toBeNull();
    expect(store.persisted[0]!.blingPedidoId).toBeNull();
    expect(store.persisted[0]!.referenciaLocal).toBe('ORBITA-REF-1');
  });

  it('calcula o total no servidor pelos preços do cadastro, aplicando frete e desconto', async () => {
    const store = fakeStore();
    const handler = createManualOrderHandler(deps({ store }));

    const body = (await (await handler(requestWith(corpoValido({ desconto: 9.8, frete: 10 })))).json()) as ManualOrderResponseBody;

    // 2 x 49.90 = 99.80, + 10 de frete, - 9.80 de desconto
    expect(body.total).toBe(100);
    expect(store.persisted[0]!.total).toBe(100);
  });

  it('reporta a falha da baixa de estoque como aviso, sem mascarar e sem invalidar a venda', async () => {
    const store = fakeStore();
    const bling = fakeBling({ estoqueFailure: 'Depósito padrão não configurado' });
    const handler = createManualOrderHandler(deps({ store, bling }));

    const response = await handler(requestWith(corpoValido()));
    const body = (await response.json()) as ManualOrderResponseBody;

    expect(response.status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.avisos?.join(' ')).toContain('Depósito padrão não configurado');
    expect(store.persisted).toHaveLength(1);
  });

  it('repassa os alertas devolvidos pelo Bling na criação', async () => {
    const bling = fakeBling({ alertas: ['Preço abaixo do mínimo'] });
    const handler = createManualOrderHandler(deps({ bling }));

    const body = (await (await handler(requestWith(corpoValido()))).json()) as ManualOrderResponseBody;

    expect(body.avisos?.join(' ')).toContain('Preço abaixo do mínimo');
  });

  it('cancela o pedido no Bling quando a gravação local falha DEFINITIVAMENTE', async () => {
    // O efeito remoto acontece antes da gravação local e não há como inverter
    // a ordem: o `bling_id` só existe depois da criação. Sem compensar, cada
    // tentativa deixa um pedido órfão na conta real do lojista — aconteceu
    // com o pedido 26735607230 em 2026-08-30.
    //
    // "Definitiva" aqui: o banco RESPONDEU com um erro estruturado
    // (violação de NOT NULL) — a transação já foi revertida, não há
    // ambiguidade nenhuma para resolver antes de compensar.
    const store = fakeStore({ persistDefinitiveError: new Error('null value in column "user_id"') });
    const bling = fakeBling();
    const handler = createManualOrderHandler(deps({ store, bling }));

    const response = await handler(requestWith(corpoValido()));
    const body = (await response.json()) as ManualOrderResponseBody;

    expect(response.status).toBe(500);
    expect(bling.cancelados).toEqual(['918273']);
    expect(body.compensado).toBe(true);
    expect(body.error).toContain('cancelado no Bling');
    expect(body.error).toContain('Pode tentar de novo');
  });

  it('quando o cancelamento também falha, diz o que precisa ser feito à mão — e NÃO grava falhou, grava indeterminada', async () => {
    // 4ª rodada de revisão — a máquina de estados. "Persistência falhou
    // definitivamente" NÃO prova "nada ficou pendente no Bling": a
    // compensação é uma chamada PRÓPRIA, com resultado PRÓPRIO. Se ela
    // também falha, o Bling pode ter um pedido pendente que ninguém
    // confirmou cancelado — a referência tem de ficar bloqueada
    // ('indeterminada'), não liberada para reabrir ('falhou').
    const store = fakeStore({ persistDefinitiveError: new Error('null value in column "user_id"') });
    const bling = fakeBling({ cancelamentoFailure: 'pedido já faturado' });
    const handler = createManualOrderHandler(deps({ store, bling }));

    const response = await handler(requestWith(corpoValido()));
    const body = (await response.json()) as ManualOrderResponseBody;

    expect(response.status).toBe(500);
    expect(bling.cancelados).toEqual([]);
    expect(body.compensado).toBe(false);
    expect(body.error).toContain('918273');
    expect(body.error).toContain('pedido já faturado');
    // A instrução precisa ser explícita: retentar sem limpar cria outro pedido.
    expect(body.error).toContain('Cancele o pedido no Bling');
    // O ponto central do teste: o desfecho gravado é 'indeterminada', não
    // 'falhou' — é isso que impede a referência de ser reaberta.
    expect(store.desfechosRegistrados).toEqual([{ estado: 'indeterminada', blingPedidoId: '918273' }]);
  });

  it('uma retentativa com a MESMA referência, depois de persistência+compensação terem falhado, NÃO chama createPedidoVenda de novo', async () => {
    // A continuação direta do teste acima: uma retentativa reivindica a
    // MESMA referência e encontra o estado 'indeterminada' que o teste
    // anterior provou ser gravado — e por isso nunca chega perto do Bling.
    const store = fakeStore({
      reivindicacaoForcada: { _tag: 'TentativaIndeterminada', blingPedidoId: '918273' },
    });
    const bling = fakeBling();
    const handler = createManualOrderHandler(deps({ store, bling }));

    const response = await handler(requestWith(corpoValido()));
    const body = (await response.json()) as ManualOrderResponseBody;

    expect(response.status).toBe(500);
    expect(body.estadoIndeterminado).toBe(true);
    // O ponto central: nenhuma chamada nova ao Bling — nem criação, nem
    // cancelamento. A referência ficou bloqueada de verdade.
    expect(bling.payloads).toHaveLength(0);
    expect(bling.cancelados).toEqual([]);
  });

  it('sem envio ao Bling não há o que compensar', async () => {
    const store = fakeStore({ persistDefinitiveError: new Error('banco fora do ar') });
    const bling = fakeBling();
    const handler = createManualOrderHandler(deps({ store, bling }));

    const response = await handler(requestWith({ ...corpoValido(), syncBling: false }));
    const body = (await response.json()) as ManualOrderResponseBody;

    expect(response.status).toBe(500);
    expect(bling.cancelados).toEqual([]);
    expect(body.compensado).toBeUndefined();
  });

  describe('ticket 30, fatia 3 — retentativa depois de resposta AMBÍGUA (sem resposta do servidor)', () => {
    it('NÃO cancela no Bling quando a venda já existia na primeira leitura — commit aconteceu, só o ACK se perdeu', async () => {
      // `persistVenda` devolve `PersistVendaAmbigua` (ex.: a conexão caiu
      // depois do commit do Postgres e antes da resposta chegar ao Node), mas
      // a venda JÁ EXISTE, completa. Compensar cancelaria no Bling uma venda
      // real.
      const store = fakeStore({
        persistAmbiguousError: new Error('conexão perdida depois do commit'),
        vendaJaRegistradaPedidoId: 'pedido-ja-registrado-1',
      });
      const bling = fakeBling();
      const dormirRegistrado = dormirInstantaneo();
      const handler = createManualOrderHandler(deps({ store, bling, dormir: dormirRegistrado.dormir }));

      const response = await handler(requestWith(corpoValido()));
      const body = (await response.json()) as ManualOrderResponseBody;

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.pedidoId).toBe('pedido-ja-registrado-1');
      expect(body.blingPedidoId).toBe('918273');
      // O ponto inteiro do teste: nada foi cancelado no Bling.
      expect(bling.cancelados).toEqual([]);
      expect(body.avisos?.join(' ')).toContain('já havia sido registrada');
    });

    it('NÃO cancela quando a venda só aparece DEPOIS da primeira leitura — prova que a janela de retentativa é usada, não só a primeira checagem', async () => {
      // Reproduz o interleaving que uma checagem única não distingue: no
      // instante do erro a transação AINDA estava em voo. Ela só commita
      // durante a janela de confirmação — a 3ª tentativa é a primeira que a
      // encontra. Uma implementação com checagem única (sem retentativa)
      // veria "não encontrada" na 1ª tentativa e compensaria cedo demais.
      const store = fakeStore({
        persistAmbiguousError: new Error('timeout de rede'),
        vendaJaRegistradaPedidoId: 'pedido-em-voo-1',
        vendaApareceNaTentativa: 3,
      });
      const bling = fakeBling();
      const dormirRegistrado = dormirInstantaneo();
      const handler = createManualOrderHandler(deps({ store, bling, dormir: dormirRegistrado.dormir }));

      const response = await handler(requestWith(corpoValido()));
      const body = (await response.json()) as ManualOrderResponseBody;

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.pedidoId).toBe('pedido-em-voo-1');
      expect(bling.cancelados).toEqual([]);
      // Esperou pelo menos duas vezes antes de achar na 3ª tentativa.
      expect(dormirRegistrado.chamadas.length).toBeGreaterThanOrEqual(2);
    });

    it('NÃO compensa quando a ambiguidade nunca se resolve — reporta estado indeterminado em vez de adivinhar', async () => {
      // A venda nunca aparece, mesmo depois de esgotada a janela de
      // confirmação. Isso NÃO prova que ela falhou — só que não deu para
      // confirmar dentro do tempo dado. Compensar aqui poderia cancelar uma
      // venda que commita um instante depois da última tentativa.
      const store = fakeStore({ persistAmbiguousError: new Error('timeout de rede') });
      const bling = fakeBling();
      const dormirRegistrado = dormirInstantaneo();
      const handler = createManualOrderHandler(deps({ store, bling, dormir: dormirRegistrado.dormir }));

      const response = await handler(requestWith(corpoValido()));
      const body = (await response.json()) as ManualOrderResponseBody;

      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.estadoIndeterminado).toBe(true);
      expect(body.compensado).toBeUndefined();
      // O ponto inteiro do teste: NUNCA cancela no Bling num estado ambíguo
      // não resolvido.
      expect(bling.cancelados).toEqual([]);
      expect(body.error).toContain('NÃO tente de novo');
      expect(body.error).toContain('NÃO cancele o pedido no Bling');
    });
  });
});

describe('escopo por organização', () => {
  it('a persistência carrega o escopo verificado, nunca um organizacao_id vindo do cliente', async () => {
    const store = fakeStore();
    const handler = createManualOrderHandler(deps({ store }));

    await handler(requestWith({ ...corpoValido(), organizacaoId: ORG_B }));

    expect(store.persisted[0]!.scope.organizationId).toBe(ORG_A);
  });

  it('não alcança produtos de outra organização', async () => {
    const scopeB = scopeFor(ORG_B);
    const store = fakeStore();
    const handler = createManualOrderHandler(
      deps({
        store,
        auth: {
          async authenticate() {
            return { actorId: ACTOR };
          },
          async resolveScope() {
            return { _tag: 'Resolved', scope: scopeB };
          },
        },
      }),
    );

    const response = await handler(requestWith(corpoValido()));

    expect(response.status).toBe(400);
    expect(store.persisted).toHaveLength(0);
  });

  it('recusa sem sessão verificada', async () => {
    const handler = createManualOrderHandler(
      deps({
        auth: {
          async authenticate() {
            return null;
          },
          async resolveScope() {
            return { _tag: 'Resolved', scope: scopeA };
          },
        },
      }),
    );

    expect((await handler(requestWith(corpoValido()))).status).toBe(401);
  });
});

describe('estoque local', () => {
  it('recusa quantidade acima do disponível', async () => {
    const store = fakeStore({ produtos: [produto({ estoqueDisponivel: 1 })] });
    const handler = createManualOrderHandler(deps({ store }));

    const response = await handler(requestWith(corpoValido({ itens: [{ produtoId: PRODUTO, quantidade: 5 }] })));
    const body = (await response.json()) as ManualOrderResponseBody;

    expect(response.status).toBe(400);
    expect(body.error).toContain('Estoque insuficiente');
    expect(store.persisted).toHaveLength(0);
  });

  it('recusa o mesmo produto repetido em itens diferentes', async () => {
    const handler = createManualOrderHandler(deps());
    const response = await handler(
      requestWith({ ...corpoValido(), itens: [{ produtoId: PRODUTO, quantidade: 1 }, { produtoId: PRODUTO, quantidade: 1 }] }),
    );

    expect(response.status).toBe(400);
  });
});

// Ticket 30, fatia 3, 3ª rodada — a retentativa não pode virar duplicação
// externa. O ponto central de cada teste abaixo é `bling.payloads` continuar
// vazio ou com length 1: uma retentativa reconhecida pela mesma
// `referenciaLocal` nunca chama `createPedidoVenda` de novo.
describe('idempotência entre retentativas da mesma submissão (referenciaLocal)', () => {
  it('uma tentativa já CONCLUÍDA devolve sucesso sem chamar o Bling de novo', async () => {
    const store = fakeStore({
      reivindicacaoForcada: { _tag: 'TentativaConcluida', pedidoId: 'pedido-anterior-1', blingPedidoId: '918273' },
    });
    const bling = fakeBling();
    const handler = createManualOrderHandler(deps({ store, bling }));

    const response = await handler(requestWith(corpoValido()));
    const body = (await response.json()) as ManualOrderResponseBody;

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.pedidoId).toBe('pedido-anterior-1');
    expect(body.blingPedidoId).toBe('918273');
    // O ponto do teste: nenhuma criação nova no Bling.
    expect(bling.payloads).toHaveLength(0);
    expect(store.persisted).toHaveLength(0);
  });

  it('uma tentativa já INDETERMINADA devolve o mesmo estado sem chamar o Bling de novo', async () => {
    const store = fakeStore({
      reivindicacaoForcada: { _tag: 'TentativaIndeterminada', blingPedidoId: '918273' },
    });
    const bling = fakeBling();
    const handler = createManualOrderHandler(deps({ store, bling }));

    const response = await handler(requestWith(corpoValido()));
    const body = (await response.json()) as ManualOrderResponseBody;

    expect(response.status).toBe(500);
    expect(body.estadoIndeterminado).toBe(true);
    expect(body.compensado).toBeUndefined();
    // O ponto do teste: a retentativa NÃO cria um segundo pedido no Bling —
    // é exatamente isso que transformaria "compensação destrutiva" em
    // "duplicação externa".
    expect(bling.payloads).toHaveLength(0);
    expect(bling.cancelados).toEqual([]);
    expect(store.persisted).toHaveLength(0);
  });

  it('uma tentativa já EM ANDAMENTO (concorrente) recusa com 409 sem chamar o Bling', async () => {
    const store = fakeStore({ reivindicacaoForcada: { _tag: 'TentativaEmAndamento' } });
    const bling = fakeBling();
    const handler = createManualOrderHandler(deps({ store, bling }));

    const response = await handler(requestWith(corpoValido()));

    expect(response.status).toBe(409);
    expect(bling.payloads).toHaveLength(0);
    expect(store.persisted).toHaveLength(0);
  });

  it('FAIL CLOSED: quando a reivindicação está indisponível (ex.: migration 59 não aplicada), recusa com 503 sem chamar o Bling', async () => {
    // 4ª rodada de revisão — o bloqueante principal. A versão anterior via
    // "infraestrutura de idempotência ausente" e concluía "prossiga sem
    // proteção" (TentativaNova). Isso desligava silenciosamente a garantia
    // bem na janela em que ela mais importa: código novo, banco sem a
    // migration 59. Agora: sem conseguir reivindicar, a venda NÃO PROSSEGUE.
    const store = fakeStore({
      reivindicacaoForcada: { _tag: 'TentativaIndisponivel', causa: new Error('relation "tentativas_venda_manual" does not exist') },
    });
    const bling = fakeBling();
    const handler = createManualOrderHandler(deps({ store, bling }));

    const response = await handler(requestWith(corpoValido()));
    const body = (await response.json()) as ManualOrderResponseBody;

    expect(response.status).toBe(503);
    expect(body.success).toBe(false);
    // O ponto central do teste: NENHUMA chamada ao Bling — nem de criação
    // nem de cancelamento — quando a proteção não pôde ser confirmada.
    expect(bling.payloads).toHaveLength(0);
    expect(bling.cancelados).toEqual([]);
    expect(store.persisted).toHaveLength(0);
  });

  it('uma tentativa NOVA prossegue normalmente e registra o desfecho concluída', async () => {
    const store = fakeStore();
    const bling = fakeBling();
    const handler = createManualOrderHandler(deps({ store, bling }));

    const response = await handler(requestWith(corpoValido()));
    expect(response.status).toBe(201);
    expect(bling.payloads).toHaveLength(1);
    expect(store.desfechosRegistrados).toEqual([
      { estado: 'concluida', pedidoId: 'pedido-local-1', blingPedidoId: '918273' },
    ]);
  });

  it('uma falha DEFINITIVA registra o desfecho falhou, para que a mesma referência possa ser reaberta depois', async () => {
    const store = fakeStore({ persistDefinitiveError: new Error('null value in column "user_id"') });
    const bling = fakeBling();
    const handler = createManualOrderHandler(deps({ store, bling }));

    await handler(requestWith(corpoValido()));

    expect(store.desfechosRegistrados).toEqual([{ estado: 'falhou', blingPedidoId: '918273' }]);
  });

  it('uma ambiguidade NUNCA resolvida registra o desfecho indeterminada', async () => {
    const store = fakeStore({ persistAmbiguousError: new Error('timeout de rede') });
    const bling = fakeBling();
    const handler = createManualOrderHandler(deps({ store, bling, dormir: dormirInstantaneo().dormir }));

    await handler(requestWith(corpoValido()));

    expect(store.desfechosRegistrados).toEqual([{ estado: 'indeterminada', blingPedidoId: '918273' }]);
  });
});

describe('ticket 30, fatia 3 — 5ª rodada: a criação no Bling pode ter acontecido sem ACK', () => {
  it('createPedidoVenda LANÇA (timeout): a tentativa fica indeterminada, NÃO falhou', async () => {
    const store = fakeStore();
    const bling = fakeBling({ createThrows: new Error('ETIMEDOUT: socket hang up') });
    const handler = createManualOrderHandler(deps({ store, bling }));

    const resposta = await handler(requestWith(corpoValido()));
    const corpo = (await resposta.json()) as ManualOrderResponseBody;

    expect(resposta.status).toBe(500);
    expect(corpo.estadoIndeterminado).toBe(true);
    // O ponto: `falhou` é REABRÍVEL, e reabrir aqui deixaria a retentativa
    // criar um segundo pedido para uma venda que pode já existir no ERP.
    expect(store.desfechosRegistrados).toEqual([{ estado: 'indeterminada' }]);
    // Não inventa um id que nunca chegou, e não tenta cancelar o que não
    // sabe identificar.
    expect(corpo.blingPedidoId).toBeNull();
    expect(bling.cancelados).toEqual([]);
    // E a venda NÃO foi gravada localmente.
    expect(store.persisted).toHaveLength(0);
  });

  describe('6ª rodada — TODA falha sem prova contratual de ausência de efeito grava indeterminada', () => {
    it.each([
      ['429 — limitação de taxa; o contrato não prova que não processou', { message: 'Too many requests', status: 429, type: 'TOO_MANY_REQUESTS' }],
      ['4xx com type não reconhecido', { message: 'Recusa desconhecida', status: 400, type: 'ALGUM_TIPO_NOVO' }],
      ['4xx sem o envelope da v3 (type vira HTTP_<status>)', { message: 'texto solto', status: 400, type: 'HTTP_400' }],
      ['404 RESOURCE_NOT_FOUND', { message: 'não encontrado', status: 404, type: 'RESOURCE_NOT_FOUND' }],
      ['408', { message: 'request timeout', status: 408, type: 'HTTP_408' }],
      ['502', { message: 'Bad gateway', status: 502, type: 'HTTP_502' }],
      ['2xx com id ilegível — o pedido existe e não sabemos qual é', { message: 'sem id', status: 201, type: 'INVALID_RESPONSE' }],
    ])('%s', async (_descricao, createFailure) => {
      const store = fakeStore();
      const bling = fakeBling({ createFailure });
      const handler = createManualOrderHandler(deps({ store, bling }));

      const resposta = await handler(requestWith(corpoValido()));
      const corpo = (await resposta.json()) as ManualOrderResponseBody;

      expect(store.desfechosRegistrados).toEqual([{ estado: 'indeterminada' }]);
      expect(corpo.estadoIndeterminado).toBe(true);
      // Nada foi gravado localmente e nada foi cancelado: sem `bling_id`, não
      // há o que cancelar — e cancelar às cegas seria pior.
      expect(store.persisted).toHaveLength(0);
      expect(bling.cancelados).toEqual([]);
    });
  });

  it('o Bling RECUSA com 400: aí sim falhou (reabrível) — nada foi criado, e retentar é seguro', async () => {
    const store = fakeStore();
    const bling = fakeBling({ createFailure: { message: 'Produto inválido', status: 400, type: 'VALIDATION_ERROR' } });
    const handler = createManualOrderHandler(deps({ store, bling }));

    const resposta = await handler(requestWith(corpoValido()));

    expect(resposta.status).toBe(400);
    expect(store.desfechosRegistrados).toEqual([{ estado: 'falhou' }]);
  });
});

describe('ticket 30, fatia 3 — 5ª rodada: a chave de idempotência carrega o conteúdo da venda', () => {
  it('o fingerprint reivindicado é derivado do corpo, e vendas diferentes produzem fingerprints diferentes', async () => {
    const storeA = fakeStore();
    const handlerA = createManualOrderHandler(deps({ store: storeA, bling: fakeBling() }));
    await handlerA(requestWith(corpoValido()));

    const storeB = fakeStore();
    const handlerB = createManualOrderHandler(deps({ store: storeB, bling: fakeBling() }));
    await handlerB(requestWith(corpoValido({ itens: [{ produtoId: PRODUTO, quantidade: 3 }] })));

    expect(storeA.fingerprintsReivindicados).toHaveLength(1);
    expect(storeA.fingerprintsReivindicados[0]).toMatch(/^[0-9a-f]{64}$/u);
    expect(storeB.fingerprintsReivindicados[0]).not.toBe(storeA.fingerprintsReivindicados[0]);
  });

  it('a MESMA venda produz o MESMO fingerprint — uma retentativa legítima não vira conflito', async () => {
    const storeA = fakeStore();
    await createManualOrderHandler(deps({ store: storeA, bling: fakeBling() }))(requestWith(corpoValido()));
    const storeB = fakeStore();
    await createManualOrderHandler(deps({ store: storeB, bling: fakeBling() }))(requestWith(corpoValido()));

    expect(storeB.fingerprintsReivindicados[0]).toBe(storeA.fingerprintsReivindicados[0]);
  });

  it('CONFLITO: a referência já pertence a outra venda — 409 e ZERO chamadas ao Bling', async () => {
    const store = fakeStore({ reivindicacaoForcada: { _tag: 'TentativaConflitante' } });
    const bling = fakeBling();
    const handler = createManualOrderHandler(deps({ store, bling }));

    const resposta = await handler(requestWith(corpoValido()));
    const corpo = (await resposta.json()) as ManualOrderResponseBody;

    expect(resposta.status).toBe(409);
    expect(corpo.success).toBe(false);
    // Não devolve o desfecho da OUTRA operação — dizer "já registrada" aqui
    // afirmaria que esta venda existe, e ela nunca existiu.
    expect(corpo.pedidoId).toBeUndefined();
    expect(bling.payloads).toHaveLength(0);
    expect(bling.cancelados).toEqual([]);
    expect(store.persisted).toHaveLength(0);
    // E não grava desfecho nenhum: a tentativa que existe é da outra venda, e
    // não é desta submissão o direito de concluí-la.
    expect(store.desfechosRegistrados).toEqual([]);
  });
});
