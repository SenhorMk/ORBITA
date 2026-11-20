import { NextResponse } from 'next/server';
import { z } from 'zod';

import { classificarFalhaDeCriacaoNoBling } from '@/lib/integrations/bling/classificacaoDeFalhaDeCriacao';
import { blingFailure, type BlingCallResult, type BlingProviderFailure } from '@/lib/integrations/bling/pedidoVendaContract';
import type { Situacao } from '@/lib/integrations/bling/situacoesContract';
import { logger, sanitizeErrorForLog } from '@/lib/observability/logger';
import { mapBlingStatus } from '@/lib/utils';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import type {
  PedidoStatusBlingPort,
  PedidoStatusPedido,
  PedidoStatusDependencies,
  PedidoStatusResponseBody,
  PedidoStatusStorePort,
} from './ports';

export type {
  PedidoStatusAuthPort,
  PedidoStatusBlingPort,
  PedidoStatusDependencies,
  PedidoStatusPedido,
  PedidoStatusProduto,
  PedidoStatusResponseBody,
  PedidoStatusStorePort,
} from './ports';

function json(body: PedidoStatusResponseBody, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

/**
 * SQLSTATE: exatamente cinco caracteres alfanuméricos maiúsculos (`42501`,
 * `23505`, `PGRST201`… — este último não passa, e é o ponto).
 *
 * O `code` do erro é texto que vem de fora. Sem validar, ele próprio seria um
 * canal para empurrar conteúdo arbitrário para dentro do log estruturado.
 */
const CODIGO_SQLSTATE = /^[0-9A-Z]{5}$/u;

/** Código técnico do erro, apenas se for um SQLSTATE reconhecível. */
function codigoTecnicoValidado(erro: unknown): string | undefined {
  const bruto = (erro as { code?: unknown } | null | undefined)?.code;
  return typeof bruto === 'string' && CODIGO_SQLSTATE.test(bruto) ? bruto : undefined;
}

/**
 * Registra a falha no servidor sem carregar nada que não possa ser lido depois.
 *
 * Deliberadamente **não** registra `message`, `details` nem `hint`. Numa
 * violação de unicidade o Postgres coloca valores de linha dentro deles
 * (`Key (email)=(...) already exists`), ou seja, dado de cliente — e
 * `descreverErro` sozinho não resolve isso, porque o trabalho dele é tornar o
 * erro legível, não decidir o que pode sair daqui.
 *
 * O que fica: qual operação falhou, em qual organização, a classe do erro e o
 * SQLSTATE. É o suficiente para saber onde olhar.
 */
function registrarFalhaInterna(erro: unknown, organizacaoId: string | undefined): void {
  logger.error('Falha ao atualizar situação do pedido', {
    subsystem: 'app',
    operacao: 'pedidos.status.atualizar',
    organizacaoId,
    erro: sanitizeErrorForLog(erro).name,
    codigo: codigoTecnicoValidado(erro),
  });
}

/**
 * Corpo de `POST /api/pedidos/status`. Os ids de situação são por conta
 * (`GET /situacoes/modulos/{idModuloSistema}`), então o valor vem do cliente —
 * mas precisa ser um inteiro positivo, porque compõe o caminho da chamada ao
 * Bling.
 */
const statusRequestSchema = z.object({
  pedidoId: z.string().uuid('pedidoId deve ser um UUID'),
  novaSituacaoId: z.coerce.number().int().positive('novaSituacaoId deve ser um inteiro positivo'),
  novaSituacaoNome: z.string().trim().min(1, 'novaSituacaoNome é obrigatório').max(60),
});

/** Quantos produtos ficaram de fora do alinhamento, e se o saldo nem foi conferido. */
interface ResultadoDoAlinhamento {
  readonly alinhados: number;
  readonly pendentes: number;
  readonly conferido: boolean;
}

/**
 * Alinha o estoque local dos produtos do pedido ao saldo do Bling.
 *
 * A situação já mudou nos dois lados quando isto roda: nenhuma falha aqui
 * derruba a requisição — vira pendência, contada e devolvida como aviso. Cada
 * escrita é condicional ao valor lido e lança o delta no livro
 * (`store.alinharEstoque`); repetir não lança de novo.
 */
async function alinharEstoqueComBling(
  scope: VerifiedOrganizationScope,
  store: PedidoStatusStorePort,
  bling: PedidoStatusBlingPort,
  pedidoId: string,
): Promise<ResultadoDoAlinhamento> {
  const nada: ResultadoDoAlinhamento = { alinhados: 0, pendentes: 0, conferido: true };
  let produtos: readonly { id: string; blingId: string | null; estoque: number | null }[];
  try {
    const produtoIds = await store.findProdutoIdsDoPedido(scope, pedidoId);
    if (produtoIds.length === 0) return nada;
    produtos = await store.findProdutosByIds(scope, produtoIds);
  } catch (err: unknown) {
    registrarFalhaInterna(err, scope.organizationId);
    return { alinhados: 0, pendentes: 0, conferido: false };
  }

  const comBlingId = produtos.filter((p): p is typeof p & { blingId: string } => Boolean(p.blingId));
  if (comBlingId.length === 0) return nada;

  let saldos: ReadonlyMap<string, number>;
  try {
    saldos = await bling.getSaldos(comBlingId.map((p) => p.blingId));
  } catch (err: unknown) {
    registrarFalhaInterna(err, scope.organizationId);
    return { alinhados: 0, pendentes: 0, conferido: false };
  }

  let alinhados = 0;
  let pendentes = 0;
  for (const produto of comBlingId) {
    const saldo = saldos.get(produto.blingId);
    if (saldo === undefined) { pendentes += 1; continue; }
    if (produto.estoque === saldo) continue;
    try {
      const desfecho = await store.alinharEstoque(scope, produto.id, produto.estoque, saldo);
      if (desfecho === 'alinhado') alinhados += 1;
      else if (desfecho !== 'ja_alinhado') pendentes += 1;
    } catch (err: unknown) {
      registrarFalhaInterna(err, scope.organizationId);
      pendentes += 1;
    }
  }
  return { alinhados, pendentes, conferido: true };
}

const AVISO_ESTOQUE_NAO_CONFERIDO = 'Situação alterada, mas o estoque não foi conferido com o Bling. Sincronize para reconciliar.';
const avisoDePendencias = (n: number) =>
  `Situação alterada, mas ${n} produto(s) não tiveram o estoque alinhado ao Bling. Sincronize para reconciliar.`;

/**
 * Muda a situação de um pedido no Bling e reflete o resultado no ORBITA.
 *
 * A ordem é deliberada: o Bling decide primeiro. Se ele recusar, nada muda
 * localmente — é o princípio "o Bling é a fonte da verdade e só agimos com base
 * na resposta dele".
 */
/** Corpo validado, ou a recusa com 400 — antes de qualquer leitura ou efeito. */
async function lerMudanca(request: Request): Promise<z.infer<typeof statusRequestSchema> | NextResponse> {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return json({ error: 'Corpo da requisição não é um JSON válido.' }, 400);
  }
  const parsedBody = statusRequestSchema.safeParse(rawBody);
  if (parsedBody.success) return parsedBody.data;
  const detalhes = parsedBody.error.issues
    .map((issue) => `${issue.path.join('.') || 'corpo'}: ${issue.message}`)
    .join('; ');
  return json({ error: `Dados inválidos: ${detalhes}` }, 400);
}

