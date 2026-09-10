import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { VerifiedOrganizationScope } from './verifiedOrganizationScope';
import { authorizeEntitlement } from '../services/authorizeEntitlement';

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
 * The two Supabase identities an invite creation needs, kept explicit.
 *
 * Ticket 26: `criar_convite_organizacao` is `security definer` and authorizes
 * the caller through `auth.uid()`, so it only works on a client carrying the
 * user's JWT. The entitlement snapshot, in contrast, is an authorization read
 * whose counts must not depend on row-level visibility, so it stays privileged.
 * Requiring both makes the distinction impossible to collapse by accident.
 */
export interface OrganizationInviteClients {
  /** Service-role client used for the privileged entitlement/lifecycle snapshot. */
  readonly privileged: SupabaseClient;

  /** Client carrying the verified user's access token, so `auth.uid()` resolves. */
  readonly actor: SupabaseClient;
}

/**
 * Create an organization invite for a collaborator.
 *
 * Ticket 13: a única porta de entrada para autorização é `authorizeEntitlement`
 * — decide, a partir do escopo já verificado (nunca do `orgId` cru), se a
 * organização está num estado que permite a mutação e se há capacidade no
 * plano. Nenhuma checagem de plano/status é reimplementada aqui.
 *
 * @param clients - Privileged and actor-scoped Supabase clients.
 * @param scope - Organization scope already verified against persisted membership.
 * @param input - Untrusted invite input, parsed here.
 * @returns The created invite id and its single-use token.
 */
export async function createOrgInvite(
  clients: OrganizationInviteClients,
  scope: VerifiedOrganizationScope,
  input: CreateInviteInput,
): Promise<{ id: string; token: string }> {
  const validated = createInviteInputSchema.parse(input);

  await authorizeEntitlement(clients.privileged, scope, {
    category: 'resource_mutation',
    name: 'convidar_membro',
    limitedResource: 'membros',
  });

  const token = generateInviteToken();

  const { data, error } = await clients.actor.rpc('criar_convite_organizacao', {
    p_org_id: scope.organizationId,
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
 *
 * `aceitar_convite_organizacao` binds the new membership to `auth.uid()`, so
 * `actorSupabase` must carry the verified user's access token — a service-role
 * client has no subject and the RPC fails closed (Ticket 26).
 *
 * @param actorSupabase - Supabase client carrying the acting user's access token.
 * @param token - The single-use invite token.
 * @returns The organization the caller has just joined.
 */
export async function acceptOrgInvite(
  actorSupabase: SupabaseClient,
  token: string,
): Promise<{ organizacaoId: string }> {
  const validated = acceptInviteInputSchema.parse({ token });

  const { data, error } = await actorSupabase.rpc('aceitar_convite_organizacao', {
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
 *
 * `revogar_membro_organizacao` checks the caller's own owner/admin role through
 * `auth.uid()`, so `actorSupabase` must carry the verified user's access token;
 * a service-role client has no subject and the RPC fails closed (Ticket 26).
 *
 * @param actorSupabase - Supabase client carrying the acting user's access token.
 * @param orgId - The organization whose membership is being revoked.
 * @param targetUserId - The member to remove.
 * @returns `true` when the membership was removed.
 */
export async function revokeOrgMember(
  actorSupabase: SupabaseClient,
  orgId: string,
  targetUserId: string,
): Promise<boolean> {
  const { data, error } = await actorSupabase.rpc('revogar_membro_organizacao', {
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
 *
 * **Ticket 06 — uma leitura que falhou nao devolve lista vazia.** As duas
 * saidas silenciosas de antes diziam a mesma mentira, uma no plural e outra no
 * singular: `if (error || !data) return []` transformava "nao foi possivel
 * saber" em "nao ha convite nenhum", e o `safeParse` por item descartava em
 * silencio a linha que nao casava com o schema. Nas duas, a tela concluia que
 * o convite **nao existe** — e um convite pendente que desaparece da lista e
 * um convite que ninguem revoga e ninguem acompanha.
 *
 * E o mesmo julgamento que a rota de membros ja aplica desde o Ticket 20: um
 * convite persistido que o servidor nao sabe ler e falha do servidor. Quem
 * chama traduz a excecao em 500 com a frase publica fixa; o diagnostico fica
 * no log.
 *
 * @throws Se a leitura falhar ou se alguma linha nao corresponder ao contrato.
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

  if (error) {
    throw new Error(error.message || 'Falha ao listar convites da organizacao');
  }

  return conviteSchema.array().parse(data ?? []);
}
