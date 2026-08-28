/**
 * stripeWebhookHandler.ts
 * Ticket 38: Processador de webhooks Stripe com inbox idempotente e isolamento multi-tenant.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

/**
 * Fronteira do webhook: o payload cru do Stripe nunca é autoridade sem parsing.
 * `created` (timestamp Unix de origem do provider) é obrigatório e usado como
 * versão/ordering pela máquina de estados (ver `database/49_...ordering.sql`).
 */
export const stripeEventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  created: z.number().int().positive(),
  data: z.object({
    object: z.record(z.string(), z.unknown()),
  }),
});
export type StripeEvent = z.infer<typeof stripeEventSchema>;

export type WebhookProcessResult =
  | { status: 'processed'; eventId: string; eventType: string }
  | { status: 'already_processed'; eventId: string }
  | { status: 'ignored'; eventId: string; reason: string }
  /** Evento entregue fora de ordem (replay/atraso): mais antigo que o estado já aplicado. Não regride estado. */
  | { status: 'stale_ignored'; eventId: string; eventType: string }
  | { status: 'failed'; eventId: string; error: string };

/** Deriva os parâmetros de ordering (versão/timestamp do provider) a partir do evento Stripe. */
function orderingParamsFor(event: StripeEvent): { p_event_versao: number; p_event_ocorrido_em: string } {
  return {
    p_event_versao: event.created,
    p_event_ocorrido_em: new Date(event.created * 1000).toISOString(),
  };
}

async function markInboxProcessed(supabase: SupabaseClient, eventId: string): Promise<void> {
  await supabase
    .from('stripe_webhook_events')
    .update({ status: 'processed', processed_at: new Date().toISOString() })
    .eq('id', eventId);
}

/**
 * Processa um evento do Stripe de forma idempotente.
 */
export async function processStripeWebhookEvent(
  supabase: SupabaseClient,
  event: StripeEvent,
): Promise<WebhookProcessResult> {
  const eventId = event.id;
  const eventType = event.type;

  // 1. Verificar idempotência no inbox de webhooks
  const { data: existingEvent } = await supabase
    .from('stripe_webhook_events')
    .select('id, status')
    .eq('id', eventId)
    .maybeSingle();

  if (existingEvent?.status === 'processed') {
    return { status: 'already_processed', eventId };
  }

  // 2. Registrar evento como pendente
  if (!existingEvent) {
    const { error: insertErr } = await supabase
      .from('stripe_webhook_events')
      .insert({
        id: eventId,
        tipo: eventType,
        status: 'pending',
        payload: {
          id: event.id,
          type: event.type,
          data: event.data,
        },
      });

    if (insertErr) {
      console.warn(`[Stripe Webhook] Erro ao inserir evento no inbox: ${insertErr.message}`);
    }
  }

  // 3. Processar evento baseado no tipo
  try {
    const obj = event.data.object;

    if (eventType === 'checkout.session.completed') {
      const orgId =
        (obj.client_reference_id as string) ||
        ((obj.metadata as Record<string, string>)?.organizacao_id as string);
      const customerId = obj.customer as string;
      const subscriptionId = obj.subscription as string;
      const planSlug =
        ((obj.metadata as Record<string, string>)?.plano_slug as string) || 'pro';

      if (!orgId) {
        throw new Error('checkout.session.completed sem organizacao_id associada');
      }

      const { data: rpcData, error: rpcErr } = await supabase.rpc('atualizar_assinatura_stripe_atomica', {
        p_org_id: orgId,
        p_plano_slug: planSlug,
        p_status: 'active',
        p_customer_id: customerId,
        p_subscription_id: subscriptionId,
        p_motivo: 'Checkout Stripe concluído com sucesso',
        p_metadata: { event_id: eventId },
        ...orderingParamsFor(event),
      });

      if (rpcErr) throw rpcErr;
      if ((rpcData as { outcome?: string } | null)?.outcome === 'rejected_stale') {
        await markInboxProcessed(supabase, eventId);
        return { status: 'stale_ignored', eventId, eventType };
      }
    } else if (
      eventType === 'customer.subscription.updated' ||
      eventType === 'customer.subscription.deleted'
    ) {
      const subscriptionId = obj.id as string;
      const customerId = obj.customer as string;
      const stripeStatus = obj.status as string; // 'active', 'past_due', 'canceled', 'unpaid', etc.
      const isCanceled = eventType === 'customer.subscription.deleted' || stripeStatus === 'canceled';

      // Localizar organização pela subscription ou customer ID
      const { data: subData } = await supabase
        .from('assinaturas_organizacao')
        .select('organizacao_id, plano_id')
        .or(`stripe_subscription_id.eq.${subscriptionId},stripe_customer_id.eq.${customerId}`)
        .maybeSingle();

      if (subData?.organizacao_id) {
        const canonicalStatus = isCanceled
          ? 'canceled'
          : stripeStatus === 'past_due'
            ? 'past_due'
            : stripeStatus === 'active'
              ? 'active'
              : 'incomplete';

        const planSlug = isCanceled
          ? 'starter'
          : ((obj.metadata as Record<string, string>)?.plano_slug as string) || 'pro';

        const currentPeriodEnd = obj.current_period_end
          ? new Date((obj.current_period_end as number) * 1000).toISOString()
          : null;

        const { data: rpcData, error: rpcErr } = await supabase.rpc('atualizar_assinatura_stripe_atomica', {
          p_org_id: subData.organizacao_id,
          p_plano_slug: planSlug,
          p_status: canonicalStatus,
          p_customer_id: customerId,
          p_subscription_id: subscriptionId,
          p_periodo_fim: currentPeriodEnd,
          p_motivo: isCanceled ? 'Assinatura Stripe cancelada' : 'Assinatura Stripe atualizada',
          p_metadata: { event_id: eventId, stripe_status: stripeStatus },
          ...orderingParamsFor(event),
        });

        if (rpcErr) throw rpcErr;
        if ((rpcData as { outcome?: string } | null)?.outcome === 'rejected_stale') {
          await markInboxProcessed(supabase, eventId);
          return { status: 'stale_ignored', eventId, eventType };
        }
      }
    } else if (eventType === 'invoice.payment_failed') {
      const customerId = obj.customer as string;
      const subscriptionId = obj.subscription as string;

      const { data: subData } = await supabase
        .from('assinaturas_organizacao')
        .select('organizacao_id')
        .or(`stripe_subscription_id.eq.${subscriptionId},stripe_customer_id.eq.${customerId}`)
        .maybeSingle();

      if (subData?.organizacao_id) {
        await supabase
          .from('assinaturas_organizacao')
          .update({ status: 'past_due', updated_at: new Date().toISOString() })
          .eq('organizacao_id', subData.organizacao_id);
      }
    }

    // 4. Marcar como processado no inbox
    await markInboxProcessed(supabase, eventId);

    return { status: 'processed', eventId, eventType };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Stripe Webhook] Erro ao processar evento ${eventId}:`, errorMsg);

    await supabase
      .from('stripe_webhook_events')
      .update({
        status: 'failed',
        erro: errorMsg,
      })
      .eq('id', eventId);

    return { status: 'failed', eventId, error: errorMsg };
  }
}
