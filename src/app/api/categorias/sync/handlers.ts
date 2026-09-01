import type { RequestOrganizationScopeResult } from '../../../../lib/requestOrganizationContext';
import { escopoTemCapacidade, type VerifiedOrganizationScope } from '../../../../lib/verifiedOrganizationScope';
import type {
  CategoryListResult,
  CategorySyncResult,
} from '../../../../services/categoryCatalog';

/**
 * Category operations required by the HTTP adapter.
 *
 * Ticket 22 — o port recebia `VerifiedTenant`, o tenant do modelo por usuário,
 * resolvido de `app_metadata`. Passou a receber a organização verificada, que é
 * a mesma autoridade que o resto do aplicativo usa.
 */
export interface CategoryCatalogPort {
  /** List categories visible to one verified organization. */
  readonly list: (scope: VerifiedOrganizationScope) => Promise<CategoryListResult>;
  /** Synchronize categories for one verified organization. */
  readonly sync: (scope: VerifiedOrganizationScope) => Promise<CategorySyncResult>;
}

/** Server-side organization resolver required by protected category handlers. */
export type CategoryScopeResolver = (request: Request) => Promise<RequestOrganizationScopeResult>;

/** Dependencies accepted by the category HTTP adapter. */
export interface CategoryHandlerDependencies {
  readonly resolveScope: CategoryScopeResolver;
  readonly catalog: CategoryCatalogPort;
}

/** Create protected category HTTP handlers over an injected catalog module. */
export function createCategoryHandlers(dependencies: CategoryHandlerDependencies) {
  return {
    async GET(request: Request): Promise<Response> {
      // Ler o catálogo é leitura: basta pertencer à organização.
      const scopeResult = await dependencies.resolveScope(request);
      if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;

      const result = await dependencies.catalog.list(scopeResult.scope);
      if (result._tag === 'CategoryCatalogUnavailable') {
        return Response.json(
          { success: false, error: 'Falha ao carregar categorias' },
          { status: 500 },
        );
      }

      return Response.json({
        success: true,
        data: result.categories.map((category) => ({
          id: category.id,
          bling_id: category.blingId,
          descricao: category.description,
          categoria_pai_id: category.parentBlingId,
        })),
      });
    },

    async POST(request: Request): Promise<Response> {
      const scopeResult = await dependencies.resolveScope(request);
      if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;

      // Sincronizar escreve o catálogo inteiro: é gestão. A capacidade
      // substitui o antigo `tenant:manage`, que vinha de `app_metadata`.
      if (!escopoTemCapacidade(scopeResult.scope, 'organization:manage')) {
        return Response.json({ success: false, error: 'Acesso negado' }, { status: 403 });
      }

      const result = await dependencies.catalog.sync(scopeResult.scope);
      if (result._tag === 'CategoryCatalogUnavailable') {
        return Response.json(
          { success: false, error: 'Falha ao sincronizar categorias' },
          { status: 500 },
        );
      }

      return Response.json({
        success: true,
        count: result.count,
        message: result.count === 0
          ? 'Nenhuma categoria encontrada no Bling.'
          : 'Categorias sincronizadas com sucesso',
      });
    },
  };
}
