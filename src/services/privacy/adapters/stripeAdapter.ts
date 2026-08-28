/**
 * stripeAdapter.ts
 * Ticket 17: adapter do sistema "stripe". Stripe aqui é o provedor de
 * cobrança da própria ORBITA para a organização (ticket 14,
 * `assinaturas_organizacao.stripe_customer_id`) — não guarda dado de
 * clientes finais da loja. Só é relevante para titular `lojista_user`.
 *
 * Acesso/exportação: leitura real do identificador vinculado (não é
 * necessário chamar a API da Stripe — a ORBITA não replica PII do Customer
 * Stripe localmente além do id).
 * Exclusão: sempre `retained_with_reason` — apagar o Customer Stripe com
 * assinatura ativa quebra faturamento e obrigação contábil de manter
 * registro de cobrança (ver ADR, `needs-owner` para o catálogo exato de
 * fundamentos aceitos por tipo de direito).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AdapterOutcome, DireitoTipo, TitularSystemAdapter, TitularTaskContext } from './types';

export const STRIPE_RETENTION_FUNDAMENTO = 'billing_ativo_retencao_contabil';

export interface TitularStripePort {
  findStripeCustomerId(organizationId: string): Promise<string | null>;
}

export class StripeAdapter implements TitularSystemAdapter {
  readonly sistema = 'stripe' as const;

  constructor(private readonly port: TitularStripePort) {}

  async execute(direito: DireitoTipo, context: TitularTaskContext): Promise<AdapterOutcome> {
    if (context.titularTipo !== 'lojista_user') {
      // Stripe (billing da organização) nunca guarda dado de cliente_final da loja.
      return { status: 'not_found' };
    }

    if (direito === 'exclusao' || direito === 'correcao') {
      return { status: 'retained_with_reason', fundamento: STRIPE_RETENTION_FUNDAMENTO };
    }

    const customerId = await this.port.findStripeCustomerId(context.organizationId);
    if (!customerId) return { status: 'not_found' };

    return { status: 'completed', data: { stripeCustomerId: customerId } };
  }
}

export class SupabaseTitularStripePort implements TitularStripePort {
  constructor(private readonly supabase: SupabaseClient) {}

  async findStripeCustomerId(organizationId: string): Promise<string | null> {
    const { data, error } = await this.supabase
      .from('assinaturas_organizacao')
      .select('stripe_customer_id')
      .eq('organizacao_id', organizationId)
      .maybeSingle();
    if (error) throw new Error(`Falha ao buscar stripe_customer_id: ${error.message}`);
    return data?.stripe_customer_id ?? null;
  }
}
