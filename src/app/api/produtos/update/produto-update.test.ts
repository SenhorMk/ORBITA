import { describe, expect, it } from 'vitest';

import {
  createProdutoUpdateHandler,
  type ProdutoBlingPayload,
  type ProdutoBlingPort,
  type ProdutoDependencies,
  type ProdutoResponseBody,
  type ProdutoStorePort,
} from './handler';
import { buildProdutoRequest, produtoRequestSchema } from '@/lib/config/produtoContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

const ORG = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const PRODUTO_LOCAL = '33333333-3333-4333-8333-333333333333';

/**
 * SAFETY: o escopo é entrada do teste, não o que está sob teste — mesma
 * convenção de `invitationService.test.ts` e do teste do pedido manual.
 */
const scope = { organizationId: ORG, actorId: ACTOR, role: 'owner' } as unknown as VerifiedOrganizationScope;

interface FakeBling extends ProdutoBlingPort {
  readonly buscas: string[];
  readonly criados: ProdutoBlingPayload[];
  readonly atualizados: Array<{ id: string; payload: ProdutoBlingPayload }>;
  readonly saldos: Array<{ id: string; quantidade: number }>;
}

function fakeBling(options: {
  encontrarPorCodigo?: { id: string; codigo: string | null } | null;
  falhaBusca?: string;
  falhaCriar?: string;
  falhaAtualizar?: string;
  falhaSaldo?: string;
} = {}): FakeBling {
  const buscas: string[] = [];
  const criados: ProdutoBlingPayload[] = [];
  const atualizados: Array<{ id: string; payload: ProdutoBlingPayload }> = [];
  const saldos: Array<{ id: string; quantidade: number }> = [];

  const falha = (message: string) => ({
    _tag: 'BlingFailed' as const,
    failure: { _tag: 'BlingProviderFailure' as const, type: 'VALIDATION_ERROR', status: 400, message, duplicateSale: false },
  });

  return {
    buscas,
    criados,
    atualizados,
    saldos,
    async buscarPorCodigo(codigo: string) {
      buscas.push(codigo);
      if (options.falhaBusca) return falha(options.falhaBusca);
      return { _tag: 'BlingOk' as const, value: options.encontrarPorCodigo ?? null };
    },
    async criar(payload: ProdutoBlingPayload) {
      if (options.falhaCriar) return falha(options.falhaCriar);
      criados.push(payload);
      return { _tag: 'BlingOk' as const, value: { id: '4242' } };
    },
    async atualizar(id: string, payload: ProdutoBlingPayload) {
      if (options.falhaAtualizar) return falha(options.falhaAtualizar);
      atualizados.push({ id, payload });
      return { _tag: 'BlingOk' as const, value: undefined };
    },
    async definirSaldo(id: string, quantidade: number) {
      if (options.falhaSaldo) return falha(options.falhaSaldo);
      saldos.push({ id, quantidade });
      return { _tag: 'BlingOk' as const, value: undefined };
    },
  };
}

interface FakeStore extends ProdutoStorePort {
  readonly gravados: Array<Record<string, unknown>>;
}

function fakeStore(options: { erro?: Error } = {}): FakeStore {
  const gravados: Array<Record<string, unknown>> = [];
  return {
    gravados,
    async upsert(_scope, produto) {
      if (options.erro) throw options.erro;
      gravados.push({ ...produto });
      return {
        id: produto.id ?? PRODUTO_LOCAL,
        blingId: produto.blingId,
        nome: produto.nome,
        codigo: produto.codigo,
        preco: produto.preco,
        estoque: produto.estoque,
      };
    },
  };
}

function deps(overrides: Partial<ProdutoDependencies> = {}): ProdutoDependencies {
  return {
    auth: { async authorize() { return { _tag: 'Authorized', scope }; } },
    bling: fakeBling(),
    store: fakeStore(),
    ...overrides,
  };
}

