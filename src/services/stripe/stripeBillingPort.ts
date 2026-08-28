/**
 * stripeBillingPort.ts
 * Ticket 14: porta application-owned para o provider Stripe. Nenhuma outra
 * camada da aplicação importa o SDK `stripe` diretamente — apenas o adapter
 * server-only (`stripeSdkAdapter.ts`) implementa esta interface.
 */

import { z } from 'zod';

/** Resultado tipado e exaustivo de toda chamada ao provider Stripe. */
export type StripeBillingResult<T> =
  | { readonly _tag: 'StripeBillingSuccess'; readonly data: T }
  | {
      readonly _tag: 'StripeBillingFailed';
      readonly reason: 'http' | 'invalid-response' | 'network' | 'timeout' | 'unconfigured' | 'signature-invalid';
      readonly status?: number;
      readonly message?: string;
      /** Falhas 4xx (exceto 429) e assinatura inválida são permanentes; rede/timeout/5xx/429 são retryable. */
      readonly retryable: boolean;
    };

export interface CreateCustomerInput {
  readonly organizationId: string;
  readonly idempotencyKey: string;
}
export interface CreateCustomerOutput {
  readonly customerId: string;
}

export interface CreateCheckoutSessionInput {
  readonly customerId: string;
  readonly priceId: string;
  readonly organizationId: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly idempotencyKey: string;
}
export interface CreateCheckoutSessionOutput {
  readonly url: string;
  readonly sessionId: string;
}

export interface CreatePortalSessionInput {
  readonly customerId: string;
  readonly returnUrl: string;
}
export interface CreatePortalSessionOutput {
  readonly url: string;
}

/** Envelope de evento de webhook já verificado pela assinatura oficial. */
export const stripeVerifiedEventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  created: z.number().int().positive(),
  data: z.object({
    object: z.record(z.string(), z.unknown()),
  }),
});
export type StripeVerifiedEvent = z.infer<typeof stripeVerifiedEventSchema>;

export interface StripeBillingPort {
  /** Cria um Customer real na Stripe. Idempotency key é obrigatória e estável por organização. */
  createCustomer(input: CreateCustomerInput): Promise<StripeBillingResult<CreateCustomerOutput>>;
  /** Cria uma Checkout Session real na Stripe. Retorna apenas a URL emitida pela Stripe. */
  createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<StripeBillingResult<CreateCheckoutSessionOutput>>;
  /** Cria uma Billing Portal Session real na Stripe para um Customer já vinculado. */
  createPortalSession(input: CreatePortalSessionInput): Promise<StripeBillingResult<CreatePortalSessionOutput>>;
  /**
   * Verifica a assinatura oficial de um webhook sobre o raw body e devolve o
   * evento decodificado. Nunca aceita um evento sem assinatura válida.
   */
  constructWebhookEvent(rawBody: string, signatureHeader: string | null): StripeBillingResult<StripeVerifiedEvent>;
}
