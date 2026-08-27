import { resolveActorContext } from '@/lib/auth';
import type { VerifiedTenant } from '@/lib/auth';
import { resolveTenantOrgId } from '@/lib/organizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import { verifyOrganizationScope, type VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { pedidoRepository } from '@/repositories/pedidoRepository';
import { bling } from '@/services/bling';
import {
  OrderAccess,
  type OrderProvider,
  type OrderProviderResult,
  type OrderStore,
} from '@/services/orderAccess';

import { createOrderByIdHandlers } from './handlers';

export const dynamic = 'force-dynamic';

function isProviderNotFound(error: unknown): boolean {
  return error instanceof Error && /(?:HTTP\s*)?404\b/i.test(error.message);
}

async function callProvider<T>(operation: () => Promise<T>): Promise<OrderProviderResult<T>> {
  try {
    return { _tag: 'OrderProviderSucceeded', value: await operation() };
  } catch (error: unknown) {
    return isProviderNotFound(error)
      ? { _tag: 'OrderProviderNotFound' }
      : { _tag: 'OrderProviderUnavailable' };
  }
}

/**
 * Re-verify the actor's organization membership server-side before any local
 * store lookup. `resolveActorContext` still yields the temporary per-user
 * `VerifiedTenant` consumed by the Bling provider adapter (external
 * credential lookup, outside this ticket's slice); every local persistence
 * call goes through this freshly verified `VerifiedOrganizationScope`
 * instead, so the primitive tenant id is never accepted as DB authority.
 */
async function toVerifiedOrganizationScope(tenant: VerifiedTenant): Promise<VerifiedOrganizationScope> {
  const organizationId = await resolveTenantOrgId(supabaseServer, tenant);
  const result = await verifyOrganizationScope(supabaseServer, {
    organizationId,
    actorId: tenant.id,
  });
  if (result._tag !== 'OrganizationScopeVerified') {
    throw new Error('Escopo organizacional não verificado.');
  }
  return result.scope;
}

const orderStore: OrderStore = {
  async findByExternalId(tenant, externalId) {
    const scope = await toVerifiedOrganizationScope(tenant);
    const pedido = await pedidoRepository.getByBlingId(scope, externalId);
    return pedido
      ? { externalId: pedido.bling_id, localValue: pedido }
      : null;
  },
  async deleteByExternalId(tenant, externalId) {
    const scope = await toVerifiedOrganizationScope(tenant);
    await pedidoRepository.deleteByBlingId(scope, externalId);
  },
};

const orderProvider: OrderProvider = {
  async read(tenant, externalId) {
    const result = await callProvider(() => bling.forUser(tenant).getPedido(externalId));
    return result._tag === 'OrderProviderSucceeded' && result.value === null
      ? { _tag: 'OrderProviderNotFound' }
      : result;
  },
  async update(tenant, externalId, changes) {
    return callProvider(() => bling.forUser(tenant).updatePedido(externalId, changes));
  },
  async remove(tenant, externalId) {
    const result = await callProvider(() => bling.forUser(tenant).deletePedido(externalId));
    return result._tag === 'OrderProviderSucceeded'
      ? { _tag: 'OrderProviderSucceeded', value: undefined }
      : result;
  },
};

const handlers = createOrderByIdHandlers({
  resolveActor(request, capability) {
    return resolveActorContext(request, capability);
  },
  orders: new OrderAccess(orderStore, orderProvider),
});

export const GET = handlers.GET;
export const DELETE = handlers.DELETE;
export const PUT = handlers.PUT;
