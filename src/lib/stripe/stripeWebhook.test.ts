/**
 * stripeWebhook.test.ts
 * Ticket 38: Testes de integração e validação de webhooks Stripe.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { verifyStripeWebhookSignature } from './stripeClient';
import {
  processStripeWebhookEvent,
  type StripeEvent,
} from './stripeWebhookHandler';

const TEST_SECRET = 'whsec_test_secret_for_orbita_testing_123';
const ORG_ID = '97700000-0000-4000-8000-000000000001';

function generateValidSignature(payload: string, secret: string, timestamp?: number): string {
  const t = timestamp ?? Math.floor(Date.now() / 1000);
  const payloadToSign = `${t}.${payload}`;
  const hmac = createHmac('sha256', secret).update(payloadToSign).digest('hex');
  return `t=${t},v1=${hmac}`;
}

describe('Ticket 38: Stripe Webhook & Signature Verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('verifyStripeWebhookSignature', () => {
    it('rejeita payload quando header stripe-signature é ausente', () => {
      const result = verifyStripeWebhookSignature('{"id":"evt_1"}', null, TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('ausente');
    });

    it('rejeita quando segredo do webhook é placeholder ou não configurado', () => {
      const result = verifyStripeWebhookSignature(
        '{"id":"evt_1"}',
        't=123,v1=abc',
        'STRIPE_WEBHOOK_SECRET_placeholder',
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain('não configurado');
    });

    it('rejeita quando timestamp está expirado além da tolerância', () => {
      const oldTime = Math.floor(Date.now() / 1000) - 1000;
      const signature = generateValidSignature('{"id":"evt_1"}', TEST_SECRET, oldTime);
      const result = verifyStripeWebhookSignature('{"id":"evt_1"}', signature, TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Timestamp da assinatura expirado');
    });

    it('rejeita quando payload foi adulterado (HMAC inválido)', () => {
      const signature = generateValidSignature('{"id":"evt_1"}', TEST_SECRET);
      const result = verifyStripeWebhookSignature(
        '{"id":"evt_1_tampered"}',
        signature,
        TEST_SECRET,
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Assinatura HMAC inválida');
    });

    it('aprova payload com timestamp e HMAC válidos', () => {
      const payload = JSON.stringify({ id: 'evt_valid_123', type: 'checkout.session.completed' });
      const signature = generateValidSignature(payload, TEST_SECRET);
      const result = verifyStripeWebhookSignature(payload, signature, TEST_SECRET);
      expect(result.valid).toBe(true);
    });
  });

  describe('processStripeWebhookEvent (Idempotent Inbox)', () => {
    it('retorna already_processed se o evento já foi processado anteriormente', async () => {
      const mockSupabase = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValueOnce({
                data: { id: 'evt_dup_123', status: 'processed' },
                error: null,
              }),
            }),
          }),
        }),
      } as unknown as SupabaseClient;

      const event: StripeEvent = {
        id: 'evt_dup_123',
        type: 'checkout.session.completed',
        data: { object: {} },
      };

      const result = await processStripeWebhookEvent(mockSupabase, event);
      expect(result.status).toBe('already_processed');
    });

    it('processa checkout.session.completed e chama RPC atualizar_assinatura_stripe_atomica', async () => {
      const rpcMock = vi.fn().mockResolvedValueOnce({ error: null });
      const insertMock = vi.fn().mockResolvedValueOnce({ error: null });
      const updateMock = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValueOnce({ error: null }),
      });

      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'stripe_webhook_events') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValueOnce({ data: null, error: null }),
                }),
              }),
              insert: insertMock,
              update: updateMock,
            };
          }
          return {};
        }),
        rpc: rpcMock,
      } as unknown as SupabaseClient;

      const event: StripeEvent = {
        id: 'evt_checkout_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            client_reference_id: ORG_ID,
            customer: 'cus_test_1',
            subscription: 'sub_test_1',
            metadata: { plano_slug: 'pro' },
          },
        },
      };

      const result = await processStripeWebhookEvent(mockSupabase, event);

      expect(result.status).toBe('processed');
      expect(rpcMock).toHaveBeenCalledWith('atualizar_assinatura_stripe_atomica', {
        p_org_id: ORG_ID,
        p_plano_slug: 'pro',
        p_status: 'active',
        p_customer_id: 'cus_test_1',
        p_subscription_id: 'sub_test_1',
        p_motivo: 'Checkout Stripe concluído com sucesso',
        p_metadata: { event_id: 'evt_checkout_1' },
      });
    });

    it('processa customer.subscription.deleted revertendo status para canceled', async () => {
      const rpcMock = vi.fn().mockResolvedValueOnce({ error: null });
      const updateMock = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValueOnce({ error: null }),
      });

      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'stripe_webhook_events') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValueOnce({ data: null, error: null }),
                }),
              }),
              insert: vi.fn().mockResolvedValueOnce({ error: null }),
              update: updateMock,
            };
          }
          if (table === 'assinaturas_organizacao') {
            return {
              select: vi.fn().mockReturnValue({
                or: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValueOnce({
                    data: { organizacao_id: ORG_ID, plano_id: '123' },
                    error: null,
                  }),
                }),
              }),
            };
          }
          return {};
        }),
        rpc: rpcMock,
      } as unknown as SupabaseClient;

      const event: StripeEvent = {
        id: 'evt_sub_del_1',
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_test_1',
            customer: 'cus_test_1',
            status: 'canceled',
          },
        },
      };

      const result = await processStripeWebhookEvent(mockSupabase, event);

      expect(result.status).toBe('processed');
      expect(rpcMock).toHaveBeenCalledWith(
        'atualizar_assinatura_stripe_atomica',
        expect.objectContaining({
          p_org_id: ORG_ID,
          p_status: 'canceled',
          p_plano_slug: 'starter',
          p_motivo: 'Assinatura Stripe cancelada',
        }),
      );
    });
  });
});
