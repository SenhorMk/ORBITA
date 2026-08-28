/**
 * checkoutService.ts
 * Ticket 14: resolve o preço (allowlist server-side) e a organização (contexto
 * já verificado) e cria uma Checkout Session real. O cliente nunca envia
 * `priceId`, `customerId`, `organizationId` ou URLs completas.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { buildAllowlistedReturnUrl, resolvePriceId, type Intervalo, type PlanoSlugPago, type StripeRuntimeConfig } from './stripeConfig';
import { ensureStripeCustomerForOrganization } from './stripeCustomerService';
import type { StripeBillingPort, StripeBillingResult } from './stripeBillingPort';

export interface CreateOrganizationCheckoutInput {
  readonly organizationId: string;
  readonly planoSlug: PlanoSlugPago;
  readonly intervalo: Intervalo;
  /** Path relativo opcional dentro da origem allowlisted (`STRIPE_APP_BASE_URL`). Nunca uma URL absoluta. */
  readonly returnPath?: string;
}

export type CreateOrganizationCheckoutResult = StripeBillingResult<{ url: string; sessionId: string }>;

const DEFAULT_SUCCESS_PATH = '/faturamento?checkout=success';
const DEFAULT_CANCEL_PATH = '/faturamento?checkout=cancel';

export async function createOrganizationCheckoutSession(
  deps: { supabase: SupabaseClient; billingPort: StripeBillingPort; config: StripeRuntimeConfig },
  input: CreateOrganizationCheckoutInput,
): Promise<CreateOrganizationCheckoutResult> {
  const { supabase, billingPort, config } = deps;

  if (!config.checkoutEnabled) {
    return {
      _tag: 'StripeBillingFailed',
      reason: 'unconfigured',
      message: 'Checkout Stripe desabilitado neste ambiente (STRIPE_CHECKOUT_ENABLED)',
      retryable: false,
    };
  }

  const priceId = resolvePriceId(config, input.planoSlug, input.intervalo);

  const customerResult = await ensureStripeCustomerForOrganization({ supabase, billingPort }, input.organizationId);
  if (customerResult._tag === 'StripeBillingFailed') {
    return customerResult;
  }

  const basePath =
    input.returnPath && input.returnPath.startsWith('/') ? input.returnPath.replace(/[?#].*$/, '') : '/faturamento';
  const separator = basePath.includes('?') ? '&' : '?';

  let successUrl: string;
  let cancelUrl: string;
  try {
    successUrl = buildAllowlistedReturnUrl(
      config,
      input.returnPath ? `${basePath}${separator}checkout=success` : DEFAULT_SUCCESS_PATH,
    );
    cancelUrl = buildAllowlistedReturnUrl(
      config,
      input.returnPath ? `${basePath}${separator}checkout=cancel` : DEFAULT_CANCEL_PATH,
    );
  } catch (err) {
    return {
      _tag: 'StripeBillingFailed',
      reason: 'invalid-response',
      message: err instanceof Error ? err.message : 'Path de retorno inválido',
      retryable: false,
    };
  }

  return billingPort.createCheckoutSession({
    customerId: customerResult.data.customerId,
    priceId,
    organizationId: input.organizationId,
    successUrl,
    cancelUrl,
    idempotencyKey: randomUUID(),
  });
}
