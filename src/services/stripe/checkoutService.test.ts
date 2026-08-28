import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createOrganizationCheckoutSession } from './checkoutService';
import { parseStripeRuntimeConfig } from './stripeConfig';
import type { StripeBillingPort } from './stripeBillingPort';

const ORG_ID = 'org-checkout-1';

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

function fakeSupabaseWithCustomer(customerId: string) {
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { stripe_customer_id: customerId }, error: null }) }),
      }),
    }),
  };
  return client as unknown as SupabaseClient;
}

describe('createOrganizationCheckoutSession', () => {
  it('resolves the allowlisted price id from plan+interval and forwards it to the billing port', async () => {
    let receivedPriceId: string | undefined;
    let receivedCustomerId: string | undefined;
    const port: StripeBillingPort = {
      createCustomer: async () => ({ _tag: 'StripeBillingSuccess', data: { customerId: 'unused' } }),
      createCheckoutSession: async (input) => {
        receivedPriceId = input.priceId;
        receivedCustomerId = input.customerId;
        return { _tag: 'StripeBillingSuccess', data: { url: 'https://checkout.stripe.com/c/cs_1', sessionId: 'cs_1' } };
      },
      createPortalSession: async () => {
        throw new Error('unused');
      },
      constructWebhookEvent: () => {
        throw new Error('unused');
      },
    };

    const result = await createOrganizationCheckoutSession(
      { supabase: fakeSupabaseWithCustomer('cus_existing'), billingPort: port, config: loadedConfig() },
      { organizationId: ORG_ID, planoSlug: 'pro', intervalo: 'yearly' },
    );

    expect(result).toEqual({
      _tag: 'StripeBillingSuccess',
      data: { url: 'https://checkout.stripe.com/c/cs_1', sessionId: 'cs_1' },
    });
    expect(receivedPriceId).toBe('price_pro_yearly_123');
    expect(receivedCustomerId).toBe('cus_existing');
  });

  it('never forwards an arbitrary client-supplied return path outside the allowlisted origin', async () => {
    let receivedSuccessUrl: string | undefined;
    const port: StripeBillingPort = {
      createCustomer: async () => ({ _tag: 'StripeBillingSuccess', data: { customerId: 'unused' } }),
      createCheckoutSession: async (input) => {
        receivedSuccessUrl = input.successUrl;
        return { _tag: 'StripeBillingSuccess', data: { url: 'https://checkout.stripe.com/c/cs_1', sessionId: 'cs_1' } };
      },
      createPortalSession: async () => {
        throw new Error('unused');
      },
      constructWebhookEvent: () => {
        throw new Error('unused');
      },
    };

    const result = await createOrganizationCheckoutSession(
      { supabase: fakeSupabaseWithCustomer('cus_1'), billingPort: port, config: loadedConfig() },
      { organizationId: ORG_ID, planoSlug: 'pro', intervalo: 'monthly', returnPath: '//evil.example.com/x' },
    );

    // A protocol-relative path resolves to a different origin: rejected as
    // invalid-response, never silently forwarded as the success/cancel URL.
    expect(result).toMatchObject({ _tag: 'StripeBillingFailed', reason: 'invalid-response' });
    expect(receivedSuccessUrl).toBeUndefined();
  });

  it('returns unconfigured without calling the billing port when checkout is disabled', async () => {
    let called = false;
    const port: StripeBillingPort = {
      createCustomer: async () => {
        called = true;
        return { _tag: 'StripeBillingSuccess', data: { customerId: 'unused' } };
      },
      createCheckoutSession: async () => {
        called = true;
        throw new Error('should not be called');
      },
      createPortalSession: async () => {
        throw new Error('unused');
      },
      constructWebhookEvent: () => {
        throw new Error('unused');
      },
    };
    const disabledConfig = { ...loadedConfig(), checkoutEnabled: false };

    const result = await createOrganizationCheckoutSession(
      { supabase: fakeSupabaseWithCustomer('cus_1'), billingPort: port, config: disabledConfig },
      { organizationId: ORG_ID, planoSlug: 'pro', intervalo: 'monthly' },
    );

    expect(result).toMatchObject({ _tag: 'StripeBillingFailed', reason: 'unconfigured' });
    expect(called).toBe(false);
  });
});
