import type { RequestOrganizationScopeResult } from '../../../../lib/requestOrganizationContext';
import { registrarFalhaInterna } from '../../../../lib/observability/falhaInterna';
import { escopoTemCapacidade, type VerifiedOrganizationScope } from '../../../../lib/verifiedOrganizationScope';
import type {
  CategoryListResult,
  CategorySyncResult,
} from '../../../../services/categoryCatalog';

/**
 * Category operations required by the HTTP adapter.
 *
 * O port recebe a organização verificada, a mesma autoridade que o resto do
 * aplicativo usa.
 */
export interface CategoryCatalogPort {
  /** List categories visible to one verified organization. */
  readonly list: (scope: VerifiedOrganizationScope) => Promise<CategoryListResult>;
  /** Synchronize categories for one verified organization. */
  readonly sync: (scope: VerifiedOrganizationScope) => Promise<CategorySyncResult>;
}

/** Server-side organization resolver required by protected category handlers. */
export type CategoryScopeResolver = (request: Request) => Promise<RequestOrganizationScopeResult>;

/**
 * Evento de auditoria da sincronização. Metadata só com contagens: nenhuma
 * descrição de categoria nem corpo do Bling.
 */
export type EventoDeCategorias =
  | {
      readonly acao: 'catalog.categories_synced';
      readonly correlationId: string;
      readonly metadata: { readonly categorias: number };
    }
  | {
      readonly acao: 'catalog.categories_sync_failed';
      readonly correlationId: string;
      readonly metadata: { readonly categorias_gravadas: number };
    };

/** Dependencies accepted by the category HTTP adapter. */
export interface CategoryHandlerDependencies {
  readonly resolveScope: CategoryScopeResolver;
  readonly catalog: CategoryCatalogPort;
  /** Trilha persistente (`recordAuditEvent`). Falhar aqui nunca muda a resposta. */
  readonly auditar: (scope: VerifiedOrganizationScope, evento: EventoDeCategorias) => Promise<void>;
  readonly correlationId: (request: Request) => string;
}

/** Auditoria sem mudar a resposta: a gravação já aconteceu (ou falhou) antes. */
async function auditarSemInterromper(
  dependencies: CategoryHandlerDependencies,
  scope: VerifiedOrganizationScope,
  evento: EventoDeCategorias,
): Promise<void> {
  try {
    await dependencies.auditar(scope, evento);
  } catch (erro: unknown) {
    registrarFalhaInterna(`categorias.auditoria.${evento.acao}`, erro, { organizacaoId: scope.organizationId, atorId: scope.actorId });
  }
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

      const correlationId = dependencies.correlationId(request);
      const result = await dependencies.catalog.sync(scopeResult.scope);
      if (result._tag === 'CategoryCatalogUnavailable') {
        await auditarSemInterromper(dependencies, scopeResult.scope, {
          acao: 'catalog.categories_sync_failed',
          correlationId,
          metadata: { categorias_gravadas: result.written },
        });
        return Response.json(
          { success: false, error: 'Falha ao sincronizar categorias' },
          { status: 500 },
        );
      }

      await auditarSemInterromper(dependencies, scopeResult.scope, {
        acao: 'catalog.categories_synced',
        correlationId,
        metadata: { categorias: result.count },
      });
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
