import type { VerifiedTenant } from '../lib/auth';

/** Tenant-owned category represented independently from provider and database field names. */
export interface CategoryRecord {
  readonly id?: string;
  readonly blingId: string;
  readonly description: string;
  readonly parentBlingId: string | null;
}

/** Provider port used to fetch tenant categories one page at a time. */
export interface CategorySource {
  readonly fetchPage: (
    tenant: VerifiedTenant,
    page: number,
    pageSize: number,
  ) => Promise<readonly CategoryRecord[]>;
}

/** Persistence port that always requires a verified tenant. */
export interface CategoryStore {
  readonly list: (tenant: VerifiedTenant) => Promise<readonly CategoryRecord[]>;
  readonly upsertAll: (
    tenant: VerifiedTenant,
    categories: readonly CategoryRecord[],
  ) => Promise<void>;
}

/** Result returned when listing tenant categories. */
export type CategoryListResult =
  | { readonly _tag: 'CategoryListSucceeded'; readonly categories: readonly CategoryRecord[] }
  | { readonly _tag: 'CategoryCatalogUnavailable' };

/** Result returned after synchronizing tenant categories. */
export type CategorySyncResult =
  | { readonly _tag: 'CategorySyncSucceeded'; readonly count: number }
  | { readonly _tag: 'CategoryCatalogUnavailable' };

/**
 * Coordinate tenant-scoped category reads and provider synchronization.
 *
 * The verified tenant is passed to both provider and persistence adapters so
 * neither boundary can silently fall back to a global operation.
 */
export class CategoryCatalog {
  constructor(
    private readonly source: CategorySource,
    private readonly store: CategoryStore,
  ) {}

  /** List categories visible to one verified tenant. */
  async list(tenant: VerifiedTenant): Promise<CategoryListResult> {
    try {
      return {
        _tag: 'CategoryListSucceeded',
        categories: await this.store.list(tenant),
      };
    } catch {
      return { _tag: 'CategoryCatalogUnavailable' };
    }
  }

  /** Fetch every provider page and persist each category inside one tenant. */
  async sync(tenant: VerifiedTenant): Promise<CategorySyncResult> {
    const pageSize = 100;
    let page = 1;
    let count = 0;

    try {
      while (true) {
        const categories = await this.source.fetchPage(tenant, page, pageSize);
        if (categories.length === 0) break;

        await this.store.upsertAll(tenant, categories);
        count += categories.length;

        if (categories.length < pageSize) break;
        page += 1;
      }

      return { _tag: 'CategorySyncSucceeded', count };
    } catch {
      return { _tag: 'CategoryCatalogUnavailable' };
    }
  }
}
