import { describe, expect, it } from 'vitest';
import { STRIPE_RETENTION_FUNDAMENTO, StripeAdapter, type TitularStripePort } from './stripeAdapter';
import type { TitularTaskContext } from './types';

class FakeTitularStripePort implements TitularStripePort {
  customerIdByOrg = new Map<string, string>();
  async findStripeCustomerId(organizationId: string) {
    return this.customerIdByOrg.get(organizationId) ?? null;
  }
}

function contextFor(overrides: Partial<TitularTaskContext> = {}): TitularTaskContext {
  return {
    organizationId: 'org-1',
    titularTipo: 'lojista_user',
    titularRefUserId: 'user-1',
    titularRefClienteId: null,
    solicitacaoId: 'req-1',
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('StripeAdapter', () => {
  it('never involves Stripe for a cliente_final titular (Stripe holds org billing, not store customers)', async () => {
    const port = new FakeTitularStripePort();
    const adapter = new StripeAdapter(port);
    const outcome = await adapter.execute('acesso', contextFor({ titularTipo: 'cliente_final', titularRefUserId: null, titularRefClienteId: 'cliente-1' }));
    expect(outcome).toEqual({ status: 'not_found' });
  });

  it('returns not_found when the organization has no Stripe customer yet', async () => {
    const adapter = new StripeAdapter(new FakeTitularStripePort());
    const outcome = await adapter.execute('acesso', contextFor());
    expect(outcome).toEqual({ status: 'not_found' });
  });

  it('exports the linked stripe customer id on acesso/exportacao', async () => {
    const port = new FakeTitularStripePort();
    port.customerIdByOrg.set('org-1', 'cus_123');
    const adapter = new StripeAdapter(port);
    const outcome = await adapter.execute('exportacao', contextFor());
    expect(outcome).toEqual({ status: 'completed', data: { stripeCustomerId: 'cus_123' } });
  });

  it('never promises deletion of a billing customer — always retained_with_reason', async () => {
    const port = new FakeTitularStripePort();
    port.customerIdByOrg.set('org-1', 'cus_123');
    const adapter = new StripeAdapter(port);
    const outcome = await adapter.execute('exclusao', contextFor());
    expect(outcome).toEqual({ status: 'retained_with_reason', fundamento: STRIPE_RETENTION_FUNDAMENTO });
  });
});