type Evento = (acao: string, metadata: Readonly<Record<string, string | number | boolean | null>>) => Promise<void>;

/** Recusa comprovada → 400; qualquer outra falha pode ter mudado a situação → 502 desconhecido. */
async function respostaDaFalhaNaSituacao(failure: BlingProviderFailure, situacaoId: number, evento: Evento): Promise<NextResponse> {
  if (classificarFalhaDeCriacaoNoBling(failure) === 'Definitiva') {
    await evento('order.status_change_rejected', { situacao_id: situacaoId, status_http: failure.status });
    return json({ error: `O Bling recusou a mudança de situação: ${failure.message}` }, 400);
  }
  await evento('order.reconcile_required', { operacao: 'situacao', motivo: 'bling_sem_confirmacao', situacao_id: situacaoId });
  return json({
    error: 'O Bling não confirmou a mudança de situação, e ela pode ter sido aplicada. Sincronize e confira o pedido antes de repetir.',
    reconciliacao: { motivo: 'bling_sem_confirmacao' },
  }, 502);
}

const normalizarNome = (nome: string) => nome.trim().toLocaleLowerCase('pt-BR');

/**
 * Confere o par (id, nome) contra as situações de pedido de venda da conta.
 *
 * Sem isto, o id ia ao Bling e o nome enviado pelo navegador decidia o status
 * local: `{ id: <Em aberto>, nome: 'Atendido' }` deixava o Bling numa situação
 * e o ORBITA noutra. Leitura falha não autoriza a mudança — nada sai daqui.
 */
