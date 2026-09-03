import { describe, expect, it } from 'vitest';

import {
  createManualOrderHandler,
  type ManualOrderBlingPort,
  type ManualOrderCliente,
  type ManualOrderDependencies,
  type ManualOrderProduto,
  type ManualOrderResponseBody,
  type ManualOrderStorePort,
  type PersistManualOrderInput,
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
}

function fakeStore(options: {
  clientes?: Record<string, ManualOrderCliente>;
  produtos?: ManualOrderProduto[];
  persistError?: Error;
  /**
   * Ticket 30, fatia 3 — simula a venda que `persistVenda` reporta como falha
   * mas que, na verdade, já foi commitada (confirmação perdida entre o banco
   * e o Node). Quando definido, `findVendaManualJaRegistrada` devolve este
   * `pedidoId` em vez de `null`.
   */
  vendaJaRegistradaPedidoId?: string;
} = {}): FakeStore {
  const clientesPorOrg = options.clientes ?? { [ORG_A]: cliente() };
  const produtos = options.produtos ?? [produto()];
  const persisted: PersistManualOrderInput[] = [];
  const vinculos: Array<{ clienteId: string; blingId: string }> = [];

  return {
    persisted,
    vinculos,
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
      if (options.persistError) throw options.persistError;
      persisted.push(input);
      return { pedidoId: 'pedido-local-1' };
    },
    async findVendaManualJaRegistrada() {
      return options.vendaJaRegistradaPedidoId ? { pedidoId: options.vendaJaRegistradaPedidoId } : null;
    },
  };
}

interface FakeBling extends ManualOrderBlingPort {
  readonly payloads: PedidoVendaPayload[];
  readonly estoqueLancado: string[];
  readonly contatosCriados: number;
  /** Pedidos que a compensacao mandou cancelar no Bling. */
  readonly cancelados: string[];
}

function fakeBling(options: {
  createFailure?: { message: string; duplicateSale?: boolean };
  estoqueFailure?: string;
  formaPagamentoFailure?: string;
  alertas?: string[];
  cancelamentoFailure?: string;
} = {}): FakeBling {
  const payloads: PedidoVendaPayload[] = [];
  const estoqueLancado: string[] = [];
  const cancelados: string[] = [];
  let contatosCriados = 0;

  const port = {
    payloads,
    estoqueLancado,
    cancelados,
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
      if (options.createFailure) {
        return {
          _tag: 'BlingFailed' as const,
          failure: {
            _tag: 'BlingProviderFailure' as const,
            type: 'VALIDATION_ERROR',
            status: 400,
            message: options.createFailure.message,
            duplicateSale: options.createFailure.duplicateSale ?? false,
          },
        };
      }
      return { _tag: 'BlingOk' as const, value: { id: '918273', alertas: options.alertas ?? [] } };
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

  it('cancela o pedido no Bling quando a gravação local falha', async () => {
    // O efeito remoto acontece antes da gravação local e não há como inverter
    // a ordem: o `bling_id` só existe depois da criação. Sem compensar, cada
    // tentativa deixa um pedido órfão na conta real do lojista — aconteceu
    // com o pedido 26735607230 em 2026-08-30.
    const store = fakeStore({ persistError: new Error('null value in column "user_id"') });
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

  it('quando o cancelamento também falha, diz o que precisa ser feito à mão', async () => {
    const store = fakeStore({ persistError: new Error('null value in column "user_id"') });
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
  });

  it('sem envio ao Bling não há o que compensar', async () => {
    const store = fakeStore({ persistError: new Error('banco fora do ar') });
    const bling = fakeBling();
    const handler = createManualOrderHandler(deps({ store, bling }));

    const response = await handler(requestWith({ ...corpoValido(), syncBling: false }));
    const body = (await response.json()) as ManualOrderResponseBody;

    expect(response.status).toBe(500);
    expect(bling.cancelados).toEqual([]);
    expect(body.compensado).toBeUndefined();
  });

  // Ticket 30, fatia 3 — retentativa depois de resposta perdida.
  it('NÃO cancela no Bling quando a venda já havia sido registrada — a falha era só de confirmação', async () => {
    // `persistVenda` lança (ex.: a conexão caiu entre o commit do Postgres e a
    // resposta chegar ao Node), mas a venda JÁ EXISTE, completa, gravada por
    // essa mesma tentativa. Compensar aqui cancelaria no Bling uma venda real.
    const store = fakeStore({
      persistError: new Error('conexão perdida depois do commit'),
      vendaJaRegistradaPedidoId: 'pedido-ja-registrado-1',
    });
    const bling = fakeBling();
    const handler = createManualOrderHandler(deps({ store, bling }));

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
