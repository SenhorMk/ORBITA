import {
  actorContextDenialStatus,
  type ActorCapability,
  type ActorContextResult,
  type VerifiedTenant,
} from '../../../../lib/auth';
import type {
  CategoryListResult,
  CategorySyncResult,
} from '../../../../services/categoryCatalog';

/** Category operations required by the HTTP adapter. */
export interface CategoryCatalogPort {
  /** List categories visible to one verified tenant. */
  readonly list: (tenant: VerifiedTenant) => Promise<CategoryListResult>;
  /** Synchronize categories for one verified tenant. */
  readonly sync: (tenant: VerifiedTenant) => Promise<CategorySyncResult>;
}

/** Server-side actor resolver required by protected category handlers. */
export type CategoryActorResolver = (
  request: Request,
  capability: ActorCapability,
) => Promise<ActorContextResult>;

/** Dependencies accepted by the category HTTP adapter. */
export interface CategoryHandlerDependencies {
  readonly resolveActor: CategoryActorResolver;
  readonly catalog: CategoryCatalogPort;
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

/** Create protected category HTTP handlers over an injected catalog module. */
export function createCategoryHandlers(dependencies: CategoryHandlerDependencies) {
  return {
    async GET(request: Request): Promise<Response> {
      const actorResult = await dependencies.resolveActor(request, 'app:access');
      if (actorResult._tag !== 'ActorContextResolved') {
        return authorizationDenial(actorResult);
      }

      const result = await dependencies.catalog.list(actorResult.context.tenant);
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
      const actorResult = await dependencies.resolveActor(request, 'tenant:manage');
      if (actorResult._tag !== 'ActorContextResolved') {
        return authorizationDenial(actorResult);
      }

      const result = await dependencies.catalog.sync(actorResult.context.tenant);
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
