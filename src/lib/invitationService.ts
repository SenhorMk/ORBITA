/**
 * Convites e membros de organização: criar convite, aceitar, revogar membro e
 * listar convites.
 *
 * **Dois clientes Supabase, com papéis diferentes:**
 * - o **cliente do ator** carrega o JWT do usuário verificado. As RPCs de
 *   convite e de revogação (`criar_convite_organizacao`,
 *   `aceitar_convite_organizacao`, `revogar_membro_organizacao`) decidem
 *   dentro do banco com base em `auth.uid()`: quem convida ou revoga precisa
 *   ter papel de gestão, e quem aceita precisa ser o destinatário. Com a chave
 *   `service_role` não há sujeito, `auth.uid()` é nulo e a RPC recusa;
 * - o **cliente privilegiado** (`service_role`, ignora RLS) é usado no snapshot
 *   de entitlement, cujas contagens não podem depender da visibilidade por
 *   linha, e pela rota na listagem de convites — que, por ignorar RLS, depende
 *   do filtro pelo `organizacao_id` já verificado.
 *
 * **Entitlement:** antes de criar um convite, `authorizeEntitlement` confere se
 * o ciclo de vida da organização permite a mutação e se o plano ainda tem vaga
 * de membro. As regras de plano não são reimplementadas aqui.
 *
 * **Falha de leitura não vira lista vazia:** `listOrgInvites` lança, para que a
 * tela não conclua que um convite pendente não existe.
 */
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
 * `criar_convite_organizacao` is `security definer` and authorizes the caller
 * through `auth.uid()`, so it only works on a client carrying the user's JWT.
 * The entitlement snapshot, in contrast, is an authorization read whose counts
 * must not depend on row-level visibility, so it stays privileged. Requiring
 * both as separate named fields keeps the distinction explicit at every call
 * site.
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
 * A checagem de plano e de ciclo de vida é delegada a `authorizeEntitlement`,
 * que decide a partir do escopo já verificado (não de um `orgId` cru) se a
 * organização está num estado que permite a mutação e se há capacidade no
 * plano; uma negação lança antes de qualquer escrita. A permissão de quem
 * convida é conferida pela própria RPC, via `auth.uid()`.
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
 * client has no subject and the RPC fails closed. The RPC also checks that the
 * invite is still `pending` and addressed to the caller's own **confirmed**
 * e-mail, read from `auth.users` — never an e-mail sent by the client.
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
 * a service-role client has no subject and the RPC fails closed.
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
 * **Uma leitura que falhou não devolve lista vazia.** Transformar "não foi
 * possível saber" em "não há convite nenhum" faria a tela concluir que um
 * convite pendente não existe — e um convite que some da lista é um convite
 * que ninguém revoga nem acompanha. Pelo mesmo motivo o parse é estrito: uma
 * linha que não casa com o schema é falha do servidor, não um item a descartar.
 *
 * Quem chama traduz a exceção em 500 com a frase pública fixa; o diagnóstico
 * fica no log. O `orgId` deve vir do escopo verificado, porque o cliente
 * usado pela rota é privilegiado e só este filtro separa as organizações.
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
