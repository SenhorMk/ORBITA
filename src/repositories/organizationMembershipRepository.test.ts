import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import {
  parseOrganizationId,
  parseOrganizationActorId,
} from '@/lib/organizationAuthorization';
import { SupabaseOrganizationMemberships } from './organizationMembershipRepository';

const ACTOR = parseOrganizationActorId('99000000-0000-4000-8000-000000000001');
const ORGANIZATION = parseOrganizationId('99100000-0000-4000-8000-000000000001');
if (!ACTOR || !ORGANIZATION) throw new Error('Authorization fixtures must be valid UUIDs.');

function membershipClient() {
  const filters: Array<readonly [string, unknown]> = [];
  const activeQuery = {
    select: () => activeQuery,
    eq: (column: string, value: unknown) => { filters.push([column, value]); return activeQuery; },
    maybeSingle: async () => ({ data: { organizacao_id: ORGANIZATION, versao: 7 }, error: null }),
  };
  const membershipQuery = {
    select: () => membershipQuery,
    eq: (column: string, value: unknown) => { filters.push([column, value]); return membershipQuery; },
    order: () => membershipQuery,
    limit: () => membershipQuery,
    maybeSingle: async () => ({
      data: {
        papel: 'admin',
        organizacao_id: ORGANIZATION,
        organizacoes: {
          id: ORGANIZATION,
          nome: 'Organização adapter',
          slug: 'organizacao-adapter',
          created_at: '2026-08-24T00:00:00Z',
          updated_at: '2026-08-24T00:00:00Z',
        },
      },
      error: null,
    }),
  };
  return {
    filters,
    // SAFETY: this structural fake implements only the Supabase operations exercised by this adapter contract.
    client: {
      from: (table: string) => table === 'contextos_organizacao_ativos' ? activeQuery : membershipQuery,
      rpc: async () => ({ data: null, error: null }),
    } as unknown as SupabaseClient,
  };
}

describe('SupabaseOrganizationMemberships contract', () => {
  it('joins the persisted active version to the exact membership authority', async () => {
    const { client, filters } = membershipClient();
    const result = await new SupabaseOrganizationMemberships(client).findMembership(
      ACTOR,
      { _tag: 'FirstMembership' },
    );

    expect(result).toMatchObject({
      _tag: 'MembershipFound',
      membership: { actorId: ACTOR, organizationId: ORGANIZATION, role: 'admin', selectionVersion: 7 },
    });
    expect(filters).toContainEqual(['user_id', ACTOR]);
    expect(filters).toContainEqual(['organizacao_id', ORGANIZATION]);
  });

  it('maps an atomic compare-and-swap loser to a stale result', async () => {
    const rpcCalls: unknown[] = [];
    // SAFETY: this structural fake implements the single RPC operation exercised by this adapter contract.
    const client = {
      rpc: async (name: string, parameters: unknown) => {
        rpcCalls.push([name, parameters]);
        return { data: [{ aplicado: false, versao: null }], error: null };
      },
    } as unknown as SupabaseClient;

    await expect(new SupabaseOrganizationMemberships(client).switchActiveOrganization(ACTOR, ORGANIZATION, 7))
      .resolves.toEqual({ _tag: 'OrganizationSwitchStale' });
    expect(rpcCalls).toEqual([[
      'alternar_organizacao_ativa_cas',
      { p_user_id: ACTOR, p_organizacao_id: ORGANIZATION, p_versao_esperada: 7 },
    ]]);
  });
});
