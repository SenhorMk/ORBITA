/**
 * stripeWebhook.test.ts
 * Ticket 14: testes da máquina de estados idempotente
 * `processStripeWebhookEvent` (ticket 13, preservada intacta). A verificação
 * de assinatura oficial (`constructEvent` do SDK real) é coberta por
 * `src/services/stripe/stripeSdkAdapter.contract.test.ts` — a verificação
 * HMAC caseira que existia aqui foi removida junto com `stripeClient.ts`.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  processStripeWebhookEvent,
  type StripeEvent,
} from './stripeWebhookHandler';

const ORG_ID = '97700000-0000-4000-8000-000000000001';

describe('Ticket 38/14: Stripe Webhook Processing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        created: 1_700_000_000,
        data: { object: {} },
      };

      const result = await processStripeWebhookEvent(mockSupabase, event);
      expect(result.status).toBe('already_processed');
    });

    it('processa checkout.session.completed e chama RPC atualizar_assinatura_stripe_atomica com ordering do evento', async () => {
      const rpcMock = vi.fn().mockResolvedValueOnce({ data: { outcome: 'applied' }, error: null });
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
        created: 1_700_000_100,
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
        p_event_versao: 1_700_000_100,
        p_event_ocorrido_em: new Date(1_700_000_100 * 1000).toISOString(),
      });
    });

    it('marca evento como stale_ignored (sem regredir estado) quando o RPC reporta outcome rejected_stale', async () => {
      const rpcMock = vi.fn().mockResolvedValueOnce({
        data: { outcome: 'rejected_stale', motivo: 'evento antigo' },
        error: null,
      });
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
          return {};
        }),
        rpc: rpcMock,
      } as unknown as SupabaseClient;

      const event: StripeEvent = {
        id: 'evt_replay_antigo',
        type: 'checkout.session.completed',
        created: 1_600_000_000, // muito anterior a um estado ja aplicado no banco
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

      expect(result.status).toBe('stale_ignored');
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'processed' }),
      );
    });

    it('processa customer.subscription.deleted revertendo status para canceled', async () => {
      const rpcMock = vi.fn().mockResolvedValueOnce({ data: { outcome: 'applied' }, error: null });
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
        created: 1_700_000_200,
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
