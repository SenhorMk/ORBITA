/**
 * Ticket 30 — a corrida entre o webhook do Bling e a venda manual.
 *
 * Todos os testes desta série exercitavam **uma rota de cada vez**, e foi
 * exatamente por isso que a corrida sobreviveu: o handler da venda manual usa
 * um adaptador de Bling em memória, e o webhook não existe nesse mundo. Cada
 * lado coerente consigo mesmo, divergentes entre si.
 *
 * Este arquivo põe as duas no mesmo pedido:
 *
 *   1. a **rota real do webhook** (`POST /api/bling/webhook`, assinada) grava a
 *      linha em `pedidos` para o `bling_id` que a venda manual acabou de criar;
 *   2. o **handler real da venda manual** chega em seguida para gravar a mesma
 *      chave.
 *
 * ## O que este teste prova, e o que ele NÃO prova
 *
 * Ele prova a **ligação**: que a chave é a mesma dos dois lados, e qual é a
 * resposta observável da venda manual sob cada ordem de chegada.
 *
 * Ele **não** prova a regra SQL da tomada — `persistVenda` aqui é uma porta em
 * memória. Quem prova a regra é
 * `supabase/tests/database/venda_manual_assume_linha_do_webhook.test.sql`,
 * contra PostgreSQL de verdade, com o índice único e os gatilhos de estoque.
 * A porta em memória repete a mesma regra e nada além dela.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);

import { encrypt } from '@/lib/crypto';
import { buildManualOrderRequest } from '@/lib/config/manualOrderContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { ItemPedido, Pedido } from '@/types';

import {
  createManualOrderHandler,
  type ManualOrderBlingPort,
  type ManualOrderCliente,
  type ManualOrderProduto,
  type ManualOrderResponseBody,
  type ManualOrderStorePort,
  type PersistManualOrderInput,
  type PersistVendaResult,
} from './handler';

const SEGREDO_BLING = 'secret-bling-12345';
const ORG = '11111111-1111-4111-8111-111111111111';
const DONO = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const CONEXAO = '33333333-3333-4333-8333-333333333333';
const CLIENTE = '44444444-4444-4444-8444-444444444444';
const PRODUTO = '55555555-5555-4555-8555-555555555555';

/** O pedido `26764331138` é o da jornada reprovada de 02/09. */
const BLING_PEDIDO_ID = '26764331138';
/** O número real do pedido na conta, que só o webhook conhece. */
const BLING_NUMERO = 20;

// ---------------------------------------------------------------------------
// A tabela `pedidos` compartilhada pelas duas rotas.
//
// É o ponto inteiro do teste: o webhook e a venda manual escrevem no MESMO
// lugar, com a MESMA chave `(organizacao_id, bling_id)`.
// ---------------------------------------------------------------------------
interface LinhaPedido {
  id: string;
  organizacaoId: string;
  blingId: string;
  numero: string | null;
  origem: string;
  status: string;
  total: number;
  formaPagamento: string | null;
  actorId: string;
}

const ORIGEM_MANUAL = 'Loja Física / Manual';

/** Falha do banco tal como o `supabase-js` a devolve para o handler. */
function conflitoDeChaveUnica(): Error {
  return new Error(
    'duplicate key value violates unique constraint "uq_pedidos_org_bling"',
  );
}

class PedidosCompartilhados {
  readonly linhas: LinhaPedido[] = [];
  readonly itens: Array<{ pedidoId: string; produtoId: string; quantidade: number }> = [];
  readonly titulos: Array<{ pedidoId: string; valor: number }> = [];
  readonly baixasDeEstoque: Array<{ produtoId: string; quantidade: number }> = [];
  /** Payloads que o webhook mandou gravar, exatamente como `processPedidoEvent` os montou. */
  readonly upsertsDoWebhook: Pedido[] = [];
  private sequencia = 0;

  private achar(organizacaoId: string, blingId: string): LinhaPedido | undefined {
    return this.linhas.find((l) => l.organizacaoId === organizacaoId && l.blingId === blingId);
  }

