/**
 * `VerifiedOrganizationScope`: organização e pessoa **já conferidas**, prontas
 * para as camadas de dados.
 *
 * Por que isso importa: os repositórios usam a chave `service_role` do Supabase,
 * que ignora RLS (as regras de acesso por linha do banco). Com essa chave, o
 * banco não impede uma consulta de ler dados de outra empresa — quem impede é o
 * filtro por `organizacao_id` que o código aplica. Por isso esse id precisa vir
 * de um escopo verificado, e não de um valor qualquer.
 *
 * O escopo só é criado aqui: a partir de um contexto já autorizado ou de uma
 * consulta ao vínculo no banco. O símbolo privado faz o TypeScript recusar um
 * escopo montado à mão em outro módulo — ajuda do compilador, não segurança de
 * runtime (um cast explícito contorna).
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
