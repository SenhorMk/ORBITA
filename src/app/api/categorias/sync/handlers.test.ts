import { describe, expect, it } from 'vitest';

import { NextResponse } from 'next/server';

import type { RequestOrganizationScopeResult } from '../../../../lib/requestOrganizationContext';
import type { VerifiedOrganizationScope } from '../../../../lib/verifiedOrganizationScope';
import {
  CategoryCatalog,
  type CategoryRecord,
  type CategorySource,
  type CategoryStore,
} from '../../../../services/categoryCatalog';

import { createCategoryHandlers } from './handlers';

/**
 * Ticket 22 — este teste era escrito contra o modelo de tenancy por usuário:
 * as personas eram `app_metadata: { role: 'dono' }` e o isolamento provado era
 * entre *tenants pessoais*. Agora a autoridade é a organização verificada, que
 * é a mesma do resto do aplicativo.
 *
 * A fiação real da rota (identidade + `membros_organizacao`) é coberta em
 * `src/app/api/ticket-22-fronteira-das-rotas-migradas.test.ts`; aqui o escopo
 * é injetado de propósito, porque o que se testa é a decisão do handler.
 */

const ORG_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ATOR_ID = '22222222-2222-4222-8222-222222222222';

/** Constrói um escopo já verificado, como a fronteira HTTP entregaria. */
function escopo(organizationId: string, role: 'owner' | 'admin' | 'member'): VerifiedOrganizationScope {
  return { organizationId, actorId: ATOR_ID, role } as VerifiedOrganizationScope;
}

/** Resolvedor que lê o bearer só para escolher qual escopo devolver. */
function resolvedorPorToken(
  porToken: Readonly<Record<string, VerifiedOrganizationScope>>,
): (request: Request) => Promise<RequestOrganizationScopeResult> {
  return async (request: Request) => {
    const token = /^Bearer\s+(.+)$/iu.exec(request.headers.get('Authorization') ?? '')?.[1];
    const encontrado = token ? porToken[token] : undefined;
    if (!encontrado) {
      return {
        _tag: 'RequestScopeDenied',
        response: NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 }),
      };
    }
    return { _tag: 'RequestScopeResolved', scope: encontrado };
  };
}

const catalogoQueNuncaRoda = {
  async list(): Promise<never> {
    throw new Error('Requisição negada não deve listar categorias.');
  },
  async sync(): Promise<never> {
    throw new Error('Requisição negada não deve sincronizar categorias.');
  },
};

describe('category HTTP handlers', () => {
  it('nega leitura anônima na fronteira HTTP', async () => {
    const handlers = createCategoryHandlers({
      resolveScope: resolvedorPorToken({}),
      catalog: catalogoQueNuncaRoda,
    });

    const response = await handlers.GET(new Request('https://orbita.test/api/categorias/sync'));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ success: false, error: 'Não autorizado' });
  });

  // Antes a exigência era a capacidade `tenant:manage`, derivada de
  // `app_metadata`. Agora vem do papel na organização — e o membro é
  // reconhecido, e negado, em vez de tratado como desconhecido.
  it('nega a sincronização a quem não administra a organização', async () => {
    const handlers = createCategoryHandlers({
      resolveScope: resolvedorPorToken({ 'membro-token': escopo(ORG_A_ID, 'member') }),
      catalog: catalogoQueNuncaRoda,
    });

    const response = await handlers.POST(new Request('https://orbita.test/api/categorias/sync', {
      method: 'POST',
      headers: { Authorization: 'Bearer membro-token' },
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, error: 'Acesso negado' });
  });

  it('deixa o membro ler o catálogo, que é leitura', async () => {
    const porOrganizacao = new Map<string, CategoryRecord[]>([
      [ORG_A_ID, [{ id: '11111111-1111-4111-8111-111111111111', blingId: 'category-1', description: 'Categoria A', parentBlingId: null }]],
    ]);
    const store: CategoryStore = {
      async list(scope) {
        return porOrganizacao.get(scope.organizationId) ?? [];
      },
      async upsertAll() {
        throw new Error('A leitura não grava.');
      },
    };
    const handlers = createCategoryHandlers({
      resolveScope: resolvedorPorToken({ 'membro-token': escopo(ORG_A_ID, 'member') }),
      catalog: new CategoryCatalog({ async fetchPage() { return []; } }, store),
    });

    const response = await handlers.GET(new Request('https://orbita.test/api/categorias/sync', {
      headers: { Authorization: 'Bearer membro-token' },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: [{ bling_id: 'category-1' }] });
  });

  it('sincroniza e lista apenas dentro da organização autorizada', async () => {
    const porOrganizacao = new Map<string, CategoryRecord[]>();
    const source: CategorySource = {
      async fetchPage(scope, page) {
        if (scope.organizationId !== ORG_A_ID || page > 1) return [];
        return [{ blingId: 'category-1', description: 'Categoria privada A', parentBlingId: null }];
      },
    };
    const store: CategoryStore = {
      async list(scope) {
        return porOrganizacao.get(scope.organizationId) ?? [];
      },
      async upsertAll(scope, categories) {
        porOrganizacao.set(scope.organizationId, [...categories]);
      },
    };
    const handlers = createCategoryHandlers({
      resolveScope: resolvedorPorToken({
        'owner-a-token': escopo(ORG_A_ID, 'owner'),
        'owner-b-token': escopo(ORG_B_ID, 'owner'),
      }),
      catalog: new CategoryCatalog(source, store),
    });

    const syncResponse = await handlers.POST(new Request('https://orbita.test/api/categorias/sync', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-a-token' },
    }));
    const respostaOrgA = await handlers.GET(new Request('https://orbita.test/api/categorias/sync', {
      headers: { Authorization: 'Bearer owner-a-token' },
    }));
    const respostaOrgB = await handlers.GET(new Request('https://orbita.test/api/categorias/sync', {
      headers: { Authorization: 'Bearer owner-b-token' },
    }));

    expect(syncResponse.status).toBe(200);
    expect(await syncResponse.json()).toMatchObject({ success: true, count: 1 });
    expect(await respostaOrgA.json()).toEqual({
      success: true,
      data: [{
        bling_id: 'category-1',
        descricao: 'Categoria privada A',
        categoria_pai_id: null,
      }],
    });
    // A organização B não enxerga nada da A — o isolamento é pela organização,
    // não mais pelo tenant pessoal.
    expect(await respostaOrgB.json()).toEqual({ success: true, data: [] });
  });
});
