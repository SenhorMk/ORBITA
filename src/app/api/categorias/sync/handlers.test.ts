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

import { createCategoryHandlers, type EventoDeCategorias } from './handlers';

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

/** Trilha de auditoria em memória; `falhar` simula a RPC indisponível. */
function trilha(options: { falhar?: boolean } = {}) {
  const eventos: Array<{ organizationId: string; actorId: string; evento: EventoDeCategorias }> = [];
  return {
    eventos,
    deps: {
      async auditar(scope: VerifiedOrganizationScope, evento: EventoDeCategorias) {
        if (options.falhar) throw new Error('registrar_evento_auditoria indisponível');
        eventos.push({ organizationId: scope.organizationId, actorId: scope.actorId, evento });
      },
      correlationId: () => 'corr_categorias',
    },
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
      ...trilha().deps,
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
      ...trilha().deps,
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
      ...trilha().deps,
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
      ...trilha().deps,
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

describe('auditoria da sincronização de categorias (PRE-006B)', () => {
  const owner = { 'owner-token': escopo(ORG_A_ID, 'owner'), 'membro-token': escopo(ORG_A_ID, 'member') };
  const post = (token: string) => new Request('https://orbita.test/api/categorias/sync', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });

  /** Duas páginas cheias e a terceira falhando: as duas primeiras ficam gravadas. */
  function catalogo(options: { falharNaPagina?: number } = {}) {
    const gravadas: CategoryRecord[] = [];
    const source: CategorySource = {
      async fetchPage(_scope, page, pageSize) {
        if (page === options.falharNaPagina) throw new Error('Bling indisponível');
        if (page > 2) return [];
        return Array.from({ length: pageSize }, (_, i) => ({ blingId: `${page}-${i}`, description: `C${i}`, parentBlingId: null }));
      },
    };
    const store: CategoryStore = {
      async list() { return gravadas; },
      async upsertAll(_scope, categories) { gravadas.push(...categories); },
    };
    return { gravadas, catalog: new CategoryCatalog(source, store) };
  }

  it('concluída: contagem, ator e organização verificados, sem descrição de categoria', async () => {
    const auditoria = trilha();
    const { catalog } = catalogo();
    const handlers = createCategoryHandlers({ ...auditoria.deps, resolveScope: resolvedorPorToken(owner), catalog });

    const resposta = await handlers.POST(post('owner-token'));

    expect(resposta.status).toBe(200);
    expect(auditoria.eventos).toEqual([{
      organizationId: ORG_A_ID,
      actorId: ATOR_ID,
      evento: { acao: 'catalog.categories_synced', correlationId: 'corr_categorias', metadata: { categorias: 200 } },
    }]);
  });

  it('falha no meio é parcial, não "nada mudou": o evento diz quantas ficaram gravadas', async () => {
    const auditoria = trilha();
    const { catalog, gravadas } = catalogo({ falharNaPagina: 2 });
    const handlers = createCategoryHandlers({ ...auditoria.deps, resolveScope: resolvedorPorToken(owner), catalog });

    const resposta = await handlers.POST(post('owner-token'));

    expect(resposta.status).toBe(500);
    expect(gravadas).toHaveLength(100);
    expect(auditoria.eventos.map((e) => e.evento)).toEqual([
      { acao: 'catalog.categories_sync_failed', correlationId: 'corr_categorias', metadata: { categorias_gravadas: 100 } },
    ]);
  });

  it('membro sem capacidade é recusado antes de ler o Bling ou gravar, e não há evento de efeito', async () => {
    const auditoria = trilha();
    const handlers = createCategoryHandlers({ ...auditoria.deps, resolveScope: resolvedorPorToken(owner), catalog: catalogoQueNuncaRoda });

    const resposta = await handlers.POST(post('membro-token'));

    expect(resposta.status).toBe(403);
    expect(auditoria.eventos).toEqual([]);
  });

  it('auditoria indisponível não muda o resultado já gravado', async () => {
    const { catalog, gravadas } = catalogo();
    const handlers = createCategoryHandlers({ ...trilha({ falhar: true }).deps, resolveScope: resolvedorPorToken(owner), catalog });

    const resposta = await handlers.POST(post('owner-token'));

    expect(resposta.status).toBe(200);
    expect(gravadas).toHaveLength(200);
  });
});