  /**
   * `pedidoRepository.upsert` — `on conflict (organizacao_id, bling_id)`, com
   * as colunas que o webhook realmente carrega e só elas.
   */
  upsertDoWebhook(scope: VerifiedOrganizationScope, pedido: Pedido): LinhaPedido {
    this.upsertsDoWebhook.push(pedido);
    const existente = this.achar(scope.organizationId, pedido.bling_id);
    if (existente) {
      existente.numero = pedido.numero;
      existente.status = pedido.status;
      existente.total = pedido.total;
      existente.actorId = scope.actorId;
      return existente;
    }
    this.sequencia += 1;
    const linha: LinhaPedido = {
      id: `pedido-${this.sequencia}`,
      organizacaoId: scope.organizationId,
      blingId: pedido.bling_id,
      numero: pedido.numero,
      origem: 'Bling',
      status: pedido.status,
      total: pedido.total,
      formaPagamento: null,
      actorId: scope.actorId,
    };
    this.linhas.push(linha);
    return linha;
  }

  adicionarItensDoWebhook(itens: ItemPedido[]): void {
    for (const item of itens) {
      const jaExiste = this.itens.find((i) => i.pedidoId === item.pedido_id && i.produtoId === item.produto_id);
      if (jaExiste) jaExiste.quantidade = item.quantidade;
      else this.itens.push({ pedidoId: item.pedido_id, produtoId: item.produto_id, quantidade: item.quantidade });
    }
  }

  /**
   * `registrar_venda_manual` (migration 57). A regra da tomada, e nada além
   * dela — a prova da regra é o teste pgTAP.
   *
   * `comTomada: false` reproduz a migration 56, que é onde o defeito mora.
   *
   * O `23505` da guarda é sempre `PersistVendaFalhouDefinitivamente` — é
   * exatamente o caso em que o banco RESPONDE com um erro estruturado, nunca
   * o de resposta perdida. A ambiguidade de transporte (`PersistVendaAmbigua`)
   * não tem análogo aqui: esta porta em memória nunca "perde a conexão".
   */
  registrarVendaManual(input: PersistManualOrderInput, comTomada: boolean): PersistVendaResult {
    const existente = input.blingPedidoId === null
      ? undefined
      : this.achar(input.scope.organizationId, input.blingPedidoId);

    let linha: LinhaPedido;
    if (existente && !comTomada) {
      return { _tag: 'PersistVendaFalhouDefinitivamente', causa: conflitoDeChaveUnica() };
    } else if (existente) {
      if (existente.origem === ORIGEM_MANUAL) {
        return { _tag: 'PersistVendaFalhouDefinitivamente', causa: conflitoDeChaveUnica() };
      }
      // O número real do Bling, que o webhook trouxe, é preservado.
      existente.numero = existente.numero ?? input.blingPedidoId;
      existente.origem = ORIGEM_MANUAL;
      existente.status = 'Entregue';
      existente.total = input.total;
      existente.formaPagamento = input.formaPagamento;
      existente.actorId = input.scope.actorId;
      linha = existente;
    } else {
      this.sequencia += 1;
      linha = {
        id: `pedido-${this.sequencia}`,
        organizacaoId: input.scope.organizationId,
        blingId: input.blingPedidoId ?? '',
        numero: input.blingPedidoId,
        origem: ORIGEM_MANUAL,
        status: 'Entregue',
        total: input.total,
        formaPagamento: input.formaPagamento,
        actorId: input.scope.actorId,
      };
      this.linhas.push(linha);
    }

    for (const item of input.itens) {
      const jaExiste = this.itens.find((i) => i.pedidoId === linha.id && i.produtoId === item.produto.id);
      if (jaExiste) jaExiste.quantidade = item.quantidade;
      else this.itens.push({ pedidoId: linha.id, produtoId: item.produto.id, quantidade: item.quantidade });
      this.baixasDeEstoque.push({ produtoId: item.produto.id, quantidade: item.quantidade });
    }

    this.titulos.push({ pedidoId: linha.id, valor: input.total });
    return { _tag: 'PersistVendaOk', pedidoId: linha.id };
  }
}

let pedidos = new PedidosCompartilhados();

