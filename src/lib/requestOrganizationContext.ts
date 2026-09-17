/**
 * O ponto de entrada da autorização nas rotas HTTP.
 *
 * Cada rota chama uma função daqui e recebe de volta ou um
 * `VerifiedOrganizationScope` (organização + pessoa, já conferidos) ou uma
 * resposta de recusa pronta: 401 sem sessão válida, 403 sem permissão, 503 se
 * o provedor de identidade ou o banco não responderam.
 *
 * Há dois jeitos de escolher a organização:
 * - a organização ativa da pessoa → `resolveVerifiedOrganizationScope`;
 * - a organização que vem na URL (`/organizacoes/[id]`) →
 *   `authorizeRequestOrganizationCapability`.
 *
 * Nos dois casos, o `organizacao_id` que as camadas seguintes usam sai do
 * vínculo gravado no banco, nunca do corpo, da query ou do cookie da requisição.
 *
 * ENTRA AQUI POR: o início das rotas em `src/app/api/**`.
 * PASSA POR: `auth.ts` (identidade) → `organizationAuthorization.ts` (vínculo,
 * papel, capabilities) → `organizationMembershipRepository.ts` (leitura no banco).
 * SAI DAQUI: um `VerifiedOrganizationScope`. Da linha seguinte da rota em
 * diante, a organização é confiável e pode ir para repositories e services.
 */
import { NextResponse } from 'next/server';
import { supabaseServer } from './supabaseServer';
import {
  resolveOrganizationContext,
  activeOrganizationSelection,
  verifyRequestIdentity,
  organizationContextStatus,
  organizationCapabilitiesForRole,
  type OrganizationCapability,
  type OrganizationContextResult,
  type OrganizationSelection,
} from './organizationAuthorization';
import {
  organizationContextToScope,
  verifyOrganizationScope,
  type VerifiedOrganizationScope,
} from './verifiedOrganizationScope';

// Reexportado por conveniência das rotas, que já importam deste módulo. A
// definição vive em `verifiedOrganizationScope`, que não constrói cliente
// Supabase no load — este módulo constrói, e um adaptador HTTP não deve
// carregar isso só para perguntar o que um papel pode fazer.
export { escopoTemCapacidade } from './verifiedOrganizationScope';
import { SupabaseOrganizationMemberships } from '@/repositories/organizationMembershipRepository';

const memberships = new SupabaseOrganizationMemberships(supabaseServer);

/** Resolve organization authority using the production Auth and Supabase adapters. */
export function resolveRequestOrganizationContext(
  request: Request,
  selection: OrganizationSelection | null,
): Promise<OrganizationContextResult> {
  return resolveOrganizationContext(request, selection, {
    verifyIdentity: verifyRequestIdentity,
    memberships,
  });
}

/**
 * Resolve a organização ativa persistida do ator (`contextos_organizacao_ativos`),
 * ou o vínculo mais antigo quando não há seleção. O cookie `orbita_active_org`
 * não é lido aqui: ele não carrega autoridade.
 */
export function resolveActiveRequestOrganizationContext(
  request: Request,
): Promise<OrganizationContextResult> {
  return resolveRequestOrganizationContext(request, activeOrganizationSelection());
}

/** Outcome of resolving a verified organization scope for one HTTP request. */
export type RequestOrganizationScopeResult =
  | { readonly _tag: 'RequestScopeResolved'; readonly scope: VerifiedOrganizationScope }
  | { readonly _tag: 'RequestScopeDenied'; readonly response: NextResponse };

/**
 * Resolve the caller's verified organization scope for the active request's
 * membership, or a ready-to-return denial response. Centralizes the
 * organization-context boundary so route handlers never derive
 * `organizacao_id` from client-supplied input.
 */
export async function resolveVerifiedOrganizationScope(request: Request): Promise<RequestOrganizationScopeResult> {
  const contextResult = await resolveActiveRequestOrganizationContext(request);
  if (contextResult._tag !== 'OrganizationContextResolved') {
    const status = organizationContextStatus(contextResult);
    return {
      _tag: 'RequestScopeDenied',
      response: NextResponse.json(
        { success: false, error: status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado' },
        { status },
      ),
    };
  }
  return { _tag: 'RequestScopeResolved', scope: organizationContextToScope(contextResult.context) };
}

/** Tagged outcome of authorizing one capability against the organization named in the URL. */
export type RequestOrganizationCapabilityResult =
  | { readonly _tag: 'OrganizationCapabilityAuthorized'; readonly scope: VerifiedOrganizationScope }
  | { readonly _tag: 'OrganizationCapabilityDenied'; readonly status: 401 | 403 | 503 };

/**
 * Authorize one capability against an organization named by the request path.
 *
 * `resolveActiveRequestOrganizationContext` answers "who is the caller, in the
 * organization they are currently in". Routes under `/organizacoes/[id]` ask a
 * different question: "may this caller do X *in that* organization" — so the
 * membership is looked up for the exact pair, and the role that comes back
 * decides the capability.
 *
 * The three denials stay distinct, so an authenticated caller without
 * permission is never told that the server does not know who they are:
 *
 * - no session, or an invalid one → `401`;
 * - authenticated, but without the capability in that organization → `403`;
 * - identity provider or membership store unreachable → `503`.
 *
 * Denial does not distinguish "that organization has no such membership" from
 * "that organization does not exist": both are `403`, so the answer never
 * confirms an organization the caller is not in.
 */
export async function authorizeRequestOrganizationCapability(
  request: Request,
  organizationId: string,
  capability: OrganizationCapability,
): Promise<RequestOrganizationCapabilityResult> {
  const identity = await verifyRequestIdentity(request);
  if (identity._tag !== 'IdentityVerified') {
    return {
      _tag: 'OrganizationCapabilityDenied',
      status: identity._tag === 'IdentityProviderUnavailable' ? 503 : 401,
    };
  }

  const scopeResult = await verifyOrganizationScope(supabaseServer, {
    organizationId,
    actorId: identity.user.id,
  });
  if (scopeResult._tag === 'OrganizationScopeStoreUnavailable') {
    return { _tag: 'OrganizationCapabilityDenied', status: 503 };
  }
  if (scopeResult._tag !== 'OrganizationScopeVerified') {
    return { _tag: 'OrganizationCapabilityDenied', status: 403 };
  }

  if (!organizationCapabilitiesForRole(scopeResult.scope.role).has(capability)) {
    return { _tag: 'OrganizationCapabilityDenied', status: 403 };
  }

  return { _tag: 'OrganizationCapabilityAuthorized', scope: scopeResult.scope };
}
