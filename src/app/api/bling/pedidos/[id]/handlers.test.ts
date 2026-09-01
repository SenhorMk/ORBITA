import { describe, expect, it } from 'vitest';

import { NextResponse } from 'next/server';

import type { RequestOrganizationScopeResult } from '../../../../../lib/requestOrganizationContext';
import type { VerifiedOrganizationScope } from '../../../../../lib/verifiedOrganizationScope';
import {
  OrderAccess,
  type OrderProvider,
  type OrderRecord,
  type OrderStore,
} from '../../../../../services/orderAccess';

import { createOrderByIdHandlers } from './handlers';

/**
 * Ticket 22 — o isolamento provado aqui era entre *tenants pessoais*, com as
 * personas vindo de `app_metadata`. Passou a ser entre **organizações**, que é
 * a autoridade que o resto do aplicativo usa. O que o teste garante não mudou:
 * pedido de outra organização responde 404, igual a pedido inexistente, e a
 * mutação sem capacidade de gestão responde 403.
 */

const ORG_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ATOR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TENANT_B_ORDER_ID = 'bling-order-b';

function escopo(organizationId: string, role: 'owner' | 'admin' | 'member'): VerifiedOrganizationScope {
  return { organizationId, actorId: ATOR_ID, role } as VerifiedOrganizationScope;
}

/** Resolvedor que lê o bearer só para escolher qual escopo devolver. */
const resolveScope = async (request: Request): Promise<RequestOrganizationScopeResult> => {
  const token = /^Bearer\s+(.+)$/iu.exec(request.headers.get('Authorization') ?? '')?.[1];
  const porToken: Readonly<Record<string, VerifiedOrganizationScope>> = {
    'owner-a-token': escopo(ORG_A_ID, 'owner'),
    'owner-b-token': escopo(ORG_B_ID, 'owner'),
    'collaborator-token': escopo(ORG_A_ID, 'member'),
  };
  const encontrado = token ? porToken[token] : undefined;
  if (!encontrado) {
    return {
      _tag: 'RequestScopeDenied',
      response: NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 }),
    };
  }
  return { _tag: 'RequestScopeResolved', scope: encontrado };
};

describe('order-by-id HTTP handlers', () => {
  it('returns the same not-found response for a cross-organization delete and preserves the order', async () => {
    const registrosPorOrganizacao = new Map<string, Map<string, OrderRecord>>([
      [ORG_B_ID, new Map([[
        TENANT_B_ORDER_ID,
        { externalId: TENANT_B_ORDER_ID, localValue: { numero: 'B-001' } },
      ]])],
    ]);
    const store: OrderStore = {
      async findByExternalId(scope, externalId) {
        return registrosPorOrganizacao.get(scope.organizationId)?.get(externalId) ?? null;
      },
      async deleteByExternalId(scope, externalId) {
        registrosPorOrganizacao.get(scope.organizationId)?.delete(externalId);
      },
    };
    const provider: OrderProvider = {
      async read(_scope, externalId) {
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
      resolveScope,
      orders: new OrderAccess(store, provider),
    });
    const routeContext = {
      params: Promise.resolve({ id: TENANT_B_ORDER_ID }),
    };

    const respostaLeituraCruzada = await handlers.GET(new Request(
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
    const respostaOrgB = await handlers.GET(new Request(
      `https://orbita.test/api/bling/pedidos/${TENANT_B_ORDER_ID}`,
      { headers: { Authorization: 'Bearer owner-b-token' } },
    ), routeContext);

    expect(respostaLeituraCruzada.status).toBe(404);
    expect(await respostaLeituraCruzada.json()).toEqual({
      success: false,
      error: 'Pedido não encontrado',
    });
    expect(deleteResponse.status).toBe(404);
    expect(await deleteResponse.json()).toEqual({
      success: false,
      error: 'Pedido não encontrado',
    });
    expect(respostaOrgB.status).toBe(200);
    expect(await respostaOrgB.json()).toEqual({
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
      resolveScope,
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

  it('returns the same not-found response for a cross-organization update and preserves the order', async () => {
    const registrosPorOrganizacao = new Map<string, Map<string, OrderRecord>>([
      [ORG_B_ID, new Map([[
        TENANT_B_ORDER_ID,
        { externalId: TENANT_B_ORDER_ID, localValue: { numero: 'B-001' } },
      ]])],
    ]);
    let providerValue: unknown = { id: TENANT_B_ORDER_ID, numero: 'B-001' };
    const store: OrderStore = {
      async findByExternalId(scope, externalId) {
        return registrosPorOrganizacao.get(scope.organizationId)?.get(externalId) ?? null;
      },
      async deleteByExternalId() {
        throw new Error('This test does not delete orders.');
      },
    };
    const provider: OrderProvider = {
      async read() {
        return { _tag: 'OrderProviderSucceeded', value: providerValue };
      },
      async update(_scope, _externalId, changes) {
        providerValue = changes;
        return { _tag: 'OrderProviderSucceeded', value: providerValue };
      },
      async remove() {
        throw new Error('This test does not delete orders.');
      },
    };
    const handlers = createOrderByIdHandlers({
      resolveScope,
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
    const respostaOrgB = await handlers.GET(new Request(
      `https://orbita.test/api/bling/pedidos/${TENANT_B_ORDER_ID}`,
      { headers: { Authorization: 'Bearer owner-b-token' } },
    ), routeContext);

    expect(updateResponse.status).toBe(404);
    expect(await updateResponse.json()).toEqual({
      success: false,
      error: 'Pedido não encontrado',
    });
    expect(await respostaOrgB.json()).toEqual({
      success: true,
      data: { id: TENANT_B_ORDER_ID, numero: 'B-001' },
    });
  });

  it('denies order mutations without the organization management capability', async () => {
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
      resolveScope,
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

  it('allows an owner to update and delete an order inside the authorized organization', async () => {
    const ownedOrderId = 'owned-order';
    const records = new Map<string, OrderRecord>([[
      ownedOrderId,
      { externalId: ownedOrderId, localValue: { numero: 'A-001' } },
    ]]);
    let providerValue: unknown = { id: ownedOrderId, numero: 'A-001' };
    const store: OrderStore = {
      async findByExternalId(scope, externalId) {
        return scope.organizationId === ORG_A_ID ? records.get(externalId) ?? null : null;
      },
      async deleteByExternalId(_scope, externalId) {
        records.delete(externalId);
      },
    };
    const provider: OrderProvider = {
      async read() {
        return { _tag: 'OrderProviderSucceeded', value: providerValue };
      },
      async update(_scope, _externalId, changes) {
        providerValue = { id: ownedOrderId, ...changes };
        return { _tag: 'OrderProviderSucceeded', value: providerValue };
      },
      async remove() {
        return { _tag: 'OrderProviderSucceeded', value: undefined };
      },
    };
    const handlers = createOrderByIdHandlers({
      resolveScope,
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
