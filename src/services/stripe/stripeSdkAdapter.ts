/**
 * stripeSdkAdapter.ts
 * Ticket 14: adapter server-only que implementa `StripeBillingPort` usando o
 * SDK oficial `stripe` (versão fixada em package.json). Nenhuma outra camada
 * do runtime de produção gera IDs/URLs Stripe — apenas este arquivo importa
 * o SDK e chama `customers`, `checkout.sessions`, `billingPortal.sessions` e
 * `webhooks.constructEvent`.
 *
 * `forTesting` aponta o mesmo cliente SDK real para um host/porta arbitrários
 * (opções documentadas `host`/`port`/`protocol` do construtor `Stripe`), para
 * que os contract tests exerçam o SDK de verdade contra um fake HTTP server
 * local — nunca `vi.mock` do módulo `stripe`.
 */

import Stripe from 'stripe';
import {
  stripeVerifiedEventSchema,
  type CreateCheckoutSessionInput,
  type CreateCheckoutSessionOutput,
  type CreateCustomerInput,
  type CreateCustomerOutput,
  type CreatePortalSessionInput,
  type CreatePortalSessionOutput,
  type StripeBillingPort,
  type StripeBillingResult,
  type StripeVerifiedEvent,
} from './stripeBillingPort';

/** Versão de API fixada explicitamente (nunca a versão padrão da conta). */
const PINNED_API_VERSION = '2026-08-26.dahlia' as const;

export interface StripeSdkAdapterTransportOverrides {
  readonly host: string;
  readonly port: number;
  readonly protocol: 'http' | 'https';
}

function mapThrown<T>(err: unknown): StripeBillingResult<T> {
  if (err instanceof Stripe.errors.StripeSignatureVerificationError) {
    return { _tag: 'StripeBillingFailed', reason: 'signature-invalid', message: err.message, retryable: false };
  }
  if (err instanceof Stripe.errors.StripeConnectionError) {
    return { _tag: 'StripeBillingFailed', reason: 'network', message: err.message, retryable: true };
  }
  if (err instanceof Stripe.errors.StripeRateLimitError) {
    return {
      _tag: 'StripeBillingFailed',
      reason: 'http',
      status: err.statusCode ?? 429,
      message: err.message,
      retryable: true,
    };
  }
  if (err instanceof Stripe.errors.StripeError) {
    const status = err.statusCode ?? 0;
    const retryable = status >= 500;
    return { _tag: 'StripeBillingFailed', reason: 'http', status, message: err.message, retryable };
  }
  if (err instanceof Error && /timeout/i.test(err.message)) {
    return { _tag: 'StripeBillingFailed', reason: 'timeout', message: err.message, retryable: true };
  }
  return {
    _tag: 'StripeBillingFailed',
    reason: 'network',
    message: err instanceof Error ? err.message : String(err),
    retryable: true,
  };
}

/** Adapter server-only. Não construir fora de contexto de servidor (rota API / service). */
export class StripeSdkAdapter implements StripeBillingPort {
  private readonly client: Stripe;
  private readonly webhookSecret: string;

  private constructor(client: Stripe, webhookSecret: string) {
    this.client = client;
    this.webhookSecret = webhookSecret;
  }

  /** Constrói o adapter de produção com o SDK real apontado para a API oficial da Stripe. */
  static create(secretKey: string, webhookSecret: string): StripeSdkAdapter {
    const client = new Stripe(secretKey, {
      apiVersion: PINNED_API_VERSION,
      typescript: true,
      timeout: 20_000,
      maxNetworkRetries: 2,
    });
    return new StripeSdkAdapter(client, webhookSecret);
  }

  /** Constrói o adapter com o SDK real apontado para um fake HTTP server local (somente testes). */
  static forTesting(
    secretKey: string,
    webhookSecret: string,
    transport: StripeSdkAdapterTransportOverrides,
  ): StripeSdkAdapter {
    const client = new Stripe(secretKey, {
      apiVersion: PINNED_API_VERSION,
      typescript: true,
      timeout: 5_000,
      maxNetworkRetries: 0,
      host: transport.host,
      port: transport.port,
      protocol: transport.protocol,
    });
    return new StripeSdkAdapter(client, webhookSecret);
  }

  async createCustomer(input: CreateCustomerInput): Promise<StripeBillingResult<CreateCustomerOutput>> {
    try {
      const customer = await this.client.customers.create(
        { metadata: { organizacao_id: input.organizationId } },
        { idempotencyKey: input.idempotencyKey },
      );
      return { _tag: 'StripeBillingSuccess', data: { customerId: customer.id } };
    } catch (err) {
      return mapThrown(err);
    }
  }

  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<StripeBillingResult<CreateCheckoutSessionOutput>> {
    try {
      const session = await this.client.checkout.sessions.create(
        {
          mode: 'subscription',
          customer: input.customerId,
          client_reference_id: input.organizationId,
          line_items: [{ price: input.priceId, quantity: 1 }],
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          metadata: { organizacao_id: input.organizationId },
        },
        { idempotencyKey: input.idempotencyKey },
      );
      if (!session.url) {
        return {
          _tag: 'StripeBillingFailed',
          reason: 'invalid-response',
          message: 'Stripe checkout session criada sem URL',
          retryable: false,
        };
      }
      return { _tag: 'StripeBillingSuccess', data: { url: session.url, sessionId: session.id } };
    } catch (err) {
      return mapThrown(err);
    }
  }

  async createPortalSession(
    input: CreatePortalSessionInput,
  ): Promise<StripeBillingResult<CreatePortalSessionOutput>> {
    try {
      const session = await this.client.billingPortal.sessions.create({
        customer: input.customerId,
        return_url: input.returnUrl,
      });
      return { _tag: 'StripeBillingSuccess', data: { url: session.url } };
    } catch (err) {
      return mapThrown(err);
    }
  }

  constructWebhookEvent(rawBody: string, signatureHeader: string | null): StripeBillingResult<StripeVerifiedEvent> {
    if (!signatureHeader) {
      return {
        _tag: 'StripeBillingFailed',
        reason: 'signature-invalid',
        message: 'Cabeçalho stripe-signature ausente',
        retryable: false,
      };
    }
    try {
      const event = this.client.webhooks.constructEvent(rawBody, signatureHeader, this.webhookSecret);
      const parsed = stripeVerifiedEventSchema.safeParse(event);
      if (!parsed.success) {
        return {
          _tag: 'StripeBillingFailed',
          reason: 'invalid-response',
          message: `Evento Stripe verificado mas fora do schema esperado: ${parsed.error.message}`,
          retryable: false,
        };
      }
      return { _tag: 'StripeBillingSuccess', data: parsed.data };
    } catch (err) {
      return mapThrown(err);
    }
  }
}