function requisicao(corpo: unknown): Request {
  return new Request('https://orbita.test/api/produtos/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

function corpoValido(overrides: Record<string, unknown> = {}) {
  return buildProdutoRequest({ nome: 'Camiseta', preco: 49.9, ...overrides });
}

describe('fronteira formulário <-> rota do produto', () => {
  it('o corpo montado pelo builder do cliente é aceito pelo schema que a rota executa', () => {
    const corpo = buildProdutoRequest({
      nome: 'Camiseta', codigo: 'CAM-01', preco: 49.9, estoque: 10, tipo: 'P', situacao: 'A', formato: 'S', unidade: 'UN',
    });

    expect(produtoRequestSchema.safeParse(corpo).success).toBe(true);
  });

  it('recusa um blingId que não é id numérico do Bling', async () => {
    const handler = createProdutoUpdateHandler(deps());
    const resposta = await handler(requisicao({ nome: 'X', preco: 1, blingId: 'LOCAL-1700000000000' }));
    const corpo = (await resposta.json()) as ProdutoResponseBody;

    expect(resposta.status).toBe(400);
    expect(corpo.error).toContain('blingId');
  });

  it('recusa preço negativo em vez de cair silenciosamente para zero', async () => {
    const handler = createProdutoUpdateHandler(deps());
    const resposta = await handler(requisicao({ nome: 'X', preco: -5 }));

    expect(resposta.status).toBe(400);
  });

  it('recusa corpo que não é JSON', async () => {
    const handler = createProdutoUpdateHandler(deps());
    const resposta = await handler(new Request('https://orbita.test/api/produtos/update', { method: 'POST', body: 'x' }));

    expect(resposta.status).toBe(400);
  });
});

describe('busca por SKU antes de criar', () => {
  it('cria o produto quando nenhum código bate — nunca atualiza um produto não relacionado', async () => {
    // Este é o teste do bug destrutivo: o filtro `codigo` não existia em
    // `GET /produtos`, o Bling devolvia o primeiro produto da conta, e o
    // código tratava isso como "já existe" e sobrescrevia com PUT.
    const bling = fakeBling({ encontrarPorCodigo: null });
    const handler = createProdutoUpdateHandler(deps({ bling }));

    const resposta = await handler(requisicao(corpoValido({ codigo: 'NAO-EXISTE' })));

    expect(resposta.status).toBe(200);
    expect(bling.atualizados).toHaveLength(0);
    expect(bling.criados).toHaveLength(1);
  });

  it('atualiza somente quando o código do resultado bate exatamente', async () => {
    const bling = fakeBling({ encontrarPorCodigo: { id: '999', codigo: 'CAM-01' } });
    const handler = createProdutoUpdateHandler(deps({ bling }));

    const resposta = await handler(requisicao(corpoValido({ codigo: 'CAM-01' })));
    const corpo = (await resposta.json()) as ProdutoResponseBody;

    expect(bling.atualizados).toEqual([{ id: '999', payload: expect.objectContaining({ codigo: 'CAM-01' }) }]);
    expect(bling.criados).toHaveLength(0);
    expect(corpo.avisos?.join(' ')).toContain('já existia no Bling');
  });

  it('não procura por SKU quando nenhum código foi informado', async () => {
    const bling = fakeBling();
    const handler = createProdutoUpdateHandler(deps({ bling }));

    await handler(requisicao(corpoValido()));

    expect(bling.buscas).toHaveLength(0);
  });

  it('recusa a operação quando a consulta ao Bling falha, em vez de seguir criando', async () => {
    const bling = fakeBling({ falhaBusca: 'Rate limit' });
    const store = fakeStore();
    const handler = createProdutoUpdateHandler(deps({ bling, store }));

    const resposta = await handler(requisicao(corpoValido({ codigo: 'CAM-01' })));

    expect(resposta.status).toBe(400);
    expect(bling.criados).toHaveLength(0);
    expect(store.gravados).toHaveLength(0);
  });
});

describe('SKU nunca é inventado', () => {
  it('não envia codigo ao Bling quando o usuário não informou', async () => {
    const bling = fakeBling();
    const handler = createProdutoUpdateHandler(deps({ bling }));

    await handler(requisicao(corpoValido()));

    expect(bling.criados[0]).not.toHaveProperty('codigo');
  });

  it('grava localmente o mesmo código enviado ao Bling', async () => {
    const bling = fakeBling();
    const store = fakeStore();
    const handler = createProdutoUpdateHandler(deps({ bling, store }));

    await handler(requisicao(corpoValido({ codigo: 'CAM-01' })));

    expect(bling.criados[0]!.codigo).toBe('CAM-01');
    expect(store.gravados[0]!.codigo).toBe('CAM-01');
  });
});

describe('o Bling é a fonte da verdade', () => {
  it('não grava localmente quando o Bling recusa o cadastro', async () => {
    const bling = fakeBling({ falhaCriar: 'Campo obrigatório não informado' });
    const store = fakeStore();
    const handler = createProdutoUpdateHandler(deps({ bling, store }));

    const resposta = await handler(requisicao(corpoValido()));
    const corpo = (await resposta.json()) as ProdutoResponseBody;

    expect(resposta.status).toBe(400);
    expect(corpo.error).toContain('Campo obrigatório não informado');
    expect(store.gravados).toHaveLength(0);
  });

  it('grava localmente o id real devolvido pelo Bling, sem inventar identificador', async () => {
    const store = fakeStore();
    const handler = createProdutoUpdateHandler(deps({ store }));

    const corpo = (await (await handler(requisicao(corpoValido()))).json()) as ProdutoResponseBody;

    expect(corpo.product?.blingId).toBe('4242');
    expect(store.gravados[0]!.blingId).toBe('4242');
  });

  it('aplica o saldo por lançamento de estoque, não pelo payload do produto', async () => {
    const bling = fakeBling();
    const handler = createProdutoUpdateHandler(deps({ bling }));

    await handler(requisicao(corpoValido({ estoque: 15 })));

    expect(bling.saldos).toEqual([{ id: '4242', quantidade: 15 }]);
    expect(bling.criados[0]).not.toHaveProperty('estoque');
  });

  it('reporta a falha do saldo como aviso, sem invalidar o produto já criado', async () => {
    const bling = fakeBling({ falhaSaldo: 'Depósito padrão não configurado' });
    const store = fakeStore();
    const handler = createProdutoUpdateHandler(deps({ bling, store }));

    const resposta = await handler(requisicao(corpoValido({ estoque: 15 })));
    const corpo = (await resposta.json()) as ProdutoResponseBody;

    expect(resposta.status).toBe(200);
    expect(corpo.avisos?.join(' ')).toContain('Depósito padrão não configurado');
    expect(store.gravados).toHaveLength(1);
  });

  it('avisa que o produto já existe no Bling quando a gravação local falha', async () => {
    const store = fakeStore({ erro: new Error('conexão perdida') });
    const handler = createProdutoUpdateHandler(deps({ store }));

    const resposta = await handler(requisicao(corpoValido()));
    const corpo = (await resposta.json()) as ProdutoResponseBody;

    expect(resposta.status).toBe(500);
    expect(corpo.error).toContain('4242');
    expect(corpo.error).toContain('Sincronize o catálogo');
  });
});

describe('autorização', () => {
  it('recusa sem tocar no Bling quando a capacidade é insuficiente', async () => {
    const bling = fakeBling();
    const handler = createProdutoUpdateHandler(deps({
      bling,
      auth: {
        async authorize() {
          return {
            _tag: 'Denied',
            response: new Response(JSON.stringify({ success: false, error: 'Capacidade insuficiente' }), { status: 403 }) as never,
          };
        },
      },
    }));

    const resposta = await handler(requisicao(corpoValido()));

    expect(resposta.status).toBe(403);
    expect(bling.criados).toHaveLength(0);
  });
});
