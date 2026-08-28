import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authorizeEntitlement, EntitlementDeniedError } from './authorizeEntitlement';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

interface FakeOrgRow {
  status: 'active' | 'suspended' | 'pending_deletion' | 'deleted';
  suspenso_em: string | null;
  motivo_suspensao: string | null;
  exclusao_agendada_para: string | null;
  updated_at: string;
}

interface FakeEntitlements {
  plano_slug: string;
  status: 'trial' | 'active' | 'past_due' | 'canceled' | 'incomplete';
  limite_membros: number;
  limite_conexoes_bling: number;
  limite_conexoes_chatwoot: number;
  recursos: Record<string, boolean>;
}

function buildFakeSupabase(opts: {
  org: FakeOrgRow;
  entitlements: FakeEntitlements;
  membrosCount: number;
  blingCount?: number;
  chatwootCount?: number;
}): SupabaseClient {
  const from = (table: string) => {
    if (table === 'organizacoes') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: opts.org, error: null }),
          }),
        }),
      };
    }
    if (table === 'membros_organizacao') {
      return {
        select: () => ({
          eq: async () => ({ count: opts.membrosCount, error: null }),
        }),
      };
    }
    if (table === 'conexoes_integracao') {
      return {
        select: () => ({
          eq: (_col: string, provedor: string) => ({
            eq: () => ({
              eq: async () => ({
                count: provedor === 'bling' ? (opts.blingCount ?? 0) : (opts.chatwootCount ?? 0),
                error: null,
              }),
            }),
          }),
        }),
      };
    }
    throw new Error(`tabela inesperada no teste: ${table}`);
  };

  return {
    from: from as unknown as SupabaseClient['from'],
    rpc: (async () => ({ data: opts.entitlements, error: null })) as unknown as SupabaseClient['rpc'],
  } as unknown as SupabaseClient;
}

const scopeFor = (organizationId: string): VerifiedOrganizationScope =>
  ({ organizationId, actorId: 'user-1', role: 'member' }) as unknown as VerifiedOrganizationScope;

describe('Ticket 13: authorizeEntitlement (application service único)', () => {
  it('autoriza convite de membro quando organização está ativa e abaixo do limite (org A, starter)', async () => {
    const supabase = buildFakeSupabase({
      org: { status: 'active', suspenso_em: null, motivo_suspensao: null, exclusao_agendada_para: null, updated_at: '2026-08-01T00:00:00.000Z' },
      entitlements: {
        plano_slug: 'starter',
        status: 'active',
        limite_membros: 3,
        limite_conexoes_bling: 1,
        limite_conexoes_chatwoot: 1,
        recursos: {},
      },
      membrosCount: 1,
    });

    const result = await authorizeEntitlement(supabase, scopeFor('org-a'), {
      category: 'resource_mutation',
      name: 'convidar_membro',
      limitedResource: 'membros',
    });

    expect(result.snapshot.state.kind).toBe('active');
    expect(result.snapshot.planoSlug).toBe('starter');
  });

  it('nega convite de membro (LIMIT_EXCEEDED) quando organização A (starter) está no limite, mas organização B (pro) com a mesma contagem é autorizada', async () => {
    const orgA = buildFakeSupabase({
      org: { status: 'active', suspenso_em: null, motivo_suspensao: null, exclusao_agendada_para: null, updated_at: '2026-08-01T00:00:00.000Z' },
      entitlements: { plano_slug: 'starter', status: 'active', limite_membros: 3, limite_conexoes_bling: 1, limite_conexoes_chatwoot: 1, recursos: {} },
      membrosCount: 3,
    });
    const orgB = buildFakeSupabase({
      org: { status: 'active', suspenso_em: null, motivo_suspensao: null, exclusao_agendada_para: null, updated_at: '2026-08-01T00:00:00.000Z' },
      entitlements: { plano_slug: 'pro', status: 'active', limite_membros: 10, limite_conexoes_bling: 3, limite_conexoes_chatwoot: 3, recursos: {} },
      membrosCount: 3,
    });

    const operation = { category: 'resource_mutation' as const, name: 'convidar_membro', limitedResource: 'membros' as const };

    await expect(authorizeEntitlement(orgA, scopeFor('org-a'), operation)).rejects.toThrow(EntitlementDeniedError);
    await expect(authorizeEntitlement(orgB, scopeFor('org-b'), operation)).resolves.toBeDefined();
  });

  it('nega mutação (LIFECYCLE_BLOCKED) quando organização está suspensa, independente do papel (member ou owner)', async () => {
    const supabase = buildFakeSupabase({
      org: {
        status: 'suspended',
        suspenso_em: '2026-08-15T00:00:00.000Z',
        motivo_suspensao: 'Inadimplencia Stripe',
        exclusao_agendada_para: null,
        updated_at: '2026-08-15T00:00:00.000Z',
      },
      entitlements: { plano_slug: 'pro', status: 'active', limite_membros: 10, limite_conexoes_bling: 3, limite_conexoes_chatwoot: 3, recursos: {} },
      membrosCount: 1,
    });

    const operation = { category: 'resource_mutation' as const, name: 'convidar_membro', limitedResource: 'membros' as const };

    for (const role of ['member', 'owner'] as const) {
      const scope = { organizationId: 'org-suspensa', actorId: 'user-x', role } as unknown as VerifiedOrganizationScope;
      const error = await authorizeEntitlement(supabase, scope, operation).catch((e) => e);
      expect(error).toBeInstanceOf(EntitlementDeniedError);
      expect((error as EntitlementDeniedError).code).toBe('LIFECYCLE_BLOCKED');
    }
  });

  it('permite exportação/leitura mesmo com organização suspensa (LGPD)', async () => {
    const supabase = buildFakeSupabase({
      org: {
        status: 'suspended',
        suspenso_em: '2026-08-15T00:00:00.000Z',
        motivo_suspensao: 'Inadimplencia Stripe',
        exclusao_agendada_para: null,
        updated_at: '2026-08-15T00:00:00.000Z',
      },
      entitlements: { plano_slug: 'pro', status: 'active', limite_membros: 10, limite_conexoes_bling: 3, limite_conexoes_chatwoot: 3, recursos: {} },
      membrosCount: 1,
    });

    const result = await authorizeEntitlement(supabase, scopeFor('org-suspensa'), {
      category: 'export',
      name: 'exportar_dados_lgpd',
    });

    expect(result.snapshot.state.kind).toBe('suspended');
  });
});
