/**
 * stripeCustomerService.ts
 * Garante um Stripe Customer real vinculado a uma organização.
 * Nunca aceita `customerId` do cliente; o vínculo é sempre lido/gravado em
 * `assinaturas_organizacao` por `organizacao_id` verificado.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { StripeBillingPort, StripeBillingResult } from './stripeBillingPort';

export type EnsureCustomerResult = StripeBillingResult<{ customerId: string }>;

/** Idempotency key estável por organização: chamadas concorrentes convergem para o mesmo Customer Stripe. */
export function stableCustomerIdempotencyKey(organizationId: string): string {
  return `orbita-stripe-customer-${organizationId}`;
}

/**
 * Busca o `stripe_customer_id` persistido para a organização; se ausente,
 * cria um Customer real na Stripe com idempotency key estável e persiste via
 * UPDATE guardado (`stripe_customer_id IS NULL`), protegido pelo índice único
 * parcial existente em `assinaturas_organizacao.stripe_customer_id`
 * (`database/34_integrar_stripe_assinaturas.sql`).
 */
export async function ensureStripeCustomerForOrganization(
  deps: { supabase: SupabaseClient; billingPort: StripeBillingPort },
  organizationId: string,
): Promise<EnsureCustomerResult> {
  const { supabase, billingPort } = deps;

  const { data: existing, error: selectError } = await supabase
    .from('assinaturas_organizacao')
    .select('stripe_customer_id')
    .eq('organizacao_id', organizationId)
    .maybeSingle();

  if (selectError) {
    return { _tag: 'StripeBillingFailed', reason: 'http', message: selectError.message, retryable: true };
  }
  if (existing?.stripe_customer_id) {
    return { _tag: 'StripeBillingSuccess', data: { customerId: existing.stripe_customer_id } };
  }

  const created = await billingPort.createCustomer({
    organizationId,
    idempotencyKey: stableCustomerIdempotencyKey(organizationId),
  });
  if (created._tag === 'StripeBillingFailed') {
    return created;
  }

  const { data: updated, error: updateError } = await supabase
    .from('assinaturas_organizacao')
    .update({ stripe_customer_id: created.data.customerId })
    .eq('organizacao_id', organizationId)
    .is('stripe_customer_id', null)
    .select('stripe_customer_id')
    .maybeSingle();

  if (updateError) {
    return { _tag: 'StripeBillingFailed', reason: 'http', message: updateError.message, retryable: true };
  }

  if (updated?.stripe_customer_id) {
    return { _tag: 'StripeBillingSuccess', data: { customerId: updated.stripe_customer_id } };
  }

  // Perdeu a corrida (outro request concorrente já persistiu um customer_id
  // primeiro). Lê o valor definitivo em vez de assumir o que este processo criou.
  const { data: settled, error: settledError } = await supabase
    .from('assinaturas_organizacao')
    .select('stripe_customer_id')
    .eq('organizacao_id', organizationId)
    .maybeSingle();

  if (settledError || !settled?.stripe_customer_id) {
    return {
      _tag: 'StripeBillingFailed',
      reason: 'http',
      message: settledError?.message ?? 'Falha ao resolver stripe_customer_id após corrida concorrente',
      retryable: true,
    };
  }

  return { _tag: 'StripeBillingSuccess', data: { customerId: settled.stripe_customer_id } };
}
