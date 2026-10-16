import { describe, expect, it } from 'vitest';

import {
  createProdutoUpdateHandler,
  type ProdutoBlingPayload,
  type ProdutoBlingPort,
  type ProdutoCategoriaPort,
  type ProdutoDependencies,
  type ProdutoResponseBody,
  type ProdutoStorePort,
  type EventoDoProduto,
} from './handler';
import { buildProdutoRequest, produtoRequestSchema, produtoUpdateResponseSchema, saldoParaEnvio } from '@/lib/config/produtoContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { ReconciliacaoDeProdutoNecessaria } from '@/repositories/reconciliacaoDeProduto';

const ORG = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const PRODUTO_LOCAL = '33333333-3333-4333-8333-333333333333';
/** Categoria da organização do escopo, já importada do Bling. */
const CATEGORIA_DA_ORG = '44444444-4444-4444-8444-444444444444';
/** Mesma tabela, outra organização — o navegador não sabe a diferença. */
const CATEGORIA_DE_OUTRA_ORG = '55555555-5555-4555-8555-555555555555';
const CATEGORIA_INEXISTENTE = '66666666-6666-4666-8666-666666666666';

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
  /** Forma da falha: o padrão é recusa de validação (`400`), que prova ausência de efeito. */
  formaDaFalha?: { readonly type: string; readonly status: number };
} = {}): FakeBling {
  const buscas: string[] = [];
  const criados: ProdutoBlingPayload[] = [];
  const atualizados: Array<{ id: string; payload: ProdutoBlingPayload }> = [];
  const saldos: Array<{ id: string; quantidade: number }> = [];

  const falha = (message: string) => ({
    _tag: 'BlingFailed' as const,
    failure: {
      _tag: 'BlingProviderFailure' as const,
      type: options.formaDaFalha?.type ?? 'VALIDATION_ERROR',
      status: options.formaDaFalha?.status ?? 400,
      message,
      duplicateSale: false,
    },
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
        estoque: produto.estoque ?? 0,
      };
    },
  };
}

interface FakeCategorias extends ProdutoCategoriaPort {
  readonly consultas: Array<{ organizationId: string; categoriaId: string }>;
}

/**
 * As linhas têm organização, como no banco. O fake filtra pelo escopo em vez de
 * devolver a categoria pedida, que é o único jeito de o teste provar a
 * fronteira e não apenas a passagem do campo.
 */
