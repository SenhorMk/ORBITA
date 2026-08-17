import { z } from 'zod';

import {
  actorContextDenialStatus,
  type ActorCapability,
  type ActorContextResult,
} from '../../../../../lib/auth';
import type { OrderAccessResult } from '../../../../../services/orderAccess';

const orderIdentifierSchema = z.string().trim().min(1).max(160);
const orderChangesSchema = z.record(z.string(), z.unknown());

/** Order operations consumed by the HTTP adapter. */
export interface OrderAccessPort {
  readonly read: (
    tenant: Extract<ActorContextResult, { _tag: 'ActorContextResolved' }>['context']['tenant'],
    externalId: string,
  ) => Promise<OrderAccessResult<unknown>>;
  readonly update: (
    tenant: Extract<ActorContextResult, { _tag: 'ActorContextResolved' }>['context']['tenant'],
    externalId: string,
    changes: Readonly<Record<string, unknown>>,
  ) => Promise<OrderAccessResult<unknown>>;
  readonly remove: (
    tenant: Extract<ActorContextResult, { _tag: 'ActorContextResolved' }>['context']['tenant'],
    externalId: string,
  ) => Promise<OrderAccessResult<void>>;
}

/** Server-side actor resolver required by protected order handlers. */
export type OrderActorResolver = (
  request: Request,
  capability: ActorCapability,
) => Promise<ActorContextResult>;

/** Next.js route context accepted by order-by-ID handlers. */
export interface OrderByIdRouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

/** Dependencies accepted by the order-by-ID HTTP adapter. */
export interface OrderByIdHandlerDependencies {
  readonly resolveActor: OrderActorResolver;
  readonly orders: OrderAccessPort;
}

function authorizationDenial(result: Exclude<ActorContextResult, { _tag: 'ActorContextResolved' }>) {
  const status = actorContextDenialStatus(result);
  return Response.json(
    {
      success: false,
      error: status === 401 ? 'Não autorizado' : 'Acesso negado',
    },
    { status },
  );
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
      const actorResult = await dependencies.resolveActor(request, 'app:access');
      if (actorResult._tag !== 'ActorContextResolved') {
        return authorizationDenial(actorResult);
      }

      const externalId = await parseIdentifier(context);
      if (!externalId) {
        return Response.json(
          { success: false, error: 'ID do pedido obrigatório' },
          { status: 400 },
        );
      }

      return orderResultResponse(
        await dependencies.orders.read(actorResult.context.tenant, externalId),
      );
    },

    async DELETE(request: Request, context: OrderByIdRouteContext): Promise<Response> {
      const actorResult = await dependencies.resolveActor(request, 'tenant:manage');
      if (actorResult._tag !== 'ActorContextResolved') {
        return authorizationDenial(actorResult);
      }

      const externalId = await parseIdentifier(context);
      if (!externalId) {
        return Response.json(
          { success: false, error: 'ID do pedido obrigatório' },
          { status: 400 },
        );
      }

      const result = await dependencies.orders.remove(actorResult.context.tenant, externalId);
      if (result._tag !== 'OrderAccessSucceeded') return orderResultResponse(result);

      return Response.json({ success: true, message: 'Pedido apagado com sucesso' });
    },

    async PUT(request: Request, context: OrderByIdRouteContext): Promise<Response> {
      const actorResult = await dependencies.resolveActor(request, 'tenant:manage');
      if (actorResult._tag !== 'ActorContextResolved') {
        return authorizationDenial(actorResult);
      }

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
          actorResult.context.tenant,
          externalId,
          changesResult.data,
        ),
      );
    },
  };
}
