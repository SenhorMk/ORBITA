import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseStripeRuntimeConfig } from '@/services/stripe/stripeConfig';
import type { StripeBillingPort } from '@/services/stripe/stripeBillingPort';
import { createWebhookHandlers } from './handlers';

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

function fakeSupabaseNoExistingEvent() {
  const client = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle: async () => ({ data: null, error: null }) })),
      })),
      insert: vi.fn(async () => ({ error: null })),
      update: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
    })),
    rpc: vi.fn(async () => ({ data: { outcome: 'applied' }, error: null })),
  };
  return client as unknown as SupabaseClient;
}

function request(rawBody: string, signature: string | null): Request {
  const headers = new Headers();
  if (signature) headers.set('stripe-signature', signature);
  return new Request('https://orbita.test/api/stripe/webhook', { method: 'POST', headers, body: rawBody });
}

describe('POST /api/stripe/webhook handlers', () => {
  it('rejects an invalid signature (400) without touching the inbox/database', async () => {
    let touched = false;
    const port: StripeBillingPort = {
      createCustomer: async () => {
        throw new Error('unused');
      },
      createCheckoutSession: async () => {
        throw new Error('unused');
      },
      createPortalSession: async () => {
        throw new Error('unused');
      },
      constructWebhookEvent: () => ({
        _tag: 'StripeBillingFailed',
        reason: 'signature-invalid',
        message: 'Assinatura inválida (fake)',
        retryable: false,
      }),
    };
    const supabase = fakeSupabaseNoExistingEvent();
    const withTracking = new Proxy(supabase, {
      get(target, prop, receiver) {
        touched = true;
        return Reflect.get(target, prop, receiver);
      },
    });

    const handlers = createWebhookHandlers({ supabase: withTracking, billingPort: port, configResult: validConfigResult() });
    const response = await handlers.POST(request('{"id":"evt_1"}', 't=1,v1=tampered'));

    expect(response.status).toBe(400);
    expect(touched).toBe(false);
  });

  it('rejects a missing signature header (400) without touching the database', async () => {
    const port: StripeBillingPort = {
      createCustomer: async () => {
        throw new Error('unused');
      },
      createCheckoutSession: async () => {
        throw new Error('unused');
      },
      createPortalSession: async () => {
        throw new Error('unused');
      },
      constructWebhookEvent: (rawBody, signatureHeader) => {
        expect(signatureHeader).toBeNull();
        return { _tag: 'StripeBillingFailed', reason: 'signature-invalid', message: 'ausente', retryable: false };
      },
    };

    const handlers = createWebhookHandlers({
      supabase: fakeSupabaseNoExistingEvent(),
      billingPort: port,
      configResult: validConfigResult(),
    });
    const response = await handlers.POST(request('{"id":"evt_1"}', null));
    expect(response.status).toBe(400);
  });

  it('processes a verified event through the idempotent inbox and echoes its outcome', async () => {
    const verifiedEvent = {
      id: 'evt_verified_1',
      type: 'checkout.session.completed',
      created: 1_700_000_100,
      data: {
        object: {
          client_reference_id: '97700000-0000-4000-8000-000000000001',
          customer: 'cus_test_1',
          subscription: 'sub_test_1',
          metadata: { plano_slug: 'pro' },
        },
      },
    };
    const port: StripeBillingPort = {
      createCustomer: async () => {
        throw new Error('unused');
      },
      createCheckoutSession: async () => {
        throw new Error('unused');
      },
      createPortalSession: async () => {
        throw new Error('unused');
      },
      constructWebhookEvent: () => ({ _tag: 'StripeBillingSuccess', data: verifiedEvent }),
    };

    const handlers = createWebhookHandlers({
      supabase: fakeSupabaseNoExistingEvent(),
      billingPort: port,
      configResult: validConfigResult(),
    });
    const response = await handlers.POST(request(JSON.stringify(verifiedEvent), 't=1,v1=real'));

    expect(response.status).toBe(200);
    const json = (await response.json()) as { received: boolean; eventId: string; status: string };
    expect(json).toEqual({ received: true, eventId: 'evt_verified_1', status: 'processed' });
  });

  it('returns 500 without processing when the server configuration is invalid', async () => {
    let called = false;
    const port: StripeBillingPort = {
      createCustomer: async () => {
        throw new Error('unused');
      },
      createCheckoutSession: async () => {
        throw new Error('unused');
      },
      createPortalSession: async () => {
        throw new Error('unused');
      },
      constructWebhookEvent: () => {
        called = true;
        throw new Error('should not be called');
      },
    };

    const handlers = createWebhookHandlers({
      supabase: fakeSupabaseNoExistingEvent(),
      billingPort: port,
      configResult: { _tag: 'StripeConfigInvalid', issues: ['STRIPE_WEBHOOK_SECRET é obrigatório'] },
    });
    const response = await handlers.POST(request('{"id":"evt_1"}', 't=1,v1=x'));

    expect(response.status).toBe(500);
    expect(called).toBe(false);
  });
});
