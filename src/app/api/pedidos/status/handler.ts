import { NextResponse } from 'next/server';
import { z } from 'zod';

import { logger, sanitizeErrorForLog } from '@/lib/observability/logger';
import { mapBlingStatus } from '@/lib/utils';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import type {
  PedidoStatusBlingPort,
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

/**
 * Alinha o saldo local dos produtos do pedido com o do Bling.
 *
 * O comportamento aqui é o mesmo de antes da extração, ramo a ramo — este
 * ticket muda a forma, não o que a rota faz. Dois desses ramos engolem a falha
 * e estão marcados: são dívida conhecida, não descuido, e mexer neles mudaria
 * a resposta da rota.
 */
async function alinharEstoqueComBling(
  scope: VerifiedOrganizationScope,
  store: PedidoStatusStorePort,
  bling: PedidoStatusBlingPort,
  pedidoId: string,
): Promise<string | undefined> {
  let produtoIds: readonly string[];
  try {
    produtoIds = await store.findProdutoIdsDoPedido(scope, pedidoId);
  } catch (err: unknown) {
    registrarFalhaInterna(err, scope.organizationId);
    return 'Status atualizado, mas falhou ao buscar itens para alinhar estoque';
  }
  if (produtoIds.length === 0) return undefined;

  let produtos: readonly { id: string; blingId: string | null; estoque: number | null }[];
  try {
    produtos = await store.findProdutosByIds(scope, produtoIds);
  } catch {
    // DÍVIDA (preservada): falha ao ler os produtos vira silêncio, e o chamador
    // recebe sucesso limpo com o estoque desalinhado. Corrigir muda a resposta
    // da rota, então fica para um ticket próprio.
    return undefined;
  }

  const comBlingId = produtos.filter((p): p is typeof p & { blingId: string } => Boolean(p.blingId));
  if (comBlingId.length === 0) return undefined;

  // Sem `try`: uma falha de leitura no Bling derruba a requisição com a causa
  // nomeada, exatamente como antes.
  const saldos = await bling.getSaldos(comBlingId.map((p) => p.blingId));

  for (const produto of comBlingId) {
    const saldo = saldos.get(produto.blingId);
    if (saldo === undefined || produto.estoque === saldo) continue;
    try {
      await store.updateEstoqueProduto(scope, produto.id, saldo);
    } catch (err: unknown) {
      // DÍVIDA (preservada): o produto que não grava fica só no log do servidor.
      registrarFalhaInterna(err, scope.organizationId);
    }
  }

  return undefined;
}

/**
 * Muda a situação de um pedido no Bling e reflete o resultado no ORBITA.
 *
 * A ordem é deliberada: o Bling decide primeiro. Se ele recusar, nada muda
 * localmente — é o princípio "o Bling é a fonte da verdade e só agimos com base
 * na resposta dele".
 */
export function createPedidoStatusHandler(deps: PedidoStatusDependencies) {
  const { auth, store, bling, aguardarProcessamentoBling } = deps;

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

      let rawBody: unknown;
      try {
        rawBody = await request.json();
      } catch {
        return json({ error: 'Corpo da requisição não é um JSON válido.' }, 400);
      }

      const parsedBody = statusRequestSchema.safeParse(rawBody);
      if (!parsedBody.success) {
        const detalhes = parsedBody.error.issues
          .map((issue) => `${issue.path.join('.') || 'corpo'}: ${issue.message}`)
          .join('; ');
        return json({ error: `Dados inválidos: ${detalhes}` }, 400);
      }
      const { pedidoId, novaSituacaoId, novaSituacaoNome } = parsedBody.data;

      // Ler dentro do escopo é o que nega o pedido de outra organização: para
      // quem está fora, ele simplesmente não existe — 404, não 403, porque a
      // resposta não deve revelar que o pedido existe em algum outro lugar.
      const pedidoLocal = await store.findPedidoById(scope, pedidoId);
      if (!pedidoLocal || !pedidoLocal.bling_id) {
        return json({ error: 'Pedido não encontrado ou sem ID do Bling' }, 404);
      }

      await bling.updateSituacaoPedido(pedidoLocal.bling_id, novaSituacaoId);

      const novoStatusCanonico = mapBlingStatus(novaSituacaoNome);
      await store.savePedidoStatus(scope, pedidoLocal, novoStatusCanonico);

      // O Bling roda as rotinas de estoque de forma assíncrona depois de aceitar
      // a mudança; ler o saldo imediatamente traria o valor antigo.
      await aguardarProcessamentoBling();

      const aviso = await alinharEstoqueComBling(scope, store, bling, pedidoId);
      if (aviso) return json({ success: true, warning: aviso }, 200);

      return json({ success: true, status: novoStatusCanonico }, 200);
    } catch (error: unknown) {
      // CWE-209: o diagnóstico do Postgres fica no servidor. O cliente recebe
      // sempre a mesma frase — `message` inclusive, que pode carregar valor de
      // linha tanto quanto `details`.
      registrarFalhaInterna(error, organizacaoId);
      return json({ error: 'Erro interno' }, 500);
    }
  };
}
