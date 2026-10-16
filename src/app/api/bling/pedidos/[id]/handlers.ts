import { z } from 'zod';

import type { RequestOrganizationScopeResult } from '../../../../../lib/requestOrganizationContext';
import { escopoTemCapacidade, type VerifiedOrganizationScope } from '../../../../../lib/verifiedOrganizationScope';
import type { OrderAccessResult } from '../../../../../services/orderAccess';
import type { AuditarComercial } from '../../../../../services/auditoriaComercial';

const orderIdentifierSchema = z.string().trim().min(1).max(160);
const orderChangesSchema = z.record(z.string(), z.unknown());

/**
 * Order operations consumed by the HTTP adapter.
 *
 * O port recebe a organização já verificada; nenhum adaptador converte
 * identidade em organização por conta própria.
 */
export interface OrderAccessPort {
  readonly read: (
    scope: VerifiedOrganizationScope,
    externalId: string,
  ) => Promise<OrderAccessResult<unknown>>;
  readonly update: (
    scope: VerifiedOrganizationScope,
    externalId: string,
    changes: Readonly<Record<string, unknown>>,
  ) => Promise<OrderAccessResult<unknown>>;
  readonly remove: (
    scope: VerifiedOrganizationScope,
    externalId: string,
  ) => Promise<OrderAccessResult<void>>;
}

/** Server-side organization resolver required by protected order handlers. */
export type OrderScopeResolver = (request: Request) => Promise<RequestOrganizationScopeResult>;

/** Next.js route context accepted by order-by-ID handlers. */
export interface OrderByIdRouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

/** Dependencies accepted by the order-by-ID HTTP adapter. */
export interface OrderByIdHandlerDependencies {
  readonly resolveScope: OrderScopeResolver;
  readonly orders: OrderAccessPort;
  /** Trilha persistente; não lança (`criarAuditoriaComercial`). */
  readonly auditar: AuditarComercial;
  readonly correlationId: (request: Request) => string;
}

type Operacao = 'edicao' | 'exclusao';

/**
 * O evento do desfecho de uma mutação. `NotFound` não gera evento: nada
 * aconteceu, nem aqui nem no Bling.
 */
function eventoDoDesfecho(
  operacao: Operacao,
  result: OrderAccessResult<unknown>,
): { readonly acao: string; readonly metadata: Readonly<Record<string, string>> } | null {
  switch (result._tag) {
    case 'OrderAccessSucceeded':
      return { acao: operacao === 'edicao' ? 'order.updated' : 'order.deleted', metadata: {} };
    case 'OrderAccessUnavailable':
      return { acao: 'order.reconcile_required', metadata: { operacao, motivo: 'bling_sem_confirmacao' } };
    case 'OrderRemovedRemotelyOnly':
      return { acao: 'order.reconcile_required', metadata: { operacao, motivo: 'espelho_local_falhou' } };
    default:
      return null;
  }
}

async function auditarDesfecho(
  dependencies: OrderByIdHandlerDependencies,
  request: Request,
  scope: VerifiedOrganizationScope,
  externalId: string,
  operacao: Operacao,
  result: OrderAccessResult<unknown>,
): Promise<void> {
  const evento = eventoDoDesfecho(operacao, result);
  if (!evento) return;
  await dependencies.auditar(scope, {
    acao: evento.acao,
    recurso: 'pedido',
    recursoId: externalId,
    correlationId: dependencies.correlationId(request),
    metadata: { bling_pedido_id: externalId, ...evento.metadata },
  });
}

/** Negação por falta de capacidade de gestão, com o mesmo corpo de antes. */
function gestaoNegada(): Response {
  return Response.json({ success: false, error: 'Acesso negado' }, { status: 403 });
}

async function parseIdentifier(context: OrderByIdRouteContext): Promise<string | null> {
  const { id } = await context.params;
  try {
    const result = orderIdentifierSchema.safeParse(decodeURIComponent(id));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function orderResultResponse<T>(result: OrderAccessResult<T>): Response {
  if (result._tag === 'OrderNotFound') {
    return Response.json(
      { success: false, error: 'Pedido não encontrado' },
      { status: 404 },
    );
  }
  if (result._tag === 'OrderAccessUnavailable') {
    return Response.json(
      { success: false, error: 'Operação de pedido indisponível' },
      { status: 502 },
    );
  }
  if (result._tag === 'OrderRemovedRemotelyOnly') {
    return Response.json(
      { success: false, error: 'Pedido apagado no Bling, mas não no ORBITA. Repita a exclusão para concluir.', reconciliacao: { motivo: 'espelho_local_falhou' } },
      { status: 502 },
    );
  }
  return Response.json({ success: true, data: result.value });
}

/** Create protected order-by-ID handlers over the tenant-aware order module. */
export function createOrderByIdHandlers(dependencies: OrderByIdHandlerDependencies) {
  return {
    async GET(request: Request, context: OrderByIdRouteContext): Promise<Response> {
      const scopeResult = await dependencies.resolveScope(request);
      if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;

      const externalId = await parseIdentifier(context);
      if (!externalId) {
        return Response.json(
          { success: false, error: 'ID do pedido obrigatório' },
          { status: 400 },
        );
      }

      return orderResultResponse(
        await dependencies.orders.read(scopeResult.scope, externalId),
      );
    },

    async DELETE(request: Request, context: OrderByIdRouteContext): Promise<Response> {
      const scopeResult = await dependencies.resolveScope(request);
      if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
      if (!escopoTemCapacidade(scopeResult.scope, 'organization:manage')) return gestaoNegada();

      const externalId = await parseIdentifier(context);
      if (!externalId) {
        return Response.json(
          { success: false, error: 'ID do pedido obrigatório' },
          { status: 400 },
        );
      }

      const result = await dependencies.orders.remove(scopeResult.scope, externalId);
      await auditarDesfecho(dependencies, request, scopeResult.scope, externalId, 'exclusao', result);
      if (result._tag !== 'OrderAccessSucceeded') return orderResultResponse(result);

      return Response.json({ success: true, message: 'Pedido apagado com sucesso' });
    },

    async PUT(request: Request, context: OrderByIdRouteContext): Promise<Response> {
      const scopeResult = await dependencies.resolveScope(request);
      if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
      if (!escopoTemCapacidade(scopeResult.scope, 'organization:manage')) return gestaoNegada();

      const externalId = await parseIdentifier(context);
      if (!externalId) {
        return Response.json(
          { success: false, error: 'ID do pedido obrigatório' },
          { status: 400 },
        );
      }

      let untrustedBody: unknown;
      try {
        untrustedBody = await request.json();
      } catch {
        return Response.json(
          { success: false, error: 'Corpo da requisição inválido' },
          { status: 400 },
        );
      }

      const changesResult = orderChangesSchema.safeParse(untrustedBody);
      if (!changesResult.success) {
        return Response.json(
          { success: false, error: 'Dados do pedido inválidos' },
          { status: 400 },
        );
      }

      const result = await dependencies.orders.update(scopeResult.scope, externalId, changesResult.data);
      await auditarDesfecho(dependencies, request, scopeResult.scope, externalId, 'edicao', result);
      return orderResultResponse(result);
    },
  };
}
