import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ensureStripeCustomerForOrganization, stableCustomerIdempotencyKey } from './stripeCustomerService';
import type { StripeBillingPort, StripeBillingResult } from './stripeBillingPort';

const ORG_ID = 'org-abc';

function fakePort(overrides?: Partial<StripeBillingPort>): StripeBillingPort {
  return {
    createCustomer: async () => ({ _tag: 'StripeBillingSuccess', data: { customerId: 'cus_should_not_be_called' } }),
    createCheckoutSession: async () => {
      throw new Error('not used in this test');
    },
    createPortalSession: async () => {
      throw new Error('not used in this test');
    },
    constructWebhookEvent: () => {
      throw new Error('not used in this test');
    },
    ...overrides,
  };
}

/** Fake Supabase client backed by an in-memory row, mirroring only the query shape this service uses. */
function fakeSupabase(initialCustomerId: string | null) {
  let row = { stripe_customer_id: initialCustomerId };
  const calls: string[] = [];

  const client = {
    from(table: string) {
      if (table !== 'assinaturas_organizacao') throw new Error(`unexpected table ${table}`);
      return {
        select() {
          calls.push('select');
          return {
            eq: () => ({
              maybeSingle: async () => ({ data: { ...row }, error: null }),
            }),
          };
        },
        update(patch: { stripe_customer_id: string }) {
          calls.push('update');
          return {
            eq: () => ({
              is: (_col: string, value: null) => ({
                select: () => ({
                  maybeSingle: async () => {
                    if (row.stripe_customer_id === null && value === null) {
                      row = { stripe_customer_id: patch.stripe_customer_id };
                      return { data: { ...row }, error: null };
                    }
                    // CAS lost: another writer already set it.
                    return { data: null, error: null };
                  },
                }),
              }),
            }),
          };
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, calls, getRow: () => row };
}

describe('ensureStripeCustomerForOrganization', () => {
  it('returns the persisted customer id without calling the Stripe port when one already exists', async () => {
    const { client } = fakeSupabase('cus_existing_123');
    let createCalled = false;
    const port = fakePort({
      createCustomer: async () => {
        createCalled = true;
        return { _tag: 'StripeBillingSuccess', data: { customerId: 'cus_should_not_happen' } };
      },
    });

    const result = await ensureStripeCustomerForOrganization({ supabase: client, billingPort: port }, ORG_ID);

    expect(result).toEqual({ _tag: 'StripeBillingSuccess', data: { customerId: 'cus_existing_123' } });
    expect(createCalled).toBe(false);
  });

  it('creates a Stripe customer with a stable per-organization idempotency key when none is persisted', async () => {
    const { client, getRow } = fakeSupabase(null);
    let receivedIdempotencyKey: string | undefined;
    const port = fakePort({
      createCustomer: async (input) => {
        receivedIdempotencyKey = input.idempotencyKey;
        return { _tag: 'StripeBillingSuccess', data: { customerId: 'cus_new_1' } };
      },
    });

    const result = await ensureStripeCustomerForOrganization({ supabase: client, billingPort: port }, ORG_ID);

    expect(result).toEqual({ _tag: 'StripeBillingSuccess', data: { customerId: 'cus_new_1' } });
    expect(receivedIdempotencyKey).toBe(stableCustomerIdempotencyKey(ORG_ID));
    expect(getRow().stripe_customer_id).toBe('cus_new_1');
  });

  it('propagates a Stripe billing port failure without persisting anything', async () => {
    const { client, getRow } = fakeSupabase(null);
    const port = fakePort({
      createCustomer: async (): Promise<StripeBillingResult<{ customerId: string }>> => ({
        _tag: 'StripeBillingFailed',
        reason: 'network',
        message: 'boom',
        retryable: true,
      }),
    });

    const result = await ensureStripeCustomerForOrganization({ supabase: client, billingPort: port }, ORG_ID);

    expect(result).toEqual({ _tag: 'StripeBillingFailed', reason: 'network', message: 'boom', retryable: true });
    expect(getRow().stripe_customer_id).toBeNull();
  });
});