async function confirmarSituacao(
  bling: PedidoStatusBlingPort,
  situacaoId: number,
  nomeInformado: string,
): Promise<Situacao | NextResponse> {
  const lidas = await semExcecao(() => bling.situacoes());
  if (lidas._tag === 'BlingFailed') {
    return json({ error: 'Não foi possível confirmar a situação na conta do Bling. Nada foi alterado; tente de novo.' }, 502);
  }
  const situacao = lidas.value.find((s) => s.id === situacaoId);
  if (!situacao) return json({ error: 'Situação não encontrada nas situações de venda desta conta do Bling.' }, 400);
  if (normalizarNome(situacao.nome) !== normalizarNome(nomeInformado)) {
    return json({ error: 'O nome da situação não corresponde ao id informado. Recarregue as situações e tente de novo.' }, 400);
  }
  return situacao;
}

/**
 * O que se sabe do estorno de estoque do cancelamento.
 * - `estornado`: o Bling confirmou.
 * - `recusado`: recusa comprovada (`classificarFalhaDeCriacaoNoBling` = Definitiva). NÃO se presume o motivo:
 *   um 400 não prova "pedido sem estoque lançado".
 * - `desconhecido`: timeout, rede, 429, 5xx, resposta ilegível: o estorno pode ter sido aplicado. Sem retry.
 * - `ja_cancelado`: o pedido já estava cancelado no ORBITA antes desta requisição; repetir o estorno o dobraria.
 */
type DesfechoDoEstorno = 'nao_aplicavel' | 'ja_cancelado' | 'estornado' | 'recusado' | 'desconhecido';

/** Estorno do cancelamento (se couber) e espera pelas rotinas de estoque do Bling, antes de reler o saldo. */
async function prepararReleituraDoSaldo(
  deps: Pick<PedidoStatusDependencies, 'bling' | 'aguardarProcessamentoBling'>,
  novoStatusCanonico: string,
  pedidoLocal: PedidoStatusPedido,
  evento: Evento,
): Promise<{ readonly desfecho: DesfechoDoEstorno; readonly mensagemDoBling: string | null }> {
  let desfecho: DesfechoDoEstorno = 'nao_aplicavel';
  let mensagemDoBling: string | null = null;
  if (novoStatusCanonico === 'Cancelado' && mapBlingStatus(pedidoLocal.status) === 'Cancelado') {
    desfecho = 'ja_cancelado';
    await evento('order.stock_reversal', { resultado: desfecho, status_http: null });
  } else if (novoStatusCanonico === 'Cancelado') {
    const estorno = await semExcecao(() => deps.bling.estornarEstoque(pedidoLocal.bling_id));
    if (estorno._tag === 'BlingOk') desfecho = 'estornado';
    else {
      desfecho = classificarFalhaDeCriacaoNoBling(estorno.failure) === 'Definitiva' ? 'recusado' : 'desconhecido';
      mensagemDoBling = desfecho === 'recusado' ? estorno.failure.message : null;
    }
    await evento('order.stock_reversal', {
      resultado: desfecho,
      status_http: estorno._tag === 'BlingFailed' ? estorno.failure.status : null,
    });
  }
  // O Bling roda as rotinas de estoque de forma assíncrona depois de aceitar
  // a mudança; ler o saldo imediatamente traria o valor antigo.
  await deps.aguardarProcessamentoBling();
  return { desfecho, mensagemDoBling };
}

