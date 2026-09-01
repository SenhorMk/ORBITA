import { z } from 'zod';

import type { RequestOrganizationScopeResult } from '../../../../../lib/requestOrganizationContext';
import { escopoTemCapacidade, type VerifiedOrganizationScope } from '../../../../../lib/verifiedOrganizationScope';
import type { OrderAccessResult } from '../../../../../services/orderAccess';

const orderIdentifierSchema = z.string().trim().min(1).max(160);
const orderChangesSchema = z.record(z.string(), z.unknown());

/**
 * Order operations consumed by the HTTP adapter.
 *
 * Ticket 22 — o port recebia o `tenant` do `ActorContext`, resolvido de
 * `app_metadata`, e cada adaptador o convertia em organização por conta
 * própria. Passou a receber a organização já verificada.
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

      return orderResultResponse(
        await dependencies.orders.update(
          scopeResult.scope,
          externalId,
          changesResult.data,
        ),
      );
    },
  };
}
