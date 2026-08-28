/**
 * portalService.ts
 * Ticket 14: cria uma Billing Portal Session real para o Customer já
 * vinculado à organização. Nunca aceita `customerId` do cliente.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { buildAllowlistedReturnUrl, type StripeRuntimeConfig } from './stripeConfig';
import type { StripeBillingPort, StripeBillingResult } from './stripeBillingPort';

export interface CreateOrganizationPortalInput {
  readonly organizationId: string;
  readonly returnPath?: string;
}

export type CreateOrganizationPortalResult = StripeBillingResult<{ url: string }>;

const DEFAULT_RETURN_PATH = '/faturamento';

export async function createOrganizationPortalSession(
  deps: { supabase: SupabaseClient; billingPort: StripeBillingPort; config: StripeRuntimeConfig },
  input: CreateOrganizationPortalInput,
): Promise<CreateOrganizationPortalResult> {
  const { supabase, billingPort, config } = deps;

  const { data: sub, error } = await supabase
    .from('assinaturas_organizacao')
    .select('stripe_customer_id')
    .eq('organizacao_id', input.organizationId)
    .maybeSingle();

  if (error) {
    return { _tag: 'StripeBillingFailed', reason: 'http', message: error.message, retryable: true };
  }
  if (!sub?.stripe_customer_id) {
    return {
      _tag: 'StripeBillingFailed',
      reason: 'unconfigured',
      message: 'Organização ainda não possui faturamento configurado no Stripe',
      retryable: false,
    };
  }

  let returnUrl: string;
  try {
    returnUrl = buildAllowlistedReturnUrl(
      config,
      input.returnPath && input.returnPath.startsWith('/') ? input.returnPath : DEFAULT_RETURN_PATH,
    );
  } catch (err) {
    return {
      _tag: 'StripeBillingFailed',
      reason: 'invalid-response',
      message: err instanceof Error ? err.message : 'Path de retorno inválido',
      retryable: false,
    };
  }

  return billingPort.createPortalSession({ customerId: sub.stripe_customer_id, returnUrl });
}