const AVISO_ESTORNO_RECUSADO = (mensagem: string | null) =>
  `Pedido cancelado, mas o Bling recusou o estorno do estoque${mensagem ? ` (${mensagem})` : ''}. `
  + 'Confira o saldo no Bling antes de qualquer ajuste; não repita o cancelamento.';
const AVISO_ESTORNO_DESCONHECIDO = 'Pedido cancelado, mas o Bling não confirmou o estorno do estoque, e ele pode ter sido aplicado. '
  + 'Confira o saldo no Bling antes de qualquer ajuste; não repita o cancelamento.';
const AVISO_JA_CANCELADO = 'O pedido já estava cancelado: nenhum novo estorno de estoque foi feito, para não devolver o estoque duas vezes.';

/**
 * A resposta depois da situação confirmada. O estorno não confirmado é pendência mesmo com os saldos
 * coincidindo: Bling e ORBITA em 7 não provam que a unidade voltou.
 */
async function respostaDoEstoque(
  novoStatusCanonico: string,
  novaSituacaoId: number,
  estorno: { readonly desfecho: DesfechoDoEstorno; readonly mensagemDoBling: string | null },
  estoque: { readonly conferido: boolean; readonly alinhados: number; readonly pendentes: number },
  evento: Evento,
): Promise<NextResponse> {
  const estornoNaoConfirmado = estorno.desfecho === 'recusado' || estorno.desfecho === 'desconhecido';
  await evento('order.status_changed', {
    situacao_id: novaSituacaoId,
    estoque: !estoque.conferido ? 'nao_conferido' : estoque.pendentes > 0 ? 'parcial' : 'alinhado',
    produtos_alinhados: estoque.alinhados,
    produtos_pendentes: estoque.pendentes,
    ...(estorno.desfecho === 'nao_aplicavel' ? {} : { estorno: estorno.desfecho }),
  });
  const avisos = [
    estorno.desfecho === 'recusado' ? AVISO_ESTORNO_RECUSADO(estorno.mensagemDoBling) : null,
    estorno.desfecho === 'desconhecido' ? AVISO_ESTORNO_DESCONHECIDO : null,
    estorno.desfecho === 'ja_cancelado' ? AVISO_JA_CANCELADO : null,
    !estoque.conferido ? AVISO_ESTOQUE_NAO_CONFERIDO : estoque.pendentes > 0 ? avisoDePendencias(estoque.pendentes) : null,
  ].filter((aviso): aviso is string => aviso !== null);
  const pendente = estornoNaoConfirmado || !estoque.conferido || estoque.pendentes > 0;
  return json({
    success: true,
    status: novoStatusCanonico,
    estoque: pendente ? 'requer_reconciliacao' : 'alinhado',
    ...(avisos.length > 0 ? { warning: avisos.join(' ') } : {}),
  }, 200);
}

