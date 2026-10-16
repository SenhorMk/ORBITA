import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import { registrarFalhaInterna } from '../lib/observability/falhaInterna';

/** Tenant-owned category represented independently from provider and database field names. */
export interface CategoryRecord {
  readonly id?: string;
  readonly blingId: string;
  readonly description: string;
  readonly parentBlingId: string | null;
}

/** Provider port used to fetch organization categories one page at a time. */
export interface CategorySource {
  readonly fetchPage: (
    scope: VerifiedOrganizationScope,
    page: number,
    pageSize: number,
  ) => Promise<readonly CategoryRecord[]>;
}

/** Persistence port that always requires a verified organization. */
export interface CategoryStore {
  readonly list: (scope: VerifiedOrganizationScope) => Promise<readonly CategoryRecord[]>;
  readonly upsertAll: (
    scope: VerifiedOrganizationScope,
    categories: readonly CategoryRecord[],
  ) => Promise<void>;
}

/** Result returned when listing organization categories. */
export type CategoryListResult =
  | { readonly _tag: 'CategoryListSucceeded'; readonly categories: readonly CategoryRecord[] }
  | { readonly _tag: 'CategoryCatalogUnavailable' };

/**
 * Result returned after synchronizing organization categories.
 *
 * A gravação é por página: uma falha no meio deixa as páginas anteriores
 * gravadas, e `written` diz quantas — falha parcial, não "nada mudou".
 */
export type CategorySyncResult =
  | { readonly _tag: 'CategorySyncSucceeded'; readonly count: number }
  | { readonly _tag: 'CategoryCatalogUnavailable'; readonly written: number };

/**
 * Coordinate organization-scoped category reads and provider synchronization.
 *
 * The verified organization scope is passed to both provider and persistence adapters so
 * neither boundary can silently fall back to a global operation.
 */
export class CategoryCatalog {
  constructor(
    private readonly source: CategorySource,
    private readonly store: CategoryStore,
  ) {}

  /** List categories visible to one verified organization. */
  async list(scope: VerifiedOrganizationScope): Promise<CategoryListResult> {
    try {
      return {
        _tag: 'CategoryListSucceeded',
        categories: await this.store.list(scope),
      };
    } catch (erro: unknown) {
      registrarFalhaInterna('categorias.listar', erro, {
        organizacaoId: scope.organizationId,
        atorId: scope.actorId,
      });
      return { _tag: 'CategoryCatalogUnavailable' };
    }
  }

  /**
   * Fetch every provider page and persist each category inside one organization.
   *
   * A falha é **registrada**, e não engolida. Antes o `catch {}` não tomava nem
   * parâmetro: a importação falhava e nem servidor nem tela sabiam por quê.
   * Medido no staging, era isso que deixava o seletor de categoria do produto
   * permanentemente vazio sem explicação em lugar nenhum — o `23502` de
   * `categorias.user_id` ficou visível na primeira execução depois deste
   * registro. O log é o sanitizado do projeto: classe do erro, SQLSTATE,
   * organização e ator, sem `message` nem `details`.
   */
  async sync(scope: VerifiedOrganizationScope): Promise<CategorySyncResult> {
    const pageSize = 100;
    let page = 1;
    let count = 0;

    try {
      while (true) {
        const categories = await this.source.fetchPage(scope, page, pageSize);
        if (categories.length === 0) break;

        await this.store.upsertAll(scope, categories);
        count += categories.length;

        if (categories.length < pageSize) break;
        page += 1;
      }

      return { _tag: 'CategorySyncSucceeded', count };
    } catch (erro: unknown) {
      registrarFalhaInterna('categorias.sincronizar', erro, {
        organizacaoId: scope.organizationId,
        atorId: scope.actorId,
      });
      return { _tag: 'CategoryCatalogUnavailable', written: count };
    }
  }
}
