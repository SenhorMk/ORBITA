import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseOrganizationId, type OrganizationContextResult, type OrganizationId } from '@/lib/organizationAuthorization';
import { parseStripeRuntimeConfig } from '@/services/stripe/stripeConfig';
import type { StripeBillingPort } from '@/services/stripe/stripeBillingPort';
import { createPortalHandlers } from './handlers';

function testOrganizationId(): OrganizationId {
  const result = parseOrganizationId('20000000-0000-4000-8000-000000000001');
  if (!result) throw new Error('Test organization UUID must be valid.');
  return result;
}
const ORG_ID = testOrganizationId();

const VALID_ENV = {
  STRIPE_SECRET_KEY: 'ci-test-secret-key-1234567890abcdefghij',
  STRIPE_WEBHOOK_SECRET: 'ci-test-webhook-secret-1234567890abcdefghij',
  STRIPE_APP_BASE_URL: 'https://app.example.com',
  STRIPE_PRICE_PRO_MONTHLY: 'price_pro_monthly_123',
  STRIPE_PRICE_PRO_YEARLY: 'price_pro_yearly_123',
  STRIPE_PRICE_ENTERPRISE_MONTHLY: 'price_enterprise_monthly_123',
  STRIPE_PRICE_ENTERPRISE_YEARLY: 'price_enterprise_yearly_123',
  STRIPE_CHECKOUT_ENABLED: 'true',
};

function validConfigResult() {
  const parsed = parseStripeRuntimeConfig(VALID_ENV);
  if (parsed._tag !== 'StripeConfigValid') throw new Error('unexpected invalid config');
  return parsed;
}

function resolvedContext(capabilities: readonly string[] = ['organization:access', 'organization:manage']): OrganizationContextResult {
  return {
    _tag: 'OrganizationContextResolved',
    // SAFETY: test fixture supplies a complete context; only private construction brands are omitted.
    context: {
      actorId: '30000000-0000-4000-8000-000000000001',
      user: { id: '30000000-0000-4000-8000-000000000001', app_metadata: {} },
      organizationId: ORG_ID,
      organization: {
        id: ORG_ID,
        nome: 'Org',
        slug: 'org',
        created_at: '2026-08-24T00:00:00Z',
        updated_at: '2026-08-24T00:00:00Z',
      },
      role: 'owner',
      capabilities: new Set(capabilities),
      selectionVersion: 0,
    } as never,
  };
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

function request(body: unknown): Request {
  return new Request('https://orbita.test/api/stripe/portal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/stripe/portal handlers', () => {
  it('returns exactly the URL emitted by the billing port, never a locally-generated one', async () => {
    const port: StripeBillingPort = {
      createCustomer: async () => {
        throw new Error('unused');
      },
      createCheckoutSession: async () => {
        throw new Error('unused');
      },
      createPortalSession: async () => ({
        _tag: 'StripeBillingSuccess',
        data: { url: 'https://billing.stripe.com/p/session/bps_from_provider' },
      }),
      constructWebhookEvent: () => {
        throw new Error('unused');
      },
    };

    const handlers = createPortalHandlers({
      resolveContext: async () => resolvedContext(),
      supabase: fakeSupabase('cus_existing'),
      billingPort: port,
      configResult: validConfigResult(),
    });

    const response = await handlers.POST(request({}));
    expect(response.status).toBe(200);
    const json = (await response.json()) as { url: string };
    expect(json).toEqual({ url: 'https://billing.stripe.com/p/session/bps_from_provider' });
  });

  it('rejects an absolute return_path', async () => {
    const handlers = createPortalHandlers({
      resolveContext: async () => resolvedContext(),
      supabase: fakeSupabase('cus_existing'),
      billingPort: {
        createCustomer: async () => {
          throw new Error('unused');
        },
        createCheckoutSession: async () => {
          throw new Error('unused');
        },
        createPortalSession: async () => {
          throw new Error('should not be called');
        },
        constructWebhookEvent: () => {
          throw new Error('unused');
        },
      },
      configResult: validConfigResult(),
    });

    const response = await handlers.POST(request({ return_path: 'https://evil.example.com/steal' }));
    expect(response.status).toBe(400);
  });

  it('rejects members without organization:manage capability', async () => {
    const handlers = createPortalHandlers({
      resolveContext: async () => resolvedContext(['organization:access']),
      supabase: fakeSupabase('cus_existing'),
      billingPort: {
        createCustomer: async () => {
          throw new Error('unused');
        },
        createCheckoutSession: async () => {
          throw new Error('unused');
        },
        createPortalSession: async () => {
          throw new Error('should not be called');
        },
        constructWebhookEvent: () => {
          throw new Error('unused');
        },
      },
      configResult: validConfigResult(),
    });

    const response = await handlers.POST(request({}));
    expect(response.status).toBe(403);
  });

  it('returns 503 without calling the billing port when Stripe is not configured', async () => {
    let called = false;
    const handlers = createPortalHandlers({
      resolveContext: async () => resolvedContext(),
      supabase: fakeSupabase('cus_existing'),
      billingPort: {
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
      },
      configResult: { _tag: 'StripeConfigInvalid', issues: ['STRIPE_SECRET_KEY é obrigatório'] },
    });

    const response = await handlers.POST(request({}));
    expect(response.status).toBe(503);
    expect(called).toBe(false);
  });

  it('propagates the service unconfigured failure (no Stripe customer yet) as 400 without a synthetic url', async () => {
    const handlers = createPortalHandlers({
      resolveContext: async () => resolvedContext(),
      supabase: fakeSupabase(null),
      billingPort: {
        createCustomer: async () => {
          throw new Error('unused');
        },
        createCheckoutSession: async () => {
          throw new Error('unused');
        },
        createPortalSession: async () => {
          throw new Error('should not be called: no customer yet');
        },
        constructWebhookEvent: () => {
          throw new Error('unused');
        },
      },
      configResult: validConfigResult(),
    });

    const response = await handlers.POST(request({}));
    expect(response.status).toBe(400);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.url).toBeUndefined();
  });
});
