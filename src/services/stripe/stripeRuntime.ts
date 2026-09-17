/**
 * stripeRuntime.ts
 * Composition root compartilhado pelas rotas `checkout`, `portal`
 * e `webhook`. Resolve a config do servidor uma única vez e constrói o
 * `StripeSdkAdapter` real (ou um port "não configurado" seguro quando a
 * config é inválida/ausente — nunca constrói o cliente SDK com segredo
 * placeholder/ausente).
 */

import { parseStripeRuntimeConfig, type StripeConfigEnv, type StripeConfigResult } from './stripeConfig';
import { StripeSdkAdapter } from './stripeSdkAdapter';
import type { StripeBillingPort, StripeBillingResult } from './stripeBillingPort';

function unconfiguredFailure<T>(): StripeBillingResult<T> {
  return {
    _tag: 'StripeBillingFailed',
    reason: 'unconfigured',
    message: 'Faturamento Stripe não configurado neste ambiente',
    retryable: false,
  };
}

/** Port seguro para ambientes sem config válida: nunca chama o SDK, sempre falha tipado. */
function unconfiguredBillingPort(): StripeBillingPort {
  return {
    createCustomer: async () => unconfiguredFailure(),
    createCheckoutSession: async () => unconfiguredFailure(),
    createPortalSession: async () => unconfiguredFailure(),
    constructWebhookEvent: () => unconfiguredFailure(),
  };
}

export interface StripeRuntime {
  readonly configResult: StripeConfigResult;
  readonly billingPort: StripeBillingPort;
}

/** Resolve a config do ambiente e o adapter Stripe correspondente para uso pelas rotas. */
export function resolveStripeRuntime(env: StripeConfigEnv = process.env): StripeRuntime {
  const configResult = parseStripeRuntimeConfig(env);
  const billingPort =
    configResult._tag === 'StripeConfigValid'
      ? StripeSdkAdapter.create(configResult.config.secretKey, configResult.config.webhookSecret)
      : unconfiguredBillingPort();
  return { configResult, billingPort };
}
