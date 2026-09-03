import { randomUUID } from 'node:crypto';

import { supabaseServer } from '@/lib/supabaseServer';
import { bling } from '@/services/bling';
import type { BlingPort } from '@/services/blingPort';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';

import { classificarErroDePersistencia } from './classificacaoDeFalha';
import type {
  DesfechoDaTentativa,
  Dormir,
  ManualOrderBlingPort,
  ManualOrderCliente,
  ManualOrderDependencies,
  ManualOrderProduto,
  ManualOrderStorePort,
  PersistManualOrderInput,
  PersistVendaResult,
  ReivindicacaoDeTentativa,
  TentativaRegistrada,
} from './ports';

/**
 * Adapters de produção da venda manual: Supabase, Bling e relógio.
 *
 * Separado de `route.ts` porque DUAS rotas os usam — a criação
 * (`POST /api/pedidos/manual`) e a reconciliação
 * (`POST /api/pedidos/manual/reconciliar`, 5ª rodada de revisão). Duplicar os
 * adapters faria as duas rotas divergirem em silêncio, que é a forma de erro
 * que este ticket inteiro existe para fechar.
 */

/**
 * Referência da venda enviada ao Bling em `numeroLoja` — o número do pedido no
 * sistema de origem, que é o campo que o Bling reserva para isso.
 *
 * Desde a migration 53 ela **não** é mais gravada em `pedidos.bling_id`: sem
 * sincronização não existe id do Bling, e a coluna aceita NULL. Antes essa
 * posição era ocupada por `MANUAL-<Math.random()>`, um identificador fictício
 * se passando por ID do ERP.
 */
export function newLocalReference(referenciaClienteFornecida?: string): string {
  return `ORBITA-${referenciaClienteFornecida ?? randomUUID()}`;
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

    reivindicarTentativa,
    registrarDesfechoDaTentativa,
    lerTentativaPorReferencia,
  };
}

/**
 * Lê a tentativa pela referência, dentro do escopo verificado (ticket 30,
 * fatia 3 — 5ª rodada de revisão, reconciliação).
 *
 * `supabaseServer` usa a service role e ignora RLS, então o predicado
 * `organizacao_id` aqui é a única barreira que separa as tentativas de uma
 * organização das da outra.
 */
async function lerTentativaPorReferencia(
  scope: VerifiedOrganizationScope,
  referenciaLocal: string,
): Promise<TentativaRegistrada | null> {
  const { data, error } = await supabaseServer
    .from('tentativas_venda_manual')
    .select('id, estado, pedido_id, bling_pedido_id, updated_at')
    .eq('organizacao_id', scope.organizationId)
    .eq('referencia_local', referenciaLocal)
    .maybeSingle();

  if (error) throw new Error(`Falha ao consultar a tentativa de venda: ${error.message}`);
  if (!data) return null;

  return {
    id: data.id,
    estado: data.estado,
    pedidoId: data.pedido_id ?? null,
    blingPedidoId: data.bling_pedido_id ?? null,
    atualizadaEm: data.updated_at,
  };
}

/**
 * **Nunca lança.** Toda falha vira `TentativaIndisponivel` — inclusive
 * `42P01` (tabela/RPC da migration 59 ausente). A versão anterior tratava
 * `42P01` como "segue sem a proteção" (`TentativaNova`); a 4ª rodada de
 * revisão apontou, corretamente, que isso desliga silenciosamente a
 * garantia que a migration 59 existe para dar — código novo contra banco
 * antigo voltaria a poder duplicar no Bling numa retentativa, exatamente a
 * janela que a fatia 3 foi escrita para fechar. Falha fechada: sem
 * conseguir reivindicar, o handler não chama o Bling.
 */
