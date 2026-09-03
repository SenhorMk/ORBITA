import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import { bling } from '@/services/bling';
import type { BlingPort } from '@/services/blingPort';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import {
  createManualOrderHandler,
  type Dormir,
  type ManualOrderAuthPort,
  type ManualOrderBlingPort,
  type ManualOrderCliente,
  type ManualOrderProduto,
  type ManualOrderStorePort,
  type PersistManualOrderInput,
  type PersistVendaResult,
} from './handler';

export type {
  ManualOrderBlingPort,
  ManualOrderDependencies,
  ManualOrderStorePort,
} from './handler';

/**
 * Referência da venda enviada ao Bling em `numeroLoja` — o número do pedido no
 * sistema de origem, que é o campo que o Bling reserva para isso.
 *
 * Desde a migration 53 ela **não** é mais gravada em `pedidos.bling_id`: sem
 * sincronização não existe id do Bling, e a coluna aceita NULL. Antes essa
 * posição era ocupada por `MANUAL-<Math.random()>`, um identificador fictício
 * se passando por ID do ERP.
 */
function newLocalReference(): string {
  return `ORBITA-${randomUUID()}`;
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Adapter Supabase da venda manual.
 *
 * Toda consulta e todo insert repetem o predicado `organizacao_id` do escopo
 * verificado. `supabaseServer` usa a service role e ignora RLS, então o
 * predicado aqui é a única barreira que resta.
 */
function supabaseManualOrderStore(): ManualOrderStorePort {
  return {
    async findClienteById(scope: VerifiedOrganizationScope, clienteId: string): Promise<ManualOrderCliente | null> {
      const { data, error } = await supabaseServer
        .from('clientes')
        .select('id, nome, bling_id, email, telefone, cpf_cnpj')
        .eq('organizacao_id', scope.organizationId)
        .eq('id', clienteId)
        .maybeSingle();

      if (error) throw new Error(`Falha ao consultar o cliente: ${error.message}`);
      if (!data) return null;

      return {
        id: data.id,
        nome: data.nome,
        blingId: data.bling_id ?? null,
        email: data.email ?? null,
        telefone: data.telefone ?? null,
        cpfCnpj: data.cpf_cnpj ?? null,
      };
    },

    async linkClienteBlingId(scope: VerifiedOrganizationScope, clienteId: string, blingId: string): Promise<void> {
      const { error } = await supabaseServer
        .from('clientes')
        .update({ bling_id: blingId })
        .eq('organizacao_id', scope.organizationId)
        .eq('id', clienteId);

      if (error) throw new Error(`Falha ao vincular o cliente ao Bling: ${error.message}`);
    },

    async findProdutosByIds(scope: VerifiedOrganizationScope, produtoIds: readonly string[]): Promise<readonly ManualOrderProduto[]> {
      if (produtoIds.length === 0) return [];

      const { data, error } = await supabaseServer
        .from('produtos')
        .select('id, nome, codigo, bling_id, preco, estoque, estoque_reservado')
        .eq('organizacao_id', scope.organizationId)
        .in('id', [...produtoIds]);

      if (error) throw new Error(`Falha ao consultar os produtos: ${error.message}`);

      return (data ?? []).map((row) => ({
        id: row.id,
        nome: row.nome,
        codigo: row.codigo ?? null,
        blingId: row.bling_id ?? null,
        preco: numberOrZero(row.preco),
        estoqueDisponivel: numberOrZero(row.estoque) - numberOrZero(row.estoque_reservado),
      }));
    },

    persistVenda,

    async findVendaManualJaRegistrada(scope: VerifiedOrganizationScope, blingPedidoId: string): Promise<{ pedidoId: string } | null> {
      const { data, error } = await supabaseServer
        .from('pedidos')
        .select('id')
        .eq('organizacao_id', scope.organizationId)
        .eq('bling_id', blingPedidoId)
        .eq('origem', 'Loja Física / Manual')
        .maybeSingle();

      if (error) throw new Error(`Falha ao conferir se a venda já foi registrada: ${error.message}`);
      return data ? { pedidoId: data.id } : null;
    },
  };
}

/**
 * Grava a venda inteira numa transação única.
 *
 * Antes eram quatro chamadas separadas — pedido, itens, baixa de estoque e
 * título financeiro. Uma falha no meio deixava estoque baixado sem título, ou
 * pedido sem itens, sem nenhuma compensação. `registrar_venda_manual`
 * (migration 53) faz tudo de uma vez: ou a venda inteira existe, ou nada
 * existe. A RPC revalida cliente e produtos contra a organização e recusa
 * estoque negativo.
 *
 * **A corrida com o webhook (ticket 30, migration 57).** Quando a venda é
 * sincronizada, o pedido nasce no Bling **antes** desta gravação — a ordem não
 * pode ser invertida, porque o `bling_id` só existe depois da criação remota.
 * O Bling então dispara `order.created`, e o webhook grava a linha em
 * `pedidos` em menos de um segundo, quase sempre **primeiro**. Por isso a RPC
 * **assume** a linha do webhook em vez de inserir outra: mesma organização,
 * mesmo `bling_id`, mesmo pedido. `uq_pedidos_org_bling` continua no lugar, e
 * assumir uma linha que **já é** venda manual continua sendo `23505` — que o
 * handler trata como falha definitiva, e dispara a compensação.
 *
 * **Falha definitiva × falha ambígua (ticket 30, fatia 3).** `supabase-js`
 * nunca lança para uma chamada de RPC — devolve `{ data, error }` mesmo
 * quando a falha é de rede. A distinção que importa está em `error.code`:
 *
 * - **Não vazio** (`23505`, `P0002`, `PGRST116`, …) — o `PostgrestBuilder`
 *   só preenche isso depois de fazer `JSON.parse` do corpo de uma resposta
 *   HTTP que o servidor **enviou**. Uma resposta assim só existe depois que o
 *   servidor terminou de processar a requisição — a transação da RPC, que é
 *   implícita e única, já foi revertida. **Definitiva.**
 * - **Vazio ou ausente** — o `PostgrestBuilder` também preenche `error` para
 *   falhas do `fetch` em si (timeout, conexão perdida, abort): nesses ramos,
 *   olhado em `node_modules/@supabase/postgrest-js/dist/index.mjs`, `code`
 *   começa e permanece `""` porque não veio corpo nenhum para interpretar.
 *   Sem resposta do servidor, não há como saber se a transação chegou a
 *   commitar antes da falha aparecer aqui. **Ambígua.**
 *
 * O caso do `data` que não é `string` é outra coisa: `res.ok` só é verdadeiro
 * depois que a RPC comitou (é assim que o PostgREST decide o código HTTP),
 * então esse ramo sabe que a gravação **aconteceu** — só o formato do
 * retorno é que surpreendeu. Vira falha definitiva também, mas por motivo
 * diferente: não há ambiguidade sobre o commit, só sobre o valor devolvido.
 */
async function persistVenda(input: PersistManualOrderInput): Promise<PersistVendaResult> {
  const { data, error } = await supabaseServer.rpc('registrar_venda_manual', {
    p_organizacao_id: input.scope.organizationId,
    p_actor_id: input.scope.actorId,
    p_cliente_id: input.clienteId,
    // Sem sincronização com o Bling não existe id do Bling: a coluna aceita
    // NULL desde a migration 53, em vez de receber um identificador inventado.
    p_bling_pedido_id: input.blingPedidoId,
    p_numero: input.blingPedidoId,
    p_total: input.total,
    p_desconto: input.desconto,
    p_frete: input.frete,
    p_forma_pagamento: input.formaPagamento,
    p_observacoes: input.observacoes,
    p_data: input.dataStr,
    p_itens: input.itens.map((item) => ({
      produto_id: item.produto.id,
      quantidade: item.quantidade,
      valor_unitario: item.produto.preco,
    })),
  });

  if (error) {
    const codigo = typeof error.code === 'string' ? error.code : '';
    return codigo !== ''
      ? { _tag: 'PersistVendaFalhouDefinitivamente', causa: new Error(error.message) }
      : { _tag: 'PersistVendaAmbigua', causa: new Error(error.message) };
  }
  if (typeof data !== 'string') {
    // `res.ok`: a gravação aconteceu. Não é ambiguidade de transporte.
    return {
      _tag: 'PersistVendaFalhouDefinitivamente',
      causa: new Error('a venda foi registrada mas o banco não devolveu o id do pedido'),
    };
  }

  return { _tag: 'PersistVendaOk', pedidoId: data };
}

/** `Dormir` real, para produção — a versão injetada nos testes não espera de verdade. */
const dormirDeVerdade: Dormir = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(signal.reason);
  }, { once: true });
});

