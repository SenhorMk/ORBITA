import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  acceptInviteInputSchema,
  createInviteInputSchema,
  createOrgInvite,
  generateInviteToken,
} from './invitationService';
import { EntitlementDeniedError } from '../services/authorizeEntitlement';
import type { VerifiedOrganizationScope } from './verifiedOrganizationScope';

function buildFakeSupabase(opts: {
  orgStatus: 'active' | 'suspended' | 'pending_deletion' | 'deleted';
  limiteMembros: number;
  membrosCount: number;
  rpcResult?: { data: unknown; error: unknown };
}): SupabaseClient {
  const from = (table: string) => {
    if (table === 'organizacoes') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: {
                status: opts.orgStatus,
                suspenso_em: opts.orgStatus === 'suspended' ? '2026-08-15T00:00:00.000Z' : null,
                motivo_suspensao: opts.orgStatus === 'suspended' ? 'Inadimplencia' : null,
                exclusao_agendada_para: null,
                updated_at: '2026-08-01T00:00:00.000Z',
              },
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === 'membros_organizacao') {
      return { select: () => ({ eq: async () => ({ count: opts.membrosCount, error: null }) }) };
    }
    if (table === 'conexoes_integracao') {
      return {
        select: () => ({ eq: () => ({ eq: () => ({ eq: async () => ({ count: 0, error: null }) }) }) }),
      };
    }
    throw new Error(`tabela inesperada no teste: ${table}`);
  };

  const rpc = vi.fn(async (fnName: string) => {
    if (fnName === 'obter_entitlements_organizacao') {
      return {
        data: {
          plano_slug: 'starter',
          status: 'active',
          limite_membros: opts.limiteMembros,
          limite_conexoes_bling: 1,
          limite_conexoes_chatwoot: 1,
          recursos: {},
        },
        error: null,
      };
    }
    if (fnName === 'criar_convite_organizacao') {
      return opts.rpcResult ?? { data: 'convite-id-123', error: null };
    }
    throw new Error(`RPC inesperada no teste: ${fnName}`);
  });

  return {
    from: from as unknown as SupabaseClient['from'],
    rpc: rpc as unknown as SupabaseClient['rpc'],
  } as unknown as SupabaseClient;
}

/** RPC names a fake client built by `buildFakeSupabase` was asked to execute. */
function rpcNames(client: SupabaseClient): readonly string[] {
  const rpc = client.rpc as unknown as { mock: { calls: readonly (readonly unknown[])[] } };
  return rpc.mock.calls.map((call) => String(call[0]));
}

const scope: VerifiedOrganizationScope = {
  organizationId: 'org-convite-1',
  actorId: 'user-owner-1',
  role: 'owner',
} as unknown as VerifiedOrganizationScope;

describe('Invitation Service & Schemas', () => {
  it('generates a 64-character hexadecimal secure token', () => {
    const token = generateInviteToken();
    expect(typeof token).toBe('string');
    expect(token).toHaveLength(64);
    expect(/^[a-f0-9]{64}$/.test(token)).toBe(true);
  });

  it('validates valid invite input with default and explicit roles', () => {
    const defaultRoleInput = {
      email: 'novo.membro@empresa.com',
    };
    const parsedDefault = createInviteInputSchema.safeParse(defaultRoleInput);
    expect(parsedDefault.success).toBe(true);
    if (parsedDefault.success) {
      expect(parsedDefault.data.papel).toBe('member');
    }

    const explicitAdminInput = {
      email: 'gestor@empresa.com',
      papel: 'admin',
    };
    const parsedAdmin = createInviteInputSchema.safeParse(explicitAdminInput);
    expect(parsedAdmin.success).toBe(true);
  });

  it('rejects invalid invite input (malformed email or illegal role like owner)', () => {
    const invalidEmailInput = {
      email: 'not-an-email',
      papel: 'member',
    };
    expect(createInviteInputSchema.safeParse(invalidEmailInput).success).toBe(false);

    const illegalOwnerInput = {
      email: 'owner@empresa.com',
      papel: 'owner', // direct invite as owner is forbidden
    };
    expect(createInviteInputSchema.safeParse(illegalOwnerInput).success).toBe(false);
  });

  it('validates accept invite token input', () => {
    const validInput = {
      token: 'a'.repeat(64),
    };
    expect(acceptInviteInputSchema.safeParse(validInput).success).toBe(true);

    const invalidShortInput = {
      token: 'short',
    };
    expect(acceptInviteInputSchema.safeParse(invalidShortInput).success).toBe(false);
  });

  describe('createOrgInvite (Ticket 13: gate único via authorizeEntitlement)', () => {
    it('cria convite quando a organização está ativa e abaixo do limite', async () => {
      const supabase = buildFakeSupabase({ orgStatus: 'active', limiteMembros: 3, membrosCount: 1 });

      const result = await createOrgInvite({ privileged: supabase, actor: supabase }, scope, { email: 'novo@empresa.com', papel: 'member' });

      expect(result.id).toBe('convite-id-123');
      expect(typeof result.token).toBe('string');
    });

    it('nega a criação de convite (EntitlementDeniedError/LIFECYCLE_BLOCKED) quando a organização está suspensa', async () => {
      const supabase = buildFakeSupabase({ orgStatus: 'suspended', limiteMembros: 3, membrosCount: 1 });

      const error = await createOrgInvite({ privileged: supabase, actor: supabase }, scope, { email: 'novo@empresa.com', papel: 'member' }).catch(
        (e) => e,
      );

      expect(error).toBeInstanceOf(EntitlementDeniedError);
      expect((error as EntitlementDeniedError).code).toBe('LIFECYCLE_BLOCKED');
    });

    it('nega a criação de convite (LIMIT_EXCEEDED) quando o limite de membros do plano já foi atingido', async () => {
      const supabase = buildFakeSupabase({ orgStatus: 'active', limiteMembros: 3, membrosCount: 3 });

      const error = await createOrgInvite({ privileged: supabase, actor: supabase }, scope, { email: 'novo@empresa.com', papel: 'member' }).catch(
        (e) => e,
      );

      expect(error).toBeInstanceOf(EntitlementDeniedError);
      expect((error as EntitlementDeniedError).code).toBe('LIMIT_EXCEEDED');
    });

    it('executa criar_convite_organizacao no cliente do usuário, nunca no privilegiado (Ticket 26)', async () => {
      // `criar_convite_organizacao` autoriza o autor por `auth.uid()`, que só
      // existe no cliente que carrega o JWT do usuário. Executá-la no cliente
      // service_role deixa `auth.uid()` NULL e a RPC aborta em produção.
      const privileged = buildFakeSupabase({ orgStatus: 'active', limiteMembros: 3, membrosCount: 1 });
      const actor = buildFakeSupabase({ orgStatus: 'active', limiteMembros: 3, membrosCount: 1 });

      await createOrgInvite({ privileged, actor }, scope, { email: 'novo@empresa.com', papel: 'member' });

      expect(rpcNames(actor)).toContain('criar_convite_organizacao');
      expect(rpcNames(privileged)).not.toContain('criar_convite_organizacao');
    });
  });
});
