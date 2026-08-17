import { describe, expect, it } from 'vitest';

import { resolveActorContext, type AuthUserLookup } from '../../../../lib/auth';
import {
  CategoryCatalog,
  type CategoryRecord,
  type CategorySource,
  type CategoryStore,
} from '../../../../services/categoryCatalog';

import { createCategoryHandlers } from './handlers';

const COLLABORATOR_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const unusedAuthLookup: AuthUserLookup = {
  async getUser() {
    throw new Error('Anonymous requests must not consult the identity provider.');
  },
};

const collaboratorLookup: AuthUserLookup = {
  async getUser() {
    return {
      data: {
        user: {
          id: COLLABORATOR_ID,
          app_metadata: { role: 'colaborador', tenant_id: TENANT_ID },
        },
      },
      error: null,
    };
  },
};

const ownerLookup: AuthUserLookup = {
  async getUser(token) {
    const id = token === 'owner-a-token' ? OWNER_A_ID : OWNER_B_ID;
    return {
      data: { user: { id, app_metadata: { role: 'dono' } } },
      error: null,
    };
  },
};

describe('category HTTP handlers', () => {
  it('denies anonymous category reads at the HTTP seam', async () => {
    const handlers = createCategoryHandlers({
      resolveActor(request, capability) {
        return resolveActorContext(request, capability, unusedAuthLookup);
      },
      catalog: {
        async list() {
          throw new Error('Denied requests must not read categories.');
        },
        async sync() {
          throw new Error('Denied requests must not sync categories.');
        },
      },
    });

    const response = await handlers.GET(
      new Request('https://orbita.test/api/categorias/sync'),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Não autorizado',
    });
  });

  it('denies category synchronization without the tenant management capability', async () => {
    const handlers = createCategoryHandlers({
      resolveActor(request, capability) {
        return resolveActorContext(request, capability, collaboratorLookup);
      },
      catalog: {
        async list() {
          throw new Error('This test does not list categories.');
        },
        async sync() {
          throw new Error('Denied requests must not sync categories.');
        },
      },
    });
    const request = new Request('https://orbita.test/api/categorias/sync', {
      method: 'POST',
      headers: { Authorization: 'Bearer collaborator-token' },
    });

    const response = await handlers.POST(request);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Acesso negado',
    });
  });

  it('synchronizes and lists categories only inside the authorized tenant', async () => {
    const categoriesByTenant = new Map<string, CategoryRecord[]>();
    const source: CategorySource = {
      async fetchPage(tenant, page) {
        if (tenant.id !== OWNER_A_ID || page > 1) return [];
        return [{
          blingId: 'category-1',
          description: 'Categoria privada A',
          parentBlingId: null,
        }];
      },
    };
    const store: CategoryStore = {
      async list(tenant) {
        return categoriesByTenant.get(tenant.id) ?? [];
      },
      async upsertAll(tenant, categories) {
        categoriesByTenant.set(tenant.id, [...categories]);
      },
    };
    const handlers = createCategoryHandlers({
      resolveActor(request, capability) {
        return resolveActorContext(request, capability, ownerLookup);
      },
      catalog: new CategoryCatalog(source, store),
    });

    const syncResponse = await handlers.POST(new Request(
      'https://orbita.test/api/categorias/sync',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer owner-a-token' },
      },
    ));
    const tenantAResponse = await handlers.GET(new Request(
      'https://orbita.test/api/categorias/sync',
      { headers: { Authorization: 'Bearer owner-a-token' } },
    ));
    const tenantBResponse = await handlers.GET(new Request(
      'https://orbita.test/api/categorias/sync',
      { headers: { Authorization: 'Bearer owner-b-token' } },
    ));

    expect(syncResponse.status).toBe(200);
    expect(await syncResponse.json()).toMatchObject({ success: true, count: 1 });
    expect(await tenantAResponse.json()).toEqual({
      success: true,
      data: [{
        bling_id: 'category-1',
        descricao: 'Categoria privada A',
        categoria_pai_id: null,
      }],
    });
    expect(await tenantBResponse.json()).toEqual({ success: true, data: [] });
  });
});