function fakeCategorias(linhas: Array<{ id: string; organizacaoId: string; blingId: string | null }> = [
  { id: CATEGORIA_DA_ORG, organizacaoId: ORG, blingId: '900' },
  { id: CATEGORIA_DE_OUTRA_ORG, organizacaoId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', blingId: '901' },
]): FakeCategorias {
  const consultas: Array<{ organizationId: string; categoriaId: string }> = [];
  return {
    consultas,
    async resolverBlingId(escopo, categoriaId) {
      consultas.push({ organizationId: escopo.organizationId, categoriaId });
      const linha = linhas.find((l) => l.id === categoriaId && l.organizacaoId === escopo.organizationId);
      if (!linha?.blingId || !/^\d+$/u.test(linha.blingId)) return null;
      return Number(linha.blingId);
    },
  };
}

/** A trilha gravada pela rota; `falhar` simula a RPC de auditoria indisponível. */
function fakeAuditoria(options: { falhar?: boolean } = {}) {
  const eventos: Array<{ organizationId: string; actorId: string; evento: EventoDoProduto }> = [];
  return {
    eventos,
    async auditar(escopo: VerifiedOrganizationScope, evento: EventoDoProduto) {
      if (options.falhar) throw new Error('registrar_evento_auditoria indisponível');
      eventos.push({ organizationId: escopo.organizationId, actorId: escopo.actorId, evento });
    },
  };
}

function deps(overrides: Partial<ProdutoDependencies> = {}): ProdutoDependencies {
  return {
    auth: { async authorize() { return { _tag: 'Authorized', scope }; } },
    bling: fakeBling(),
    store: fakeStore(),
    categorias: fakeCategorias(),
    auditar: fakeAuditoria().auditar,
    correlationId: () => 'corr_teste',
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
    // O espelho não recebe um saldo que o Bling não confirmou.
    expect(store.gravados[0]).not.toHaveProperty('estoque');
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

  it('colisão com produto local que tem foto: falha honesta pelo mesmo caminho, sem SQL nem detalhe interno', async () => {
    const store = fakeStore({ erro: new ReconciliacaoDeProdutoNecessaria('duplicado_com_foto') });
    const handler = createProdutoUpdateHandler(deps({ store }));

    const resposta = await handler(requisicao(corpoValido({ id: PRODUTO_LOCAL })));
    const corpo = (await resposta.json()) as ProdutoResponseBody;

    expect(resposta.status).toBe(500);
    expect(corpo.success).toBe(false);
    expect(corpo.error).toContain('Produto salvo no Bling (id 4242), mas falhou ao gravar no ORBITA');
    expect(corpo.error).toContain('precisam ser reconciliados');
    expect(corpo.error).toContain('Sincronize o catálogo');
    expect(corpo.error).not.toMatch(/23505|constraint|imagem_storage_path/u);
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

describe('categoria do produto chega ao Bling, e só a da própria organização', () => {
  it('resolve o UUID local no id do Bling e envia a forma oficial `categoria: { id }`', async () => {
    // O defeito: `categoriaId` era gravado localmente e descartado antes do
    // ERP, então escolher categoria não mudava nada no Bling.
    const bling = fakeBling();
    const store = fakeStore();
    const handler = createProdutoUpdateHandler(deps({ bling, store }));

    const resposta = await handler(requisicao(corpoValido({ categoriaId: CATEGORIA_DA_ORG })));

    expect(resposta.status).toBe(200);
    expect(bling.criados).toHaveLength(1);
    expect(bling.criados[0].categoria).toEqual({ id: 900 });
    // Inteiro, como `ProdutosCategoriaDTO.id` exige — e nunca o UUID local.
    expect(typeof bling.criados[0].categoria?.id).toBe('number');
    expect(JSON.stringify(bling.criados[0])).not.toContain(CATEGORIA_DA_ORG);
    // A persistência local continua pelo UUID.
    expect(store.gravados[0].categoriaId).toBe(CATEGORIA_DA_ORG);
  });

  it('a resolução é consultada dentro do escopo verificado', async () => {
    const categorias = fakeCategorias();
    const handler = createProdutoUpdateHandler(deps({ categorias }));

    await handler(requisicao(corpoValido({ categoriaId: CATEGORIA_DA_ORG })));

    expect(categorias.consultas).toEqual([{ organizationId: ORG, categoriaId: CATEGORIA_DA_ORG }]);
  });

  it('categoria de outra organização é recusada, sem nenhuma escrita no Bling', async () => {
    const bling = fakeBling();
    const store = fakeStore();
    const handler = createProdutoUpdateHandler(deps({ bling, store }));

    const resposta = await handler(requisicao(corpoValido({ categoriaId: CATEGORIA_DE_OUTRA_ORG })));
    const corpo = (await resposta.json()) as ProdutoResponseBody;

    expect(resposta.status).toBe(400);
    expect(corpo.error).toContain('Categoria');
    expect(bling.criados).toHaveLength(0);
    expect(bling.atualizados).toHaveLength(0);
    expect(store.gravados).toHaveLength(0);
  });

  it('UUID inexistente é recusado, sem nenhuma escrita externa', async () => {
    const bling = fakeBling();
    const handler = createProdutoUpdateHandler(deps({ bling }));

    const resposta = await handler(requisicao(corpoValido({ categoriaId: CATEGORIA_INEXISTENTE })));

    expect(resposta.status).toBe(400);
    expect(bling.criados).toHaveLength(0);
    expect(bling.atualizados).toHaveLength(0);
  });

  it('categoria local sem `bling_id` utilizável é recusada antes do ERP', async () => {
    const bling = fakeBling();
    const categorias = fakeCategorias([{ id: CATEGORIA_DA_ORG, organizacaoId: ORG, blingId: null }]);
    const handler = createProdutoUpdateHandler(deps({ bling, categorias }));

    const resposta = await handler(requisicao(corpoValido({ categoriaId: CATEGORIA_DA_ORG })));

    expect(resposta.status).toBe(400);
    expect(bling.criados).toHaveLength(0);
  });

  it('sem categoria segue permitido, e nenhuma categoria é inventada', async () => {
    const bling = fakeBling();
    const handler = createProdutoUpdateHandler(deps({ bling }));

    const resposta = await handler(requisicao(corpoValido()));

    expect(resposta.status).toBe(200);
    expect(bling.criados[0]).not.toHaveProperty('categoria');
  });

  it('produto existente com categoria escolhida: o PUT leva a categoria correta', async () => {
    const bling = fakeBling();
    const handler = createProdutoUpdateHandler(deps({ bling }));

    const resposta = await handler(requisicao(corpoValido({
      blingId: '14077064',
      categoriaId: CATEGORIA_DA_ORG,
    })));

    expect(resposta.status).toBe(200);
    expect(bling.atualizados).toHaveLength(1);
    expect(bling.atualizados[0].id).toBe('14077064');
    expect(bling.atualizados[0].payload.categoria).toEqual({ id: 900 });
  });
});

describe('estoque: o espelho só recebe saldo confirmado (PRE-006B)', () => {
  it('sem saldo no corpo, não lança balanço no Bling nem zera o estoque local', async () => {
    // Antes: `estoque: body.estoque ?? 0` — uma edição sem saldo zerava o
    // estoque local de um produto que tinha unidades.
    const bling = fakeBling();
    const store = fakeStore();
    const handler = createProdutoUpdateHandler(deps({ bling, store }));

    const resposta = await handler(requisicao(corpoValido({ id: PRODUTO_LOCAL, blingId: '4242' })));

    expect(resposta.status).toBe(200);
    expect(bling.saldos).toEqual([]);
    expect(store.gravados[0]).not.toHaveProperty('estoque');
  });

  it('saldo confirmado pelo Bling é o que vai para o espelho', async () => {
    const store = fakeStore();
    const handler = createProdutoUpdateHandler(deps({ store }));

    await handler(requisicao(corpoValido({ estoque: 9 })));

    expect(store.gravados[0]!.estoque).toBe(9);
  });

  it('repetir a mesma edição de saldo não acumula: é balanço absoluto, nunca entrada', async () => {
    const bling = fakeBling();
    const handler = createProdutoUpdateHandler(deps({ bling }));

    await handler(requisicao(corpoValido({ blingId: '4242', estoque: 9 })));
    await handler(requisicao(corpoValido({ blingId: '4242', estoque: 9 })));

    expect(bling.saldos).toEqual([{ id: '4242', quantidade: 9 }, { id: '4242', quantidade: 9 }]);
  });
});

describe('falha no Bling: recusa comprovada ≠ estado desconhecido (PRE-006B)', () => {
  it('timeout no cadastro é desconhecido: 502, sem espelho e sem convite a cadastrar de novo', async () => {
    const bling = fakeBling({ falhaCriar: 'tempo esgotado', formaDaFalha: { type: 'UNKNOWN_ERROR', status: 0 } });
    const store = fakeStore();
    const auditoria = fakeAuditoria();
    const handler = createProdutoUpdateHandler(deps({ bling, store, auditar: auditoria.auditar }));

    const resposta = await handler(requisicao(corpoValido()));
    const corpo = (await resposta.json()) as ProdutoResponseBody;

    expect(resposta.status).toBe(502);
    expect(corpo.error).toContain('pode ter sido criado');
    expect(corpo.error).toContain('Não cadastre de novo');
    expect(produtoUpdateResponseSchema.parse(corpo).reconciliacao).toEqual({ motivo: 'bling_sem_confirmacao', blingId: null });
    expect(store.gravados).toHaveLength(0);
    expect(auditoria.eventos.map((e) => e.evento)).toEqual([{
      acao: 'catalog.product_reconcile_required',
      recursoId: null,
      correlationId: 'corr_teste',
      metadata: { operacao: 'cadastro', motivo: 'bling_sem_confirmacao', bling_id: null },
    }]);
  });

  it('5xx na atualização também é desconhecido, e a resposta pede conferência antes de editar de novo', async () => {
    const bling = fakeBling({ falhaAtualizar: 'erro interno', formaDaFalha: { type: 'SERVER_ERROR', status: 503 } });
    const auditoria = fakeAuditoria();
    const handler = createProdutoUpdateHandler(deps({ bling, auditar: auditoria.auditar }));

    const resposta = await handler(requisicao(corpoValido({ id: PRODUTO_LOCAL, blingId: '4242' })));
    const corpo = (await resposta.json()) as ProdutoResponseBody;

    expect(resposta.status).toBe(502);
    expect(corpo.error).toContain('confira antes de editar de novo');
    expect(corpo.reconciliacao).toEqual({ motivo: 'bling_sem_confirmacao', blingId: '4242' });
    expect(auditoria.eventos[0]!.evento).toMatchObject({
      acao: 'catalog.product_reconcile_required',
      recursoId: PRODUTO_LOCAL,
      metadata: { operacao: 'atualizacao', motivo: 'bling_sem_confirmacao', bling_id: '4242' },
    });
  });

  it('exceção na chamada (timeout, ACK perdido) é desconhecido, não 500 sem desfecho', async () => {
    // `criarProduto` lança quando a rede cai: antes isso escapava do handler
    // como 500 genérico, sem auditoria e sem dizer que o produto pode existir.
    const bling = { ...fakeBling(), async criar(): Promise<never> { throw new TypeError('fetch failed'); } };
    const store = fakeStore();
    const auditoria = fakeAuditoria();
    const handler = createProdutoUpdateHandler(deps({ bling, store, auditar: auditoria.auditar }));

    const resposta = await handler(requisicao(corpoValido()));
    const corpo = (await resposta.json()) as ProdutoResponseBody;

    expect(resposta.status).toBe(502);
    expect(corpo.error).toContain('pode ter sido criado');
    expect(store.gravados).toEqual([]);
    expect(auditoria.eventos[0]!.evento).toMatchObject({
      acao: 'catalog.product_reconcile_required',
      metadata: { operacao: 'cadastro', motivo: 'bling_sem_confirmacao', bling_id: null },
    });
  });

  it('exceção no balanço vira saldo não confirmado, e o espelho não recebe o saldo', async () => {
    const bling = { ...fakeBling(), async definirSaldo(): Promise<never> { throw new TypeError('fetch failed'); } };
    const store = fakeStore();
    const handler = createProdutoUpdateHandler(deps({ bling, store }));

    const resposta = await handler(requisicao(corpoValido({ estoque: 5 })));

    expect(resposta.status).toBe(200);
    expect(store.gravados[0]).not.toHaveProperty('estoque');
  });

  it('recusa de validação do Bling é recusa: 400 e evento de recusa', async () => {
    const bling = fakeBling({ falhaCriar: 'Campo obrigatório não informado' });
    const auditoria = fakeAuditoria();
    const handler = createProdutoUpdateHandler(deps({ bling, auditar: auditoria.auditar }));

    const resposta = await handler(requisicao(corpoValido()));

    expect(resposta.status).toBe(400);
    expect(auditoria.eventos.map((e) => e.evento)).toEqual([{
      acao: 'catalog.product_save_rejected',
      recursoId: null,
      correlationId: 'corr_teste',
      metadata: { operacao: 'cadastro', tipo_erro: 'VALIDATION_ERROR', status_http: 400 },
    }]);
  });
});

describe('auditoria do produto (PRE-006B)', () => {
  it('produto salvo: ator e organização do escopo verificado, sem nome, SKU nem preço', async () => {
    const auditoria = fakeAuditoria();
    const handler = createProdutoUpdateHandler(deps({ auditar: auditoria.auditar }));

    await handler(requisicao(corpoValido({ codigo: 'CAM-01', estoque: 4 })));

    expect(auditoria.eventos).toEqual([{
      organizationId: ORG,
      actorId: ACTOR,
      evento: {
        acao: 'catalog.product_saved',
        recursoId: PRODUTO_LOCAL,
        correlationId: 'corr_teste',
        metadata: { produto_id: PRODUTO_LOCAL, bling_id: '4242', operacao: 'cadastro', saldo: 'aplicado' },
      },
    }]);
    expect(JSON.stringify(auditoria.eventos)).not.toMatch(/Camiseta|CAM-01|49\.9/u);
  });

  it('saldo não confirmado fica registrado como tal no evento de sucesso', async () => {
    const auditoria = fakeAuditoria();
    const handler = createProdutoUpdateHandler(deps({ bling: fakeBling({ falhaSaldo: 'x' }), auditar: auditoria.auditar }));

    await handler(requisicao(corpoValido({ estoque: 4 })));

    expect(auditoria.eventos[0]!.evento).toMatchObject({ acao: 'catalog.product_saved', metadata: { saldo: 'nao_confirmado' } });
  });

  it('Bling confirmou e o espelho falhou: evento de reconciliação com o id do Bling', async () => {
    const auditoria = fakeAuditoria();
    const handler = createProdutoUpdateHandler(deps({ store: fakeStore({ erro: new Error('conexão perdida') }), auditar: auditoria.auditar }));

    const resposta = await handler(requisicao(corpoValido()));

    expect(resposta.status).toBe(500);
    expect(auditoria.eventos[0]!.evento).toMatchObject({
      acao: 'catalog.product_reconcile_required',
      metadata: { operacao: 'cadastro', motivo: 'espelho_local_falhou', bling_id: '4242' },
    });
  });

  it('auditoria indisponível não transforma o sucesso confirmado em falha', async () => {
    const store = fakeStore();
    const handler = createProdutoUpdateHandler(deps({ store, auditar: fakeAuditoria({ falhar: true }).auditar }));

    const resposta = await handler(requisicao(corpoValido()));

    expect(resposta.status).toBe(200);
    expect(store.gravados).toHaveLength(1);
  });

  it('recusas antes de qualquer efeito não gravam nada: corpo inválido, categoria de outra organização', async () => {
    const bling = fakeBling();
    const store = fakeStore();
    const auditoria = fakeAuditoria();
    const handler = createProdutoUpdateHandler(deps({ bling, store, auditar: auditoria.auditar }));

    const invalido = await handler(requisicao({ nome: '', preco: -1, organizacaoId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
    const alheia = await handler(requisicao(corpoValido({ categoriaId: CATEGORIA_DE_OUTRA_ORG })));

    expect([invalido.status, alheia.status]).toEqual([400, 400]);
    expect(bling.criados).toEqual([]);
    expect(bling.atualizados).toEqual([]);
    expect(bling.saldos).toEqual([]);
    expect(store.gravados).toEqual([]);
    expect(auditoria.eventos).toEqual([]);
  });
});

describe('saldoParaEnvio: o formulário só manda saldo alterado (PRE-006B)', () => {
  it('edição sem mexer no saldo não manda estoque; alteração e cadastro mandam', () => {
    expect(saldoParaEnvio('3', 3, false)).toEqual({});
    expect(saldoParaEnvio('7', 3, false)).toEqual({ estoque: 7 });
    expect(saldoParaEnvio('0', undefined, true)).toEqual({ estoque: 0 });
    expect(saldoParaEnvio('', 2, false)).toEqual({ estoque: 0 });
  });
});

describe('resposta estruturada para a tela (PRE-006B, revisão)', () => {
  it('saldo não confirmado: sucesso com `saldo` e o aviso, no contrato que o modal lê', async () => {
    const handler = createProdutoUpdateHandler(deps({ bling: fakeBling({ falhaSaldo: 'Depósito padrão não configurado' }) }));

    const corpo = produtoUpdateResponseSchema.parse(await (await handler(requisicao(corpoValido({ estoque: 4 })))).json());

    expect(corpo).toMatchObject({ success: true, saldo: 'nao_confirmado' });
    expect(corpo.avisos?.join(' ')).toContain('Depósito padrão não configurado');
    expect(corpo.reconciliacao).toBeUndefined();
  });

  it('Bling confirmou e o espelho falhou: reconciliação com o id do Bling', async () => {
    const handler = createProdutoUpdateHandler(deps({ store: fakeStore({ erro: new Error('conexão perdida') }) }));

    const corpo = produtoUpdateResponseSchema.parse(await (await handler(requisicao(corpoValido()))).json());

    expect(corpo.reconciliacao).toEqual({ motivo: 'espelho_local_falhou', blingId: '4242' });
  });

  it('recusa comprovada não carrega reconciliação: corrigir e reenviar é o caminho', async () => {
    const handler = createProdutoUpdateHandler(deps({ bling: fakeBling({ falhaCriar: 'Campo obrigatório' }) }));

    const corpo = produtoUpdateResponseSchema.parse(await (await handler(requisicao(corpoValido()))).json());

    expect(corpo.success).toBe(false);
    expect(corpo.reconciliacao).toBeUndefined();
  });
});