export function createPedidoStatusHandler(deps: PedidoStatusDependencies) {
  const { auth, store, bling, auditar } = deps;

  return async function handlePedidoStatus(request: Request): Promise<NextResponse> {
    // Fora do `try` para que o log da falha saiba a organização mesmo quando o
    // erro acontece depois da resolução do escopo.
    let organizacaoId: string | undefined;
    try {
      const ator = await auth.authenticate(request);
      if (!ator) return json({ error: 'Não autorizado' }, 401);

      const scopeResult = await auth.resolveScope(request);
      if (scopeResult._tag !== 'Resolved') return scopeResult.response;
      const { scope } = scopeResult;
      organizacaoId = scope.organizationId;

      const mudancaPedida = await lerMudanca(request);
      if (mudancaPedida instanceof NextResponse) return mudancaPedida;
      const { pedidoId, novaSituacaoId, novaSituacaoNome } = mudancaPedida;

      // Ler dentro do escopo é o que nega o pedido de outra organização: para
      // quem está fora, ele simplesmente não existe — 404, não 403, porque a
      // resposta não deve revelar que o pedido existe em algum outro lugar.
      const pedidoLocal = await store.findPedidoById(scope, pedidoId);
      if (!pedidoLocal || !pedidoLocal.bling_id) {
        return json({ error: 'Pedido não encontrado ou sem ID do Bling' }, 404);
      }

      const correlationId = deps.correlationId(request);
      const evento: Evento = (acao, metadata) =>
        auditar(scope, { acao, recurso: 'pedido', recursoId: pedidoId, correlationId, metadata: { pedido_id: pedidoId, ...metadata } });

      // Antes de qualquer efeito: o id tem de existir na conta, com o nome que
      // o navegador mostrou. Divergência ou leitura falha → nada é alterado.
      const confirmacao = await confirmarSituacao(bling, novaSituacaoId, novaSituacaoNome);
      if (confirmacao instanceof NextResponse) return confirmacao;
      const situacaoConfirmada = confirmacao;

      // Timeout, conexão perdida, 5xx, 429: o Bling pode ter mudado a situação.
      const mudanca = await semExcecao(() => bling.updateSituacaoPedido(pedidoLocal.bling_id, novaSituacaoId));
      if (mudanca._tag === 'BlingFailed') return respostaDaFalhaNaSituacao(mudanca.failure, novaSituacaoId, evento);

      // O status local vem do nome que a conta confirmou para o id, nunca do
      // texto do navegador (`confirmarSituacao`, antes da mutação).
      const novoStatusCanonico = mapBlingStatus(situacaoConfirmada.nome);
      try {
        await store.savePedidoStatus(scope, pedidoLocal, novoStatusCanonico);
      } catch (err: unknown) {
        registrarFalhaInterna(err, organizacaoId);
        await evento('order.reconcile_required', { operacao: 'situacao', motivo: 'espelho_local_falhou', situacao_id: novaSituacaoId });
        return json({
          error: 'A situação foi alterada no Bling, mas não no ORBITA. Sincronize os pedidos para reconciliar; não repita a mudança.',
          reconciliacao: { motivo: 'espelho_local_falhou' },
        }, 500);
      }

      const estorno = await prepararReleituraDoSaldo(deps, novoStatusCanonico, pedidoLocal, evento);
      const estoque = await alinharEstoqueComBling(scope, store, bling, pedidoId);
      return respostaDoEstoque(novoStatusCanonico, novaSituacaoId, estorno, estoque, evento);
    } catch (error: unknown) {
      // CWE-209: o diagnóstico do Postgres fica no servidor. O cliente recebe
      // sempre a mesma frase — `message` inclusive, que pode carregar valor de
      // linha tanto quanto `details`. Só chega aqui o que falhou ANTES de
      // qualquer efeito no Bling (leitura do pedido).
      registrarFalhaInterna(error, organizacaoId);
      return json({ error: 'Erro interno' }, 500);
    }
  };
}

/** Exceção ao falar com o Bling (rede, timeout) é desfecho desconhecido, nunca 500 genérico. */
async function semExcecao<T>(chamada: () => Promise<BlingCallResult<T>>): Promise<BlingCallResult<T>> {
  try {
    return await chamada();
  } catch (erro: unknown) {
    return blingFailure('UNKNOWN_ERROR', 0, sanitizeErrorForLog(erro).name);
  }
}
