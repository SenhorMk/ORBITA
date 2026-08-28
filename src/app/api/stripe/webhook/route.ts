/**
 * POST /api/stripe/webhook
 * Ticket 14: Recebe e valida webhooks reais da Stripe. Composition root:
 * constrói o `StripeSdkAdapter` real a partir da configuração do servidor.
 * Assinatura verificada via SDK oficial (`constructEvent`), nunca HMAC
 * caseira.
 */

import { supabaseServer } from '@/lib/supabaseServer';
import { resolveStripeRuntime } from '@/services/stripe/stripeRuntime';
import { createWebhookHandlers } from './handlers';

const { configResult, billingPort } = resolveStripeRuntime();

const handlers = createWebhookHandlers({
  supabase: supabaseServer,
  billingPort,
  configResult,
});

export const POST = handlers.POST;
