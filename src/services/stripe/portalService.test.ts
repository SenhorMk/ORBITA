import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createOrganizationPortalSession } from './portalService';
import { parseStripeRuntimeConfig } from './stripeConfig';
import type { StripeBillingPort } from './stripeBillingPort';

const ORG_ID = 'org-portal-1';

const ENV = {
  STRIPE_SECRET_KEY: 'ci-test-secret-key-1234567890abcdefghij',
  STRIPE_WEBHOOK_SECRET: 'ci-test-webhook-secret-1234567890abcdefghij',
  STRIPE_APP_BASE_URL: 'https://app.example.com',
  STRIPE_PRICE_PRO_MONTHLY: 'price_pro_monthly_123',
  STRIPE_PRICE_PRO_YEARLY: 'price_pro_yearly_123',
  STRIPE_PRICE_ENTERPRISE_MONTHLY: 'price_enterprise_monthly_123',
  STRIPE_PRICE_ENTERPRISE_YEARLY: 'price_enterprise_yearly_123',
  STRIPE_CHECKOUT_ENABLED: 'true',
};

function loadedConfig() {
  const parsed = parseStripeRuntimeConfig(ENV);
  if (parsed._tag !== 'StripeConfigValid') throw new Error('unexpected invalid config');
  return parsed.config;
}

function fakeSupabase(customerId: string | null) {
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { stripe_customer_id: customerId }, error: null }) }),
      }),
    }),
  };
  return client as unknown as SupabaseClient;
}

describe('createOrganizationPortalSession', () => {
  it('creates a portal session for the persisted customer id, never a client-supplied one', async () => {
    let receivedCustomerId: string | undefined;
    const port: StripeBillingPort = {
      createCustomer: async () => {
        throw new Error('unused');
      },
      createCheckoutSession: async () => {
        throw new Error('unused');
      },
      createPortalSession: async (input) => {
        receivedCustomerId = input.customerId;
        return { _tag: 'StripeBillingSuccess', data: { url: 'https://billing.stripe.com/p/session/bps_1' } };
      },
      constructWebhookEvent: () => {
        throw new Error('unused');
      },
    };

    const result = await createOrganizationPortalSession(
      { supabase: fakeSupabase('cus_persisted_1'), billingPort: port, config: loadedConfig() },
      { organizationId: ORG_ID },
    );

    expect(result).toEqual({ _tag: 'StripeBillingSuccess', data: { url: 'https://billing.stripe.com/p/session/bps_1' } });
    expect(receivedCustomerId).toBe('cus_persisted_1');
  });

  it('fails as unconfigured when the organization has no Stripe customer yet, without calling the port', async () => {
    let called = false;
    const port: StripeBillingPort = {
      createCustomer: async () => {
        throw new Error('unused');
      },
      createCheckoutSession: async () => {
        throw new Error('unused');
      },
      createPortalSession: async () => {
        called = true;
        throw new Error('should not be called');
      },
      constructWebhookEvent: () => {
        throw new Error('unused');
      },
    };

    const result = await createOrganizationPortalSession(
      { supabase: fakeSupabase(null), billingPort: port, config: loadedConfig() },
      { organizationId: ORG_ID },
    );

    expect(result).toMatchObject({ _tag: 'StripeBillingFailed', reason: 'unconfigured' });
    expect(called).toBe(false);
  });
});
