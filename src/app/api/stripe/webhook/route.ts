/**
 * POST /api/stripe/webhook
 * Ticket 38: Endpoint de recepção e validação de webhooks Stripe.
 */

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';
import { getStripeConfig, verifyStripeWebhookSignature } from '@/lib/stripe/stripeClient';
import { processStripeWebhookEvent, type StripeEvent } from '@/lib/stripe/stripeWebhookHandler';

export async function POST(req: Request) {
  const signature = req.headers.get('stripe-signature');
  const rawBody = await req.text();

  const config = getStripeConfig();
  if (!config.isConfigured) {
    console.error('❌ Webhook Stripe: STRIPE_WEBHOOK_SECRET não configurado');
    return NextResponse.json(
      { error: 'Webhook Stripe não configurado no servidor' },
      { status: 500 },
    );
  }

  // 1. Verificação Criptográfica da Assinatura
  const verification = verifyStripeWebhookSignature(
    rawBody,
    signature,
    config.webhookSecret,
  );

  if (!verification.valid) {
    console.warn(`⚠️ Webhook Stripe: Assinatura inválida: ${verification.error}`);
    return NextResponse.json(
      { error: 'Assinatura inválida' },
      { status: 400 },
    );
  }

  // 2. Parse do Payload
  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return NextResponse.json(
      { error: 'Payload JSON inválido' },
      { status: 400 },
    );
  }

  // 3. Processamento Idempotente via Inbox
  const result = await processStripeWebhookEvent(supabaseServer, event);

  if (result.status === 'failed') {
    return NextResponse.json(
      { error: 'Falha ao processar evento', details: result.error },
      { status: 500 },
    );
  }

  return NextResponse.json({
    received: true,
    eventId: event.id,
    status: result.status,
  });
}
