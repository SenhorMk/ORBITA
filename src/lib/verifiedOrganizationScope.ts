/**
 * Escopo verificado: o par organização/ator que os adaptadores privilegiados aceitam.
 *
 * Repositórios que usam a chave `service_role` ignoram RLS, então não podem
 * confiar num `organizacao_id` qualquer. Eles recebem um
 * `VerifiedOrganizationScope`, que só é construído aqui — a partir de um
 * contexto canônico já resolvido ou de uma consulta ao vínculo persistido.
 * O símbolo privado impede, no sistema de tipos, que outro módulo monte esse
 * objeto à mão sem um cast explícito.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  organizationCapabilitiesForRole,
  type OrganizationCapability,
  type OrganizationContext,
} from './organizationAuthorization';

const verifiedOrganizationScopeBrand: unique symbol = Symbol('VerifiedOrganizationScope');
const organizationActorSchema = z.object({
  organizationId: z.string().uuid(),
  actorId: z.string().uuid(),
});
const organizationRoleSchema = z.enum(['owner', 'admin', 'member']);

/** Organization and actor pair proven against persisted membership server-side. */
export interface VerifiedOrganizationScope {
  readonly organizationId: string;
  readonly actorId: string;
  readonly role: z.infer<typeof organizationRoleSchema>;
  readonly [verifiedOrganizationScopeBrand]: true;
}

export type VerifyOrganizationScopeResult =
  | { readonly _tag: 'OrganizationScopeVerified'; readonly scope: VerifiedOrganizationScope }
  | { readonly _tag: 'OrganizationScopeDenied' }
  | { readonly _tag: 'OrganizationScopeStoreUnavailable'; readonly cause: string };

/** Adapt an already verified canonical request context for privileged adapters. */
export function organizationContextToScope(context: OrganizationContext): VerifiedOrganizationScope {
  return {
    organizationId: context.organizationId,
    actorId: context.actorId,
    role: context.role,
    [verifiedOrganizationScopeBrand]: true,
  };
}

/**
 * Verify the exact organization/actor pair before a service-role adapter can use it.
 * The candidate may originate from a session or verified webhook mapping; authority
 * comes from the persisted membership queried here, never from the candidate alone.
 */
export async function verifyOrganizationScope(
  supabase: SupabaseClient,
  candidate: { readonly organizationId: string; readonly actorId: string },
): Promise<VerifyOrganizationScopeResult> {
  const parsedCandidate = organizationActorSchema.safeParse(candidate);
  if (!parsedCandidate.success) return { _tag: 'OrganizationScopeDenied' };

  const { data, error } = await supabase
    .from('membros_organizacao')
    .select('papel')
    .eq('organizacao_id', parsedCandidate.data.organizationId)
    .eq('user_id', parsedCandidate.data.actorId)
    .maybeSingle();
  if (error) {
    return { _tag: 'OrganizationScopeStoreUnavailable', cause: error.message };
  }
  const parsedRole = organizationRoleSchema.safeParse(data?.papel);
  if (!parsedRole.success) return { _tag: 'OrganizationScopeDenied' };

  return {
    _tag: 'OrganizationScopeVerified',
    scope: {
      organizationId: parsedCandidate.data.organizationId,
      actorId: parsedCandidate.data.actorId,
      role: parsedRole.data,
      [verifiedOrganizationScopeBrand]: true,
    },
  };
}

/**
 * A capacidade que o papel do escopo já verificado concede.
 *
 * As rotas perguntam pela capacidade (`organization:manage`), não pelo nome do
 * papel: a tabela papel → capacidade existe num único lugar
 * (`organizationCapabilitiesForRole`), e o papel vem do vínculo persistido.
 *
 * Mora aqui, e não em `requestOrganizationContext`, porque aquele módulo
 * constrói o cliente Supabase no load: um adaptador HTTP não deve carregar
 * conexão de banco só para perguntar o que um papel pode fazer.
 */
export function escopoTemCapacidade(
  scope: VerifiedOrganizationScope,
  capability: OrganizationCapability,
): boolean {
  return organizationCapabilitiesForRole(scope.role).has(capability);
}
