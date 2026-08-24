import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { enforceMemberLimit } from '../services/entitlementsService';

export const invitePapelSchema = z.enum(['admin', 'member']);
export type InvitePapel = z.infer<typeof invitePapelSchema>;

export const createInviteInputSchema = z.object({
  email: z.string().trim().email('Email inválido'),
  papel: invitePapelSchema.default('member'),
});
export type CreateInviteInput = z.infer<typeof createInviteInputSchema>;

export const acceptInviteInputSchema = z.object({
  token: z.string().min(16, 'Token de convite inválido'),
});
export type AcceptInviteInput = z.infer<typeof acceptInviteInputSchema>;

export const conviteSchema = z.object({
  id: z.string().uuid(),
  organizacao_id: z.string().uuid(),
  email: z.string().email(),
  papel: invitePapelSchema,
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  expires_at: z.string(),
  created_by: z.string().uuid(),
  accepted_at: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Convite = z.infer<typeof conviteSchema>;

/**
 * Generate a cryptographically secure invite token.
 */
export function generateInviteToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Create an organization invite for a collaborator.
 */
export async function createOrgInvite(
  supabase: SupabaseClient,
  orgId: string,
  input: CreateInviteInput,
): Promise<{ id: string; token: string }> {
  const validated = createInviteInputSchema.parse(input);

  // Validar limite de membros da organização server-side (Ticket 37)
  await enforceMemberLimit(supabase, orgId);

  const token = generateInviteToken();

  const { data, error } = await supabase.rpc('criar_convite_organizacao', {
    p_org_id: orgId,
    p_email: validated.email,
    p_papel: validated.papel,
    p_token: token,
  });

  if (error || !data) {
    throw new Error(error?.message || 'Falha ao criar convite');
  }

  return {
    id: data as string,
    token,
  };
}

/**
 * Accept an organization invite using its secure token.
 */
export async function acceptOrgInvite(
  supabase: SupabaseClient,
  token: string,
): Promise<{ organizacaoId: string }> {
  const validated = acceptInviteInputSchema.parse({ token });

  const { data, error } = await supabase.rpc('aceitar_convite_organizacao', {
    p_token: validated.token,
  });

  if (error || !data) {
    throw new Error(error?.message || 'Falha ao aceitar convite');
  }

  return {
    organizacaoId: data as string,
  };
}

/**
 * Revoke an organization member immediately.
 */
export async function revokeOrgMember(
  supabase: SupabaseClient,
  orgId: string,
  targetUserId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('revogar_membro_organizacao', {
    p_org_id: orgId,
    p_target_user_id: targetUserId,
  });

  if (error) {
    throw new Error(error.message || 'Falha ao revogar membro');
  }

  return Boolean(data);
}

/**
 * List pending and historical invites for an organization.
 */
export async function listOrgInvites(
  supabase: SupabaseClient,
  orgId: string,
): Promise<readonly Convite[]> {
  const { data, error } = await supabase
    .from('convites_organizacao')
    .select('*')
    .eq('organizacao_id', orgId)
    .order('created_at', { ascending: false });

  if (error || !data) {
    return [];
  }

  const convites: Convite[] = [];
  for (const item of data) {
    const parsed = conviteSchema.safeParse(item);
    if (parsed.success) {
      convites.push(parsed.data);
    }
  }

  return convites;
}
