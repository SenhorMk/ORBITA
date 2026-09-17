/**
 * POST /api/stripe/portal
 * Inicia uma Billing Portal Session real da Stripe para a
 * organização ativa. Composition root: constrói o `StripeSdkAdapter` real a
 * partir da configuração do servidor e delega ao `portalService`. Nenhuma
 * geração local de URL.
 */

import { resolveActiveRequestOrganizationContext } from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import { resolveStripeRuntime } from '@/services/stripe/stripeRuntime';
import { createPortalHandlers } from './handlers';

export const dynamic = 'force-dynamic';

const { configResult, billingPort } = resolveStripeRuntime();

const handlers = createPortalHandlers({
  resolveContext: resolveActiveRequestOrganizationContext,
  supabase: supabaseServer,
  billingPort,
  configResult,
});

export const POST = handlers.POST;