// ---------------------------------------------------------------------------
// Dublês do lado do webhook. Mesmo recorte de `webhook.test.ts`, com os
// repositórios apontados para a tabela compartilhada.
// ---------------------------------------------------------------------------
vi.mock('@/lib/supabaseServer', () => ({
  supabaseServer: {
    rpc: (nome: string) => {
      if (nome === 'registrar_evento_inbox_bling') {
        return Promise.resolve({
          data: [{ evento_id: 'inbox-evt-1', status: 'received', is_duplicate: false, cached_response: null }],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from: (tabela: string) => {
      if (tabela === 'conexoes_integracao') {
        return {
          select: () => ({
            eq: (_coluna: string, provedor: string) => Promise.resolve({
              data: provedor === 'bling' ? [{ id: CONEXAO, organizacao_id: ORG, provedor: 'bling' }] : [],
              error: null,
            }),
          }),
        };
      }
      if (tabela === 'credenciais_integracao') {
        const dadosCifrados = encrypt(JSON.stringify({ client_id: 'client-id', client_secret: SEGREDO_BLING }));
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: { dados_cifrados: dadosCifrados, chave_versao: 'v1' }, error: null }),
              }),
            }),
          }),
        };
      }
      if (tabela === 'membros_organizacao') {
        return {
          select: () => ({
            eq: () => ({
              eq: (coluna: string) => {
                if (coluna === 'papel') {
                  return {
                    limit: () => ({ maybeSingle: () => Promise.resolve({ data: { user_id: DONO }, error: null }) }),
                    maybeSingle: () => Promise.resolve({ data: { user_id: DONO }, error: null }),
                  };
                }
                return { maybeSingle: () => Promise.resolve({ data: { papel: 'owner' }, error: null }) };
              },
            }),
          }),
        };
      }
      if (tabela === 'inbox_eventos_bling') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'inbox-evt-1' }, error: null }) }),
            }),
          }),
        };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
        upsert: () => Promise.resolve({ error: null }),
      };
    },
  },
}));

vi.mock('@/repositories/produtoRepository', () => ({
  produtoRepository: {
    getByBlingId: vi.fn().mockResolvedValue({ id: PRODUTO, bling_id: '77', nome: 'Rapé Pequeno Artemísia', preco: 40, estoque: 3 }),
    upsert: vi.fn().mockResolvedValue({ id: PRODUTO }),
  },
}));

vi.mock('@/repositories/clienteRepository', () => ({
  clienteRepository: {
    getByBlingId: vi.fn().mockResolvedValue({ id: CLIENTE, bling_id: '4321', nome: 'Mateus Kahuan' }),
    upsert: vi.fn().mockResolvedValue({ id: CLIENTE }),
  },
}));

vi.mock('@/repositories/pedidoRepository', () => ({
  pedidoRepository: {
    upsert: (scope: VerifiedOrganizationScope, pedido: Pedido) => Promise.resolve(pedidos.upsertDoWebhook(scope, pedido)),
    addItems: (_scope: VerifiedOrganizationScope, itens: ItemPedido[]) => {
      pedidos.adicionarItensDoWebhook(itens);
      return Promise.resolve();
    },
    markCancelledByBlingId: vi.fn().mockResolvedValue(true),
  },
}));

