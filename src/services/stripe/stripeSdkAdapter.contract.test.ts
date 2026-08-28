import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Stripe from 'stripe';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { StripeSdkAdapter } from './stripeSdkAdapter';

/**
 * Contract tests against the REAL `stripe` SDK, transport-redirected to a
 * controlled fake HTTP server (`node:http`) via the SDK's own documented
 * `host`/`port`/`protocol` config options (see `node_modules/stripe/cjs/lib.d.ts`).
 * No `vi.mock` of the `stripe` module anywhere in this file: every request
 * really goes through `Stripe`'s HTTP client and lands on `server`, and every
 * response is really parsed by the SDK before this adapter sees it. See
 * `.agents/skills/orbita-integrations` and `docs/integrations/stripe-contract.md`.
 */
describe('StripeSdkAdapter contract (fake Stripe HTTP server, real SDK)', () => {
  let server: http.Server;
  let host: string;
  let port: number;
  let lastRequest: { method: string; path: string; headers: http.IncomingHttpHeaders; body: string } | null = null;
  let nextResponse: { status: number; body: unknown } | null = null;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        lastRequest = {
          method: req.method || '',
          path: req.url || '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        const planned = nextResponse;
        if (!planned) {
          res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'no planned response' } }));
          return;
        }
        res.writeHead(planned.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(planned.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    host = '127.0.0.1';
    port = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  afterEach(() => {
    lastRequest = null;
    nextResponse = null;
  });

  function adapter(webhookSecret = 'whsec_contract_test_secret') {
    return StripeSdkAdapter.forTesting('sk_test_contract_fake_key_1234567890', webhookSecret, {
      host,
      port,
      protocol: 'http',
    });
  }

  describe('createCustomer', () => {
    it('calls POST /v1/customers with the idempotency key header and organization metadata', async () => {
      nextResponse = { status: 200, body: { id: 'cus_contract_test_1', object: 'customer' } };
      const result = await adapter().createCustomer({
        organizationId: 'org-123',
        idempotencyKey: 'orbita-stripe-customer-org-123',
      });

      expect(result).toEqual({ _tag: 'StripeBillingSuccess', data: { customerId: 'cus_contract_test_1' } });
      expect(lastRequest?.method).toBe('POST');
      expect(lastRequest?.path).toBe('/v1/customers');
      expect(lastRequest?.headers['idempotency-key']).toBe('orbita-stripe-customer-org-123');
      expect(lastRequest?.body).toContain('metadata[organizacao_id]=org-123');
    });

    it('never fabricates a customer id locally: the returned id is exactly the fake server response id', async () => {
      nextResponse = { status: 200, body: { id: 'cus_whatever_the_server_says', object: 'customer' } };
      const result = await adapter().createCustomer({ organizationId: 'org-x', idempotencyKey: 'key-x' });
      expect(result._tag).toBe('StripeBillingSuccess');
      if (result._tag === 'StripeBillingSuccess') {
        expect(result.data.customerId).toBe('cus_whatever_the_server_says');
      }
    });

    it('maps a 401 authentication error to a permanent, non-retryable failure', async () => {
      nextResponse = {
        status: 401,
        body: { error: { type: 'authentication_error', message: 'Invalid API Key provided' } },
      };
      const result = await adapter().createCustomer({ organizationId: 'org-1', idempotencyKey: 'k1' });
      expect(result).toMatchObject({ _tag: 'StripeBillingFailed', reason: 'http', status: 401, retryable: false });
    });

    it('maps a 429 rate limit error to a retryable failure', async () => {
      nextResponse = { status: 429, body: { error: { type: 'rate_limit_error', message: 'Too many requests' } } };
      const result = await adapter().createCustomer({ organizationId: 'org-1', idempotencyKey: 'k1' });
      expect(result).toMatchObject({ _tag: 'StripeBillingFailed', reason: 'http', status: 429, retryable: true });
    });

    it('maps a 500 API error to a retryable failure', async () => {
      nextResponse = { status: 500, body: { error: { type: 'api_error', message: 'Internal error' } } };
      const result = await adapter().createCustomer({ organizationId: 'org-1', idempotencyKey: 'k1' });
      expect(result).toMatchObject({ _tag: 'StripeBillingFailed', reason: 'http', status: 500, retryable: true });
    });
  });

  describe('createCheckoutSession', () => {
    it('calls POST /v1/checkout/sessions with subscription mode, price, customer and idempotency key', async () => {
      nextResponse = {
        status: 200,
        body: { id: 'cs_contract_test_1', object: 'checkout.session', url: 'https://checkout.stripe.com/c/cs_contract_test_1' },
      };
      const result = await adapter().createCheckoutSession({
        customerId: 'cus_1',
        priceId: 'price_pro_monthly_1',
        organizationId: 'org-123',
        successUrl: 'https://app.example.com/faturamento?checkout=success',
        cancelUrl: 'https://app.example.com/faturamento?checkout=cancel',
        idempotencyKey: 'checkout-key-1',
      });

      expect(result).toEqual({
        _tag: 'StripeBillingSuccess',
        data: { url: 'https://checkout.stripe.com/c/cs_contract_test_1', sessionId: 'cs_contract_test_1' },
      });
      expect(lastRequest?.path).toBe('/v1/checkout/sessions');
      expect(lastRequest?.headers['idempotency-key']).toBe('checkout-key-1');
      expect(lastRequest?.body).toContain('mode=subscription');
      expect(lastRequest?.body).toContain('customer=cus_1');
      expect(lastRequest?.body).toContain(encodeURIComponent('price_pro_monthly_1'));
      expect(lastRequest?.body).toContain('client_reference_id=org-123');
    });

    it('never returns a locally-fabricated checkout URL: the URL is exactly what the fake server issued', async () => {
      nextResponse = {
        status: 200,
        body: { id: 'cs_2', object: 'checkout.session', url: 'https://checkout.stripe.com/c/cs_2_unique_marker' },
      };
      const result = await adapter().createCheckoutSession({
        customerId: 'cus_1',
        priceId: 'price_1',
        organizationId: 'org-1',
        successUrl: 'https://app.example.com/ok',
        cancelUrl: 'https://app.example.com/cancel',
        idempotencyKey: 'k',
      });
      expect(result._tag).toBe('StripeBillingSuccess');
      if (result._tag === 'StripeBillingSuccess') {
        expect(result.data.url).toBe('https://checkout.stripe.com/c/cs_2_unique_marker');
      }
    });

    it('treats a session with no url as invalid-response, not as a fabricated URL', async () => {
      nextResponse = { status: 200, body: { id: 'cs_no_url', object: 'checkout.session', url: null } };
      const result = await adapter().createCheckoutSession({
        customerId: 'cus_1',
        priceId: 'price_1',
        organizationId: 'org-1',
        successUrl: 'https://app.example.com/ok',
        cancelUrl: 'https://app.example.com/cancel',
        idempotencyKey: 'k',
      });
      expect(result).toMatchObject({ _tag: 'StripeBillingFailed', reason: 'invalid-response', retryable: false });
    });

    it('maps a 402 card error to a permanent, non-retryable failure', async () => {
      nextResponse = {
        status: 402,
        body: { error: { type: 'card_error', message: 'Your card was declined.', decline_code: 'generic_decline' } },
      };
      const result = await adapter().createCheckoutSession({
        customerId: 'cus_1',
        priceId: 'price_1',
        organizationId: 'org-1',
        successUrl: 'https://app.example.com/ok',
        cancelUrl: 'https://app.example.com/cancel',
        idempotencyKey: 'k',
      });
      expect(result).toMatchObject({ _tag: 'StripeBillingFailed', reason: 'http', status: 402, retryable: false });
    });
  });

  describe('createPortalSession', () => {
    it('calls POST /v1/billing_portal/sessions with customer and return_url', async () => {
      nextResponse = {
        status: 200,
        body: { id: 'bps_1', object: 'billing_portal.session', url: 'https://billing.stripe.com/p/session/bps_1' },
      };
      const result = await adapter().createPortalSession({
        customerId: 'cus_1',
        returnUrl: 'https://app.example.com/faturamento',
      });

      expect(result).toEqual({ _tag: 'StripeBillingSuccess', data: { url: 'https://billing.stripe.com/p/session/bps_1' } });
      expect(lastRequest?.path).toBe('/v1/billing_portal/sessions');
      expect(lastRequest?.body).toContain('customer=cus_1');
      expect(lastRequest?.body).toContain(encodeURIComponent('https://app.example.com/faturamento'));
    });
  });

  describe('constructWebhookEvent', () => {
    it('accepts an event signed with the official SDK test-header helper', () => {
      const secret = 'whsec_contract_signature_secret';
      const payload = JSON.stringify({
        id: 'evt_contract_1',
        type: 'checkout.session.completed',
        created: 1_700_000_000,
        data: { object: { id: 'cs_1' } },
      });
      const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });

      const result = adapter(secret).constructWebhookEvent(payload, header);

      expect(result._tag).toBe('StripeBillingSuccess');
      if (result._tag === 'StripeBillingSuccess') {
        expect(result.data.id).toBe('evt_contract_1');
        expect(result.data.type).toBe('checkout.session.completed');
      }
    });

    it('rejects a tampered payload as signature-invalid, never producing a synthetic event', () => {
      const secret = 'whsec_contract_signature_secret';
      const originalPayload = JSON.stringify({
        id: 'evt_1',
        type: 'checkout.session.completed',
        created: 1_700_000_000,
        data: { object: {} },
      });
      const header = Stripe.webhooks.generateTestHeaderString({ payload: originalPayload, secret });
      const tamperedPayload = JSON.stringify({
        id: 'evt_1_tampered',
        type: 'checkout.session.completed',
        created: 1_700_000_000,
        data: { object: {} },
      });

      const result = adapter(secret).constructWebhookEvent(tamperedPayload, header);
      expect(result).toMatchObject({ _tag: 'StripeBillingFailed', reason: 'signature-invalid', retryable: false });
    });

    it('rejects a missing signature header without attempting verification', () => {
      const result = adapter().constructWebhookEvent('{"id":"evt_1"}', null);
      expect(result).toMatchObject({ _tag: 'StripeBillingFailed', reason: 'signature-invalid', retryable: false });
    });

    it('rejects a valid signature over an event that fails the boundary schema', () => {
      const secret = 'whsec_contract_signature_secret';
      // valid JSON, correctly signed, but missing the required `created` field.
      const payload = JSON.stringify({ id: 'evt_bad_shape', type: 'checkout.session.completed', data: { object: {} } });
      const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });

      const result = adapter(secret).constructWebhookEvent(payload, header);
      expect(result).toMatchObject({ _tag: 'StripeBillingFailed', reason: 'invalid-response', retryable: false });
    });
  });
});
