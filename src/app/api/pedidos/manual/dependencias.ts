import { randomUUID } from 'node:crypto';

import { supabaseServer } from '@/lib/supabaseServer';
import { bling } from '@/services/bling';
import type { BlingPort } from '@/services/blingPort';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';

import { classificarErroDePersistencia } from './classificacaoDeFalha';
import {
  assumirTentativaParaReconciliacao,
  encerrarIntervencao,
  finalizarIntervencaoETentativa,
  reivindicarIntervencao,
  resolverIntervencaoAmbigua,
} from './dependenciasDeReconciliacao';
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
  PosseDaTentativa,
  RegistroDeDesfecho,
  ReivindicacaoDeTentativa,
  TentativaRegistrada,
} from './ports';

/**
 * Adapters de produção da venda manual: Supabase, Bling e relógio.
 *
 * Separado de `route.ts` porque DUAS rotas os usam — a criação
 * (`POST /api/pedidos/manual`) e a reconciliação
 * (`POST /api/pedidos/manual/reconciliar`). Duplicar os adapters faria as duas
 * rotas divergirem em silêncio.
 *
 * As regras de concorrência (claim, época, CAS) vivem nas RPCs do banco; este
 * arquivo só as chama com o `organizacao_id` do escopo verificado e traduz cada
 * erro em valor tipado.
 */

/**
 * Referência da venda enviada ao Bling em `numeroLoja` — o número do pedido no
 * sistema de origem, que é o campo que o Bling reserva para isso.
 *
 * É a **referência estável** da tentativa quando o cliente envia o UUID que
 * gerou (e o reenvia nas retentativas); sem ele, cada chamada recebe um UUID
 * novo e fica sem proteção entre retentativas. Ela **não** é gravada em
 * `pedidos.bling_id` — sem
 * sincronização não existe id do Bling, e a coluna aceita NULL.
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
    confirmarPosse,
    lerTentativaPorReferencia,
    reivindicarIntervencao,
    encerrarIntervencao,
    assumirTentativaParaReconciliacao,
    finalizarIntervencaoETentativa,
    resolverIntervencaoAmbigua,
  };
}

/**
 * Lê a tentativa pela referência, dentro do escopo verificado.
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
    .select('id, estado, pedido_id, bling_pedido_id, updated_at, epoca')
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
    epoca: data.epoca,
  };
}

/**
 * CLAIM da referência (`reivindicar_tentativa_venda_manual`).
 *
 * A RPC compara a referência e os dois fingerprints com a tentativa já
 * existente e devolve: nova (com época), conflito de conteúdo, valores
 * divergentes, pendência idêntica, ou o estado da tentativa repetida.
 *
 * **Nunca lança.** Toda falha vira `TentativaIndisponivel` — inclusive
 * `42P01` (tabela/RPC ausente). Tratar infraestrutura ausente como "segue sem
 * a proteção" desligaria em silêncio a garantia contra duplicação. Falha
 * fechada: sem conseguir reivindicar, o handler não chama o Bling.
 */
