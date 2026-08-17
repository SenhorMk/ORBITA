import type { VerifiedTenant } from '../lib/auth';

/** Local order identity and value used to prove tenant ownership before provider access. */
export interface OrderRecord {
  readonly externalId: string;
  readonly localValue: unknown;
}

/** Tenant-scoped persistence operations required by order access. */
export interface OrderStore {
  readonly findByExternalId: (
    tenant: VerifiedTenant,
    externalId: string,
  ) => Promise<OrderRecord | null>;
  readonly deleteByExternalId: (
    tenant: VerifiedTenant,
    externalId: string,
  ) => Promise<void>;
}

/** Safe outcome returned by the Bling order adapter. */
export type OrderProviderResult<T> =
  | { readonly _tag: 'OrderProviderSucceeded'; readonly value: T }
  | { readonly _tag: 'OrderProviderNotFound' }
  | { readonly _tag: 'OrderProviderUnavailable' };

/** External order operations required after local tenant ownership is proven. */
export interface OrderProvider {
  readonly read: (
    tenant: VerifiedTenant,
    externalId: string,
  ) => Promise<OrderProviderResult<unknown>>;
  readonly update: (
    tenant: VerifiedTenant,
    externalId: string,
    changes: Readonly<Record<string, unknown>>,
  ) => Promise<OrderProviderResult<unknown>>;
  readonly remove: (
    tenant: VerifiedTenant,
    externalId: string,
  ) => Promise<OrderProviderResult<void>>;
}

/** Outcome of an authorized order operation. */
export type OrderAccessResult<T> =
  | { readonly _tag: 'OrderAccessSucceeded'; readonly value: T }
  | { readonly _tag: 'OrderNotFound' }
  | { readonly _tag: 'OrderAccessUnavailable' };

/**
 * Prove local tenant ownership before reading or mutating an external order.
 *
 * Provider identifiers are never authority by themselves. Every operation
 * begins with the tenant-scoped store lookup and fails with the same not-found
 * outcome for absent and cross-tenant records.
 */
export class OrderAccess {
  constructor(
    private readonly store: OrderStore,
    private readonly provider: OrderProvider,
  ) {}

  /** Read an order after proving it belongs to the verified tenant. */
  async read(tenant: VerifiedTenant, externalId: string): Promise<OrderAccessResult<unknown>> {
    const recordResult = await this.findRecord(tenant, externalId);
    if (recordResult._tag !== 'OrderAccessSucceeded') return recordResult;

    if (externalId.startsWith('#MANUAL-')) {
      return { _tag: 'OrderAccessSucceeded', value: recordResult.value.localValue };
    }

    return this.fromProvider(await this.provider.read(tenant, externalId));
  }

  /** Update an order after proving it belongs to the verified tenant. */
  async update(
    tenant: VerifiedTenant,
    externalId: string,
    changes: Readonly<Record<string, unknown>>,
  ): Promise<OrderAccessResult<unknown>> {
    const recordResult = await this.findRecord(tenant, externalId);
    if (recordResult._tag !== 'OrderAccessSucceeded') return recordResult;

    if (externalId.startsWith('#MANUAL-')) {
      return { _tag: 'OrderAccessSucceeded', value: null };
    }

    return this.fromProvider(await this.provider.update(tenant, externalId, changes));
  }

  /** Remove an order locally and externally after proving tenant ownership. */
  async remove(tenant: VerifiedTenant, externalId: string): Promise<OrderAccessResult<void>> {
    const recordResult = await this.findRecord(tenant, externalId);
    if (recordResult._tag !== 'OrderAccessSucceeded') return recordResult;

    if (!externalId.startsWith('#MANUAL-')) {
      const providerResult = await this.provider.remove(tenant, externalId);
      if (providerResult._tag === 'OrderProviderUnavailable') {
        return { _tag: 'OrderAccessUnavailable' };
      }
    }

    try {
      await this.store.deleteByExternalId(tenant, externalId);
      return { _tag: 'OrderAccessSucceeded', value: undefined };
    } catch {
      return { _tag: 'OrderAccessUnavailable' };
    }
  }

  private async findRecord(
    tenant: VerifiedTenant,
    externalId: string,
  ): Promise<OrderAccessResult<OrderRecord>> {
    try {
      const record = await this.store.findByExternalId(tenant, externalId);
      return record
        ? { _tag: 'OrderAccessSucceeded', value: record }
        : { _tag: 'OrderNotFound' };
    } catch {
      return { _tag: 'OrderAccessUnavailable' };
    }
  }

  private fromProvider<T>(result: OrderProviderResult<T>): OrderAccessResult<T> {
    if (result._tag === 'OrderProviderSucceeded') {
      return { _tag: 'OrderAccessSucceeded', value: result.value };
    }
    return result._tag === 'OrderProviderNotFound'
      ? { _tag: 'OrderNotFound' }
      : { _tag: 'OrderAccessUnavailable' };
  }
}