function blingManualOrderAdapter(client: BlingPort): ManualOrderBlingPort {
  return {
    getDefaultFormaPagamentoId: () => client.obterFormaPagamentoPadraoId(),
    createContato: (input) => client.criarContatoParaVenda(input),
    createPedidoVenda: (payload) => client.criarPedidoVenda(payload),
    lancarEstoquePedido: (pedidoBlingId) => client.lancarEstoquePedidoVenda(pedidoBlingId),
    cancelarPedidoVenda: (pedidoBlingId) => client.cancelarPedidoVenda(pedidoBlingId),
  };
}

/** Sessão e escopo já verificados uma única vez por requisição, reapresentados ao handler. */
function authFor(actorId: string, scope: VerifiedOrganizationScope): ManualOrderAuthPort {
  return {
    async authenticate() {
      return { actorId };
    },
    async resolveScope() {
      return { _tag: 'Resolved' as const, scope };
    },
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  // Ticket 22 — o portão de sessão legado saiu. Ele usava o id do *tenant* como
  // id do *ator*, e os dois só coincidiam porque um `dono` sem `tenant_id` caía
  // em `tenantId = actorId`. O ator verdadeiro vem do vínculo persistido, em
  // `scope.actorId`.
  // O escopo é resolvido aqui, uma vez, porque desde o Ticket 10b o cliente do
  // Bling exige a organização verificada. O handler recebe o mesmo escopo já
  // provado, em vez de resolvê-lo de novo.
  const scopeResult = await resolveVerifiedOrganizationScope(request);
  if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
  const { scope } = scopeResult;

  const handler = createManualOrderHandler({
    auth: authFor(scope.actorId, scope),
    store: supabaseManualOrderStore(),
    bling: blingManualOrderAdapter(bling.forVerifiedOrganization(scope)),
    now: () => new Date(),
    newLocalReference,
    dormir: dormirDeVerdade,
  });

  return handler(request);
}
