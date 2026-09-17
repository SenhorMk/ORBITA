/**
 * POST /api/stripe/checkout
 * Inicia uma Checkout Session real da Stripe para a organização
 * ativa. Composition root: constrói o `StripeSdkAdapter` real a partir da
 * configuração do servidor e delega ao `checkoutService`. Nenhuma geração
 * local de URL/session ID.
 */

import { resolveActiveRequestOrganizationContext } from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import { resolveStripeRuntime } from '@/services/stripe/stripeRuntime';
import { createCheckoutHandlers } from './handlers';

export const dynamic = 'force-dynamic';

const { configResult, billingPort } = resolveStripeRuntime();

const handlers = createCheckoutHandlers({
  resolveContext: resolveActiveRequestOrganizationContext,
  supabase: supabaseServer,
  billingPort,
  configResult,
});

export const POST = handlers.POST;