async function reivindicarTentativa(
  scope: VerifiedOrganizationScope,
  referenciaLocal: string,
  fingerprint: string,
): Promise<ReivindicacaoDeTentativa> {
  const { data, error } = await supabaseServer.rpc('reivindicar_tentativa_venda_manual', {
    p_organizacao_id: scope.organizationId,
    p_referencia_local: referenciaLocal,
    p_fingerprint: fingerprint,
  });

  if (error) {
    return { _tag: 'TentativaIndisponivel', causa: new Error(`Falha ao reivindicar a tentativa de venda: ${error.message}`) };
  }

  const linha = Array.isArray(data) ? data[0] : data;
  if (!linha) {
    return { _tag: 'TentativaIndisponivel', causa: new Error('reivindicar_tentativa_venda_manual não devolveu linha nenhuma') };
  }

  // Conflito de conteúdo antes de qualquer outra leitura: a mesma chave para
  // OUTRA venda não é retentativa, e o desfecho da outra operação não pode
  // vazar para esta (5ª rodada de revisão).
  if (linha.fingerprint_conflitante) {
    return { _tag: 'TentativaConflitante' };
  }

  if (!linha.is_duplicate) {
    return { _tag: 'TentativaNova', tentativaId: linha.tentativa_id };
  }
  if (linha.estado === 'concluida') {
    return { _tag: 'TentativaConcluida', pedidoId: linha.pedido_id, blingPedidoId: linha.bling_pedido_id ?? null };
  }
  if (linha.estado === 'indeterminada') {
    return { _tag: 'TentativaIndeterminada', blingPedidoId: linha.bling_pedido_id ?? null };
  }
  // 'em_andamento': uma tentativa concorrente com a mesma referência ainda
  // está executando.
  return { _tag: 'TentativaEmAndamento' };
}

/**
 * Grava o desfecho final de uma tentativa já reivindicada. Ver
 * `reivindicarTentativa`.
 *
 * A organização entra como argumento porque a RPC é `security definer` e
 * ignora RLS: o predicado dentro dela é a única barreira contra concluir uma
 * tentativa de outra organização (5ª rodada de revisão).
 */
async function registrarDesfechoDaTentativa(
  scope: VerifiedOrganizationScope,
  tentativaId: string,
  desfecho: DesfechoDaTentativa,
): Promise<void> {
  const { error } = await supabaseServer.rpc('concluir_tentativa_venda_manual', {
    p_organizacao_id: scope.organizationId,
    p_tentativa_id: tentativaId,
    p_estado: desfecho.estado,
    p_pedido_id: desfecho.pedidoId ?? null,
    p_bling_pedido_id: desfecho.blingPedidoId ?? null,
  });

  if (error && error.code !== '42P01') {
    // Não deixa a venda cair por causa do REGISTRO do desfecho — a venda em
    // si já foi decidida antes desta chamada. Só loga: sem isto, a próxima
    // tentativa com a mesma referência ficaria presa em 'em_andamento' para
    // sempre.
    registrarFalhaInterna('pedidos.manual.tentativa.concluir', error);
  }
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
 * **Falha definitiva × falha ambígua (ticket 30, fatia 3, endurecida na 3ª
 * rodada de revisão).** A classificação vive em `classificacaoDeFalha.ts`,
 * **por reconhecimento positivo** — só é definitiva uma falha cujo `code`
 * bate um formato conhecido de SQLSTATE/PostgREST, e qualquer coisa não
 * reconhecida cai em ambígua por padrão, nunca o contrário. A dependência de
 * versão que sustenta essa fronteira, e a regressão que a prova sem depender
 * só da leitura do código-fonte instalado, estão documentadas em
 * `DEPENDENCIA_DE_VERSAO.md` e `classificacaoDeFalha.test.ts`.
 *
 * O caso do `data` que não é `string` também é `Ambigua` — deliberadamente,
 * mesmo sabendo que `res.ok` prova que a RPC comitou. É um formato de
 * resposta que o código não reconhece, e a política conservadora trata
 * "não reconheço" como "não decido sozinho", não como uma segunda categoria
 * de certeza.
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
    const causa = new Error(error.message);
    return classificarErroDePersistencia(error) === 'Definitiva'
      ? { _tag: 'PersistVendaFalhouDefinitivamente', causa }
      : { _tag: 'PersistVendaAmbigua', causa };
  }
  if (typeof data !== 'string') {
    return {
      _tag: 'PersistVendaAmbigua',
      causa: new Error('a venda foi registrada mas o banco não devolveu o id do pedido no formato esperado'),
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
    buscarPedidoPorNumeroLoja: (numeroLoja) => client.buscarPedidoVendaPorNumeroLoja(numeroLoja),
    cancelarPedidoVenda: (pedidoBlingId) => client.cancelarPedidoVenda(pedidoBlingId),
  };
}

/**
 * Monta as dependências de produção para o escopo verificado.
 *
 * Uma única função para as duas rotas: a de criação e a de reconciliação
 * enxergam exatamente os mesmos adapters, com o mesmo escopo.
 */
export function criarManualOrderDependencies(
  scope: VerifiedOrganizationScope,
): Omit<ManualOrderDependencies, 'auth'> {
  return {
    store: supabaseManualOrderStore(),
    bling: blingManualOrderAdapter(bling.forVerifiedOrganization(scope)),
    now: () => new Date(),
    newLocalReference,
    dormir: dormirDeVerdade,
  };
}
