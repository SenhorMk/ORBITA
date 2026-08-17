import { describe, expect, it } from 'vitest';

import { resolveActorContext, type AuthUserLookup } from '../../../../../lib/auth';
import {
  OrderAccess,
  type OrderProvider,
  type OrderRecord,
  type OrderStore,
} from '../../../../../services/orderAccess';

import { createOrderByIdHandlers } from './handlers';

const OWNER_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COLLABORATOR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TENANT_B_ORDER_ID = 'bling-order-b';

const ownerLookup: AuthUserLookup = {
  async getUser(token) {
    if (token === 'collaborator-token') {
      return {
        data: {
          user: {
            id: COLLABORATOR_ID,
            app_metadata: { role: 'colaborador', tenant_id: OWNER_A_ID },
          },
        },
        error: null,
      };
    }
    const id = token === 'owner-a-token' ? OWNER_A_ID : OWNER_B_ID;
    return {
      data: { user: { id, app_metadata: { role: 'dono' } } },
      error: null,
    };
  },
};

describe('order-by-id HTTP handlers', () => {
  it('returns the same not-found response for a cross-tenant delete and preserves the order', async () => {
    const recordsByTenant = new Map<string, Map<string, OrderRecord>>([
      [OWNER_B_ID, new Map([[
        TENANT_B_ORDER_ID,
        { externalId: TENANT_B_ORDER_ID, localValue: { numero: 'B-001' } },
      ]])],
    ]);
    const store: OrderStore = {
      async findByExternalId(tenant, externalId) {
        return recordsByTenant.get(tenant.id)?.get(externalId) ?? null;
      },
      async deleteByExternalId(tenant, externalId) {
        recordsByTenant.get(tenant.id)?.delete(externalId);
      },
    };
    const provider: OrderProvider = {
      async read(_tenant, externalId) {
        return {
          _tag: 'OrderProviderSucceeded',
          value: { id: externalId, numero: 'B-001' },
        };
      },
      async update() {
        return { _tag: 'OrderProviderSucceeded', value: null };
      },
      async remove() {
        return { _tag: 'OrderProviderSucceeded', value: undefined };
      },
    };
    const handlers = createOrderByIdHandlers({
      resolveActor(request, capability) {
        return resolveActorContext(request, capability, ownerLookup);
      },
      orders: new OrderAccess(store, provider),
    });
    const routeContext = {
      params: Promise.resolve({ id: TENANT_B_ORDER_ID }),
    };

    const crossTenantReadResponse = await handlers.GET(new Request(
      `https://orbita.test/api/bling/pedidos/${TENANT_B_ORDER_ID}`,
      { headers: { Authorization: 'Bearer owner-a-token' } },
    ), routeContext);

    const deleteResponse = await handlers.DELETE(new Request(
      `https://orbita.test/api/bling/pedidos/${TENANT_B_ORDER_ID}`,
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer owner-a-token' },
      },
    ), routeContext);
    const tenantBReadResponse = await handlers.GET(new Request(
      `https://orbita.test/api/bling/pedidos/${TENANT_B_ORDER_ID}`,
      { headers: { Authorization: 'Bearer owner-b-token' } },
    ), routeContext);

    expect(crossTenantReadResponse.status).toBe(404);
    expect(await crossTenantReadResponse.json()).toEqual({
      success: false,
      error: 'Pedido não encontrado',
    });
    expect(deleteResponse.status).toBe(404);
    expect(await deleteResponse.json()).toEqual({
      success: false,
      error: 'Pedido não encontrado',
    });
    expect(tenantBReadResponse.status).toBe(200);
    expect(await tenantBReadResponse.json()).toEqual({
      success: true,
      data: { id: TENANT_B_ORDER_ID, numero: 'B-001' },
    });
  });

  it('denies an anonymous order read before touching persistence or Bling', async () => {
    const unavailableOrders = {
      async read() {
        throw new Error('Anonymous requests must not read orders.');
      },
      async update() {
        throw new Error('This test does not update orders.');
      },
      async remove() {
        throw new Error('This test does not delete orders.');
      },
    };
    const handlers = createOrderByIdHandlers({
      resolveActor(request, capability) {
        return resolveActorContext(request, capability, ownerLookup);
      },
      orders: unavailableOrders,
    });

    const response = await handlers.GET(new Request(
      'https://orbita.test/api/bling/pedidos/owned-order',
    ), { params: Promise.resolve({ id: 'owned-order' }) });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Não autorizado',
    });
  });

  it('returns the same not-found response for a cross-tenant update and preserves the order', async () => {
    const recordsByTenant = new Map<string, Map<string, OrderRecord>>([
      [OWNER_B_ID, new Map([[
        TENANT_B_ORDER_ID,
        { externalId: TENANT_B_ORDER_ID, localValue: { numero: 'B-001' } },
      ]])],
    ]);
    let providerValue: unknown = { id: TENANT_B_ORDER_ID, numero: 'B-001' };
    const store: OrderStore = {
      async findByExternalId(tenant, externalId) {
        return recordsByTenant.get(tenant.id)?.get(externalId) ?? null;
      },
      async deleteByExternalId() {
        throw new Error('This test does not delete orders.');
      },
    };
    const provider: OrderProvider = {
      async read() {
        return { _tag: 'OrderProviderSucceeded', value: providerValue };
      },
      async update(_tenant, _externalId, changes) {
        providerValue = changes;
        return { _tag: 'OrderProviderSucceeded', value: providerValue };
      },
      async remove() {
        throw new Error('This test does not delete orders.');
      },
    };
    const handlers = createOrderByIdHandlers({
      resolveActor(request, capability) {
        return resolveActorContext(request, capability, ownerLookup);
      },
      orders: new OrderAccess(store, provider),
    });
    const routeContext = { params: Promise.resolve({ id: TENANT_B_ORDER_ID }) };

    const updateResponse = await handlers.PUT(new Request(
      `https://orbita.test/api/bling/pedidos/${TENANT_B_ORDER_ID}`,
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer owner-a-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ situacao: { id: 9 } }),
      },
    ), routeContext);
    const tenantBReadResponse = await handlers.GET(new Request(
      `https://orbita.test/api/bling/pedidos/${TENANT_B_ORDER_ID}`,
      { headers: { Authorization: 'Bearer owner-b-token' } },
    ), routeContext);

    expect(updateResponse.status).toBe(404);
    expect(await updateResponse.json()).toEqual({
      success: false,
      error: 'Pedido não encontrado',
    });
    expect(await tenantBReadResponse.json()).toEqual({
      success: true,
      data: { id: TENANT_B_ORDER_ID, numero: 'B-001' },
    });
  });

  it('denies order mutations without the tenant management capability', async () => {
    const unavailableOrders = {
      async read() {
        throw new Error('This test does not read orders.');
      },
      async update() {
        throw new Error('Denied requests must not update orders.');
      },
      async remove() {
        throw new Error('Denied requests must not delete orders.');
      },
    };
    const handlers = createOrderByIdHandlers({
      resolveActor(request, capability) {
        return resolveActorContext(request, capability, ownerLookup);
      },
      orders: unavailableOrders,
    });

    const response = await handlers.DELETE(new Request(
      'https://orbita.test/api/bling/pedidos/owned-order',
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer collaborator-token' },
      },
    ), { params: Promise.resolve({ id: 'owned-order' }) });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Acesso negado',
    });
  });

  it('allows an owner to update and delete an order inside the authorized tenant', async () => {
    const ownedOrderId = 'owned-order';
    const records = new Map<string, OrderRecord>([[
      ownedOrderId,
      { externalId: ownedOrderId, localValue: { numero: 'A-001' } },
    ]]);
    let providerValue: unknown = { id: ownedOrderId, numero: 'A-001' };
    const store: OrderStore = {
      async findByExternalId(tenant, externalId) {
        return tenant.id === OWNER_A_ID ? records.get(externalId) ?? null : null;
      },
      async deleteByExternalId(_tenant, externalId) {
        records.delete(externalId);
      },
    };
    const provider: OrderProvider = {
      async read() {
        return { _tag: 'OrderProviderSucceeded', value: providerValue };
      },
      async update(_tenant, _externalId, changes) {
        providerValue = { id: ownedOrderId, ...changes };
        return { _tag: 'OrderProviderSucceeded', value: providerValue };
      },
      async remove() {
        return { _tag: 'OrderProviderSucceeded', value: undefined };
      },
    };
    const handlers = createOrderByIdHandlers({
      resolveActor(request, capability) {
        return resolveActorContext(request, capability, ownerLookup);
      },
      orders: new OrderAccess(store, provider),
    });
    const routeContext = { params: Promise.resolve({ id: ownedOrderId }) };

    const updateResponse = await handlers.PUT(new Request(
      `https://orbita.test/api/bling/pedidos/${ownedOrderId}`,
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer owner-a-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ numero: 'A-002' }),
      },
    ), routeContext);
    const deleteResponse = await handlers.DELETE(new Request(
      `https://orbita.test/api/bling/pedidos/${ownedOrderId}`,
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer owner-a-token' },
      },
    ), routeContext);
    const missingResponse = await handlers.GET(new Request(
      `https://orbita.test/api/bling/pedidos/${ownedOrderId}`,
      { headers: { Authorization: 'Bearer owner-a-token' } },
    ), routeContext);

    expect(await updateResponse.json()).toEqual({
      success: true,
      data: { id: ownedOrderId, numero: 'A-002' },
    });
    expect(await deleteResponse.json()).toEqual({
      success: true,
      message: 'Pedido apagado com sucesso',
    });
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({
      success: false,
      error: 'Pedido não encontrado',
    });
  });
});