async function reivindicarTentativa(
  scope: VerifiedOrganizationScope,
  referenciaLocal: string,
  fingerprint: string,
  valoresFingerprint: string,
): Promise<ReivindicacaoDeTentativa> {
  const { data, error } = await supabaseServer.rpc('reivindicar_tentativa_venda_manual', {
    p_organizacao_id: scope.organizationId,
    p_referencia_local: referenciaLocal,
    p_fingerprint: fingerprint,
    p_valores_fingerprint: valoresFingerprint,
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
  // vazar para esta.
  if (linha.fingerprint_conflitante) {
    return { _tag: 'TentativaConflitante' };
  }
  if (linha.valores_divergentes) {
    return { _tag: 'TentativaComValoresDivergentes' };
  }
  if (linha.referencia_pendente) {
    return { _tag: 'TentativaComPendenciaIdentica', referenciaPendente: linha.referencia_pendente };
  }

  if (!linha.is_duplicate) {
    return { _tag: 'TentativaNova', tentativaId: linha.tentativa_id, epoca: linha.epoca };
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
 * tentativa de outra organização. `estadoEsperado` e `epocaEsperada` formam o
 * CAS: a RPC só grava se a tentativa ainda estiver nesse estado e nessa época.
 */
async function registrarDesfechoDaTentativa(
  scope: VerifiedOrganizationScope,
  tentativaId: string,
  desfecho: DesfechoDaTentativa,
  estadoEsperado?: TentativaRegistrada['estado'],
  epocaEsperada?: number,
): Promise<RegistroDeDesfecho> {
  const { error } = await supabaseServer.rpc('concluir_tentativa_venda_manual', {
    p_organizacao_id: scope.organizationId,
    p_tentativa_id: tentativaId,
    p_estado: desfecho.estado,
    p_pedido_id: desfecho.pedidoId ?? null,
    p_bling_pedido_id: desfecho.blingPedidoId ?? null,
    p_estado_esperado: estadoEsperado ?? null,
    p_epoca_esperada: epocaEsperada ?? null,
  });

  // TODA falha vira VALOR: quem chama precisa saber que o ledger não gravou
  // para nunca responder sucesso sem garantia de idempotência durável.
  // `42P01` (infraestrutura ausente) também é não-gravado: falha fechada.
  if (error) {
    registrarFalhaInterna('pedidos.manual.tentativa.concluir', error);
    return { _tag: 'DesfechoNaoGravado', causa: new Error(error.message) };
  }

  return { _tag: 'DesfechoGravado' };
}

/**
 * "Ainda sou dono desta tentativa?" — a pergunta barata que precede cada
 * efeito externo.
 *
 * Falha fechada: não conseguir perguntar é `PosseIndeterminada`, e quem chama
 * trata isso como "não inicie o efeito", nunca como "provavelmente sim".
 */
async function confirmarPosse(
  scope: VerifiedOrganizationScope,
  tentativaId: string,
  epoca: number,
): Promise<PosseDaTentativa> {
  const { data, error } = await supabaseServer.rpc('confirmar_posse_da_tentativa', {
    p_organizacao_id: scope.organizationId,
    p_tentativa_id: tentativaId,
    p_epoca_esperada: epoca,
  });

  if (error) {
    return { _tag: 'PosseIndeterminada', causa: new Error(`Falha ao confirmar a posse da tentativa: ${error.message}`) };
  }
  if (typeof data !== 'boolean') {
    return { _tag: 'PosseIndeterminada', causa: new Error('confirmar_posse_da_tentativa não devolveu um booleano') };
  }
  return data ? { _tag: 'PosseVigente' } : { _tag: 'PossePerdida' };
}

/**
 * Grava a venda inteira numa transação única do banco, **junto com a posse da
 * tentativa e a conclusão do ledger** (`registrar_venda_manual_com_posse`,
 * migration 59, seção 10).
 *
 * Pedido, itens, baixa de estoque, título financeiro e conclusão do ledger
 * commitam juntos: ou a venda inteira existe, ou nada existe. A RPC revalida
 * cliente e produtos contra a organização, recusa estoque negativo e confere a
 * época — `55P03` significa que a posse foi perdida e NADA foi gravado.
 *
 * **A corrida com o webhook (migration 57).** Quando a venda é
 * sincronizada, o pedido nasce no Bling **antes** desta gravação — a ordem não
 * pode ser invertida, porque o `bling_id` só existe depois da criação remota.
 * O Bling então dispara `order.created`, e o webhook grava a linha em
 * `pedidos` em menos de um segundo, quase sempre **primeiro**. Por isso a RPC
 * **assume** a linha do webhook em vez de inserir outra: mesma organização,
 * mesmo `bling_id`, mesmo pedido. `uq_pedidos_org_bling` continua no lugar, e
 * assumir uma linha que **já é** venda manual continua sendo `23505` — que o
 * handler trata como falha definitiva, e dispara a compensação.
 *
 * **Falha definitiva × falha ambígua.** A classificação vive em
 * `classificacaoDeFalha.ts`, **por reconhecimento positivo** — só é definitiva
 * uma falha cujo `code` está numa allowlist de SQLSTATE ou tem o prefixo
 * `PGRST` do PostgREST, e qualquer coisa não
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
  const { data, error } = await supabaseServer.rpc('registrar_venda_manual_com_posse', {
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
    p_tentativa_id: input.tentativaId,
    p_epoca_esperada: input.epoca,
  });

  if (error) {
    // `55P03` é a posse perdida, e a RPC recusa ANTES de qualquer efeito, com
    // a linha da tentativa travada: nada foi gravado, e não há o que compensar
    // nem o que classificar.
    if (error.code === '55P03') return { _tag: 'PersistVendaSemPosse' };

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