/** O detalhe do pedido que `processPedidoEvent` busca no Bling antes de gravar. */
vi.mock('@/services/bling', () => ({
  extractBlingImageUrl: () => undefined,
  bling: {
    forOrganization: () => ({
      getPedido: async () => ({
        id: Number(BLING_PEDIDO_ID),
        numero: BLING_NUMERO,
        data: '2026-09-02',
        total: 40,
        situacao: { id: 6, valor: 6 },
        contato: { id: 4321, nome: 'Mateus Kahuan' },
        itens: [{ produto: { id: 77 }, quantidade: 1, valor: 40 }],
      }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Dublês do lado da venda manual.
// ---------------------------------------------------------------------------
/**
 * SAFETY: `VerifiedOrganizationScope` é marca opaca produzida só pela
 * verificação contra a associação persistida. No teste o escopo é entrada, não
 * o que está sob teste — mesma convenção de `manual-order.test.ts`.
 */
const escopo = { organizationId: ORG, actorId: DONO, role: 'owner' } as unknown as VerifiedOrganizationScope;

const CLIENTE_LOCAL: ManualOrderCliente = {
  id: CLIENTE, nome: 'Mateus Kahuan', blingId: '4321', email: null, telefone: null, cpfCnpj: null, excluidoNoBling: false,
};
const PRODUTO_LOCAL: ManualOrderProduto = {
  id: PRODUTO, nome: 'Rapé Pequeno Artemísia', codigo: 'RAP-15', blingId: '77', preco: 40, estoqueDisponivel: 3, situacao: 'ativo',
};

function lojaEmMemoria(comTomada: boolean): ManualOrderStorePort {
  return {
    async findClienteById() { return CLIENTE_LOCAL; },
    async linkClienteBlingId() { /* o cliente já tem bling_id */ },
    async findProdutosByIds() { return [PRODUTO_LOCAL]; },
    async persistVenda(input) { return pedidos.registrarVendaManual(input, comTomada); },
    async findVendaManualJaRegistrada(scope, blingPedidoId) {
      const linha = pedidos.linhas.find(
        (l) => l.organizacaoId === scope.organizationId && l.blingId === blingPedidoId && l.origem === ORIGEM_MANUAL,
      );
      return linha ? { pedidoId: linha.id } : null;
    },
    async reivindicarTentativa() {
      // Este teste não exercita a idempotência entre retentativas (isso é
      // coberto em `manual-order.test.ts`) — sempre uma tentativa nova.
      return { _tag: 'TentativaNova', tentativaId: 'tentativa-corrida-1', epoca: 1 };
    },
    async registrarDesfechoDaTentativa() { return { _tag: 'DesfechoGravado' as const }; },
    async confirmarPosse() { return { _tag: 'PosseVigente' as const }; },
    async resolverIntervencaoAmbigua() {
      return { _tag: 'AmbiguidadeResolvida' as const, resolucaoId: 'resolucao-corrida-1' };
    },
    async lerTentativaPorReferencia() { return null; },
    async reivindicarIntervencao() { return { _tag: 'IntervencaoReivindicada', intervencaoId: 'intervencao-1' }; },
    async encerrarIntervencao() { /* este teste não exercita intervenção */ },
    async assumirTentativaParaReconciliacao() { return { _tag: 'PosseTomada', epoca: 2 }; },
    async finalizarIntervencaoETentativa() { return { _tag: 'Persistiu' }; },
  };
}

const cancelados: string[] = [];

function blingDaVendaManual(): ManualOrderBlingPort {
  return {
    async getDefaultFormaPagamentoId() { return { _tag: 'BlingOk', value: 12 }; },
    async createContato() { return { _tag: 'BlingOk', value: { id: 4321 } }; },
    async createPedidoVenda() { return { _tag: 'BlingOk', value: { id: BLING_PEDIDO_ID, alertas: [] } }; },
    async lancarEstoquePedido() { return { _tag: 'BlingOk', value: undefined }; },
    async buscarPedidoPorNumeroLoja() { return { _tag: 'BlingOk', value: { _tag: 'NenhumPedido' } }; },
    async cancelarPedidoVenda(pedidoBlingId: string) {
      cancelados.push(pedidoBlingId);
      return { _tag: 'BlingOk', value: undefined };
    },
  };
}

async function venderPelaTela(comTomada: boolean): Promise<{ status: number; body: ManualOrderResponseBody }> {
  const handler = createManualOrderHandler({
    auth: {
      async authenticate() { return { actorId: DONO }; },
      async resolveScope() { return { _tag: 'Resolved' as const, scope: escopo }; },
    },
    store: lojaEmMemoria(comTomada),
    bling: blingDaVendaManual(),
    now: () => new Date('2026-09-02T15:59:58.000Z'),
    newLocalReference: () => 'ORBITA-9368b28e-a499-4882-9735-e96111ecb144',
    dormir: async () => {},
  });

  const corpo = buildManualOrderRequest({
    clienteId: CLIENTE,
    itens: [{ produtoId: PRODUTO, quantidade: 1 }],
    syncBling: true,
    formaPagamentoRotulo: 'Dinheiro',
  });

  const resposta = await handler(new Request('https://orbita.test/api/pedidos/manual', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  }));

  return { status: resposta.status, body: (await resposta.json()) as ManualOrderResponseBody };
}

/** O `order.created` que o Bling dispara sozinho, assinado como o de verdade. */
async function webhookOrderCreated(): Promise<Response> {
  const { POST: webhook } = await import('../../bling/webhook/route');
  const rawBody = JSON.stringify({ event: 'order.created', data: { id: Number(BLING_PEDIDO_ID) } });
  const assinatura = `sha256=${crypto.createHmac('sha256', SEGREDO_BLING).update(rawBody).digest('hex')}`;
  return webhook(new NextRequest('https://orbita.test/api/bling/webhook', {
    method: 'POST',
    headers: { 'x-bling-signature-256': assinatura, 'content-type': 'application/json' },
    body: rawBody,
  }));
}

describe('ticket 30 — a corrida entre o webhook do Bling e a venda manual', () => {
  beforeEach(() => {
    pedidos = new PedidosCompartilhados();
    cancelados.length = 0;
  });

  it('o webhook chega primeiro e a venda manual ASSUME a linha dele', async () => {
    const respostaWebhook = await webhookOrderCreated();
    expect(respostaWebhook.status).toBe(200);

    // A linha do webhook existe, com a chave que a venda manual vai usar.
    expect(pedidos.linhas).toHaveLength(1);
    expect(pedidos.linhas[0].blingId).toBe(BLING_PEDIDO_ID);
    expect(pedidos.linhas[0].origem).toBe('Bling');
    const idDaLinhaDoWebhook = pedidos.linhas[0].id;

    const { status, body } = await venderPelaTela(true);

    expect(status).toBe(201);
    expect(body.success).toBe(true);
    // O ponto: a venda devolve o id da linha que o WEBHOOK criou.
    expect(body.pedidoId).toBe(idDaLinhaDoWebhook);
    expect(body.blingPedidoId).toBe(BLING_PEDIDO_ID);

    // Um pedido só, e agora completo.
    expect(pedidos.linhas).toHaveLength(1);
    expect(pedidos.linhas[0].origem).toBe(ORIGEM_MANUAL);
    expect(pedidos.linhas[0].formaPagamento).toBe('Dinheiro');
    expect(pedidos.linhas[0].numero).toBe(String(BLING_NUMERO));
    expect(pedidos.itens).toHaveLength(1);
    expect(pedidos.baixasDeEstoque).toEqual([{ produtoId: PRODUTO, quantidade: 1 }]);
    expect(pedidos.titulos).toHaveLength(1);

    // E nada ficou pendente na conta do lojista.
    expect(cancelados).toEqual([]);
  });

  it('sem a tomada, é a reprovação de 02/09 de novo: 500, sem estoque, sem título, e um pedido cancelado à mão', async () => {
    await webhookOrderCreated();

    const { status, body } = await venderPelaTela(false);

    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.blingPedidoId).toBe(BLING_PEDIDO_ID);
    expect(body.compensado).toBe(true);

    // A venda ficou pela metade — exatamente o estado medido na jornada.
    expect(pedidos.linhas).toHaveLength(1);
    expect(pedidos.linhas[0].origem).toBe('Bling');
    expect(pedidos.baixasDeEstoque).toEqual([]);
    expect(pedidos.titulos).toEqual([]);
    expect(cancelados).toEqual([BLING_PEDIDO_ID]);
  });

  it('o webhook chega depois e não apaga a identidade da venda', async () => {
    const { status } = await venderPelaTela(true);
    expect(status).toBe(201);

    await webhookOrderCreated();

    // O payload que `processPedidoEvent` monta é a medição: ele simplesmente
    // não carrega as colunas que a venda manual escreveu.
    expect(pedidos.upsertsDoWebhook).toHaveLength(1);
    expect(Object.keys(pedidos.upsertsDoWebhook[0]).sort()).toEqual(
      ['bling_id', 'cliente_id', 'data', 'numero', 'status', 'total'],
    );

    expect(pedidos.linhas).toHaveLength(1);
    expect(pedidos.linhas[0].origem).toBe(ORIGEM_MANUAL);
    expect(pedidos.linhas[0].formaPagamento).toBe('Dinheiro');
    expect(pedidos.titulos).toHaveLength(1);
    expect(pedidos.baixasDeEstoque).toEqual([{ produtoId: PRODUTO, quantidade: 1 }]);

    // O limite escrito na migration 57: `status` e `numero` passam a refletir o
    // Bling. É o ticket 11 fazendo o que ele faz para qualquer pedido
    // sincronizado — e agora está visível, não suposto.
    expect(pedidos.linhas[0].numero).toBe(String(BLING_NUMERO));
    expect(pedidos.linhas[0].status).not.toBe('Entregue');
  });
});
