/**
 * handlers.ts
 * Ticket 14: HTTP adapter para POST /api/stripe/webhook, com dependências
 * injetáveis (mesmo padrão de `src/app/api/bling/pedidos/[id]/handlers.ts`).
 * A assinatura é verificada sobre o raw body pelo `StripeBillingPort`
 * (`constructWebhookEvent`, SDK oficial via `StripeSdkAdapter`) antes de
 * qualquer efeito. O evento verificado é processado pela máquina de estados
 * idempotente do ticket 13 (`processStripeWebhookEvent`), sem alterações.
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { processStripeWebhookEvent } from '@/lib/stripe/stripeWebhookHandler';
import type { StripeBillingPort } from '@/services/stripe/stripeBillingPort';
import type { StripeConfigResult } from '@/services/stripe/stripeConfig';

export interface WebhookHandlerDependencies {
  readonly supabase: SupabaseClient;
  readonly billingPort: StripeBillingPort;
  readonly configResult: StripeConfigResult;
}

/** Cria os handlers HTTP do webhook Stripe sobre dependências injetadas. */
export function createWebhookHandlers(dependencies: WebhookHandlerDependencies) {
  return {
    async POST(req: Request): Promise<Response> {
      if (dependencies.configResult._tag !== 'StripeConfigValid') {
        console.error('❌ Webhook Stripe: configuração do servidor inválida/ausente');
        return NextResponse.json({ error: 'Webhook Stripe não configurado no servidor' }, { status: 500 });
      }

      const signature = req.headers.get('stripe-signature');
      const rawBody = await req.text();

      // 1. Verificação oficial da assinatura sobre o raw body (SDK real, nunca HMAC caseira).
      const verified = dependencies.billingPort.constructWebhookEvent(rawBody, signature);
      if (verified._tag !== 'StripeBillingSuccess') {
        console.warn(`⚠️ Webhook Stripe: ${verified.reason} — ${verified.message ?? 'sem detalhes'}`);
        return NextResponse.json({ error: 'Assinatura inválida' }, { status: 400 });
      }

      const event = verified.data;

      // 2. Processamento idempotente via inbox (máquina de estados do ticket 13, sem alterações).
      const result = await processStripeWebhookEvent(dependencies.supabase, event);

      if (result.status === 'failed') {
        return NextResponse.json({ error: 'Falha ao processar evento', details: result.error }, { status: 500 });
      }

      return NextResponse.json({ received: true, eventId: event.id, status: result.status });
    },
  };
}
