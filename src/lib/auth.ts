import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { readBearerToken } from './bearer-token';

/**
 * Identidade e autorização de serviço.
 *
 * O modelo de tenancy **por usuário** foi removido daqui no Ticket 22, fatia C:
 * `resolveLegacyMembership`, `resolveActorContext`, `actorContextDenialStatus`,
 * `verifySessionAndRole`, `ActorContext`, `ActorCapability`, `ActorRole` e
 * `AuthSession`. Eles liam papel de `app_metadata.role`, campo que nenhum fluxo
 * deste sistema escreve, e ficaram sem chamador quando as 19 fronteiras
 * migraram para `membros_organizacao`.
 *
 * O que resta tem duas responsabilidades, e nenhuma delas decide papel:
 *
 * - **identidade** — `resolveAuthenticatedIdentity` verifica o bearer e para
 *   por aí; quem decide vínculo e capacidade é `requestOrganizationContext`;
 * - **autorização de serviço** — `authorizeSignedServiceTenant` prova a origem
 *   de um webhook por HMAC contra segredos do servidor.
 */

const tenantIdSchema = z.uuid().brand<'TenantId'>();
const signedTenantCandidateSchema = z.object({
  tenantId: tenantIdSchema,
  secret: z.string().min(1),
});
const verifiedTenantBrand: unique symbol = Symbol('VerifiedTenant');

/** Minimal authenticated identity returned by the server-side identity provider. */
export interface AuthenticatedUser {
  readonly id: string;
  readonly app_metadata: Record<string, unknown>;
}

/** Narrow port used to verify an access token without coupling authorization to Supabase. */
export interface AuthUserLookup {
  readonly getUser: (token: string) => Promise<{
    readonly data: { readonly user: AuthenticatedUser | null };
    readonly error: {
      readonly message: string;
      readonly status?: number;
      readonly code?: string;
    } | null;
  }>;
}

/** Result of verifying identity only; organization authorization is a separate concern. */
export type AuthenticatedIdentityResult =
  | { readonly _tag: 'IdentityVerified'; readonly user: AuthenticatedUser }
  | { readonly _tag: 'SessionMissing' }
  | { readonly _tag: 'SessionInvalid' }
  | { readonly _tag: 'IdentityProviderUnavailable'; readonly cause: string };

/**
 * Escopo de tenant que só pode ser construído depois de uma verificação confiável.
 *
 * **Não é o modelo antigo.** Sobrou de propósito porque o webhook do Bling o usa:
 * `authorizeSignedServiceTenant` prova a origem por HMAC contra segredos que o
 * servidor possui, e devolve a organização daquela conexão. Nada disso passa por
 * `app_metadata` — a autoridade é a assinatura, não um metadado do usuário.
 */
export interface VerifiedTenant {
  readonly id: z.infer<typeof tenantIdSchema>;
  readonly [verifiedTenantBrand]: true;
}

/** Server-owned mapping from a tenant to the secret that signs its webhooks. */
export interface SignedTenantCandidate {
  readonly tenantId: string;
  readonly secret: string;
}

/** Tagged result of authorizing a non-session server workflow for one tenant. */
export type ServiceTenantAuthorizationResult =
  | { readonly _tag: 'ServiceTenantAuthorized'; readonly tenant: VerifiedTenant }
  | { readonly _tag: 'ServiceTenantDenied' };

const defaultAuthUserLookup: AuthUserLookup = {
  async getUser(token) {
    const { supabaseServer } = await import('./supabaseServer');
    return supabaseServer.auth.getUser(token);
  },
};

/** Verify a bearer session without treating identity-provider metadata as membership authority. */
export async function resolveAuthenticatedIdentity(
  request: Request,
  authUserLookup: AuthUserLookup = defaultAuthUserLookup,
): Promise<AuthenticatedIdentityResult> {
  const bearerResult = readBearerToken(request);
  if (bearerResult._tag !== 'BearerTokenFound') return { _tag: 'SessionMissing' };

  try {
    const { data, error } = await authUserLookup.getUser(bearerResult.token);
    if (error) {
      return error.status !== undefined && error.status < 500 && error.status !== 429
        ? { _tag: 'SessionInvalid' }
        : { _tag: 'IdentityProviderUnavailable', cause: error.code ?? 'auth_provider_error' };
    }
    return data.user
      ? { _tag: 'IdentityVerified', user: data.user }
      : { _tag: 'SessionInvalid' };
  } catch {
    return { _tag: 'IdentityProviderUnavailable', cause: 'auth_provider_unreachable' };
  }
}

/**
 * Resolve a privileged tenant from an HMAC signature and server-owned mappings.
 *
 * Candidate mappings must come from server-side configuration, and each one
 * carries the secret already in clear text. Decryption is deliberately NOT done
 * here: the credential now lives in the vault (`credenciais_integracao`), and
 * only the vault knows how to open it. Ticket 11 — while this function decrypted
 * its own candidates, its single caller (the Bling webhook) kept reading the
 * aposentada `integracoes_bling`, which has been empty since ticket 10b. Every
 * legitimate event got 403. Taking the secret in clear text forces the caller to
 * name where the credential came from.
 */
export function authorizeSignedServiceTenant(
  rawBody: string,
  signature: string,
  candidates: readonly SignedTenantCandidate[],
): ServiceTenantAuthorizationResult {
  const signatureBuffer = Buffer.from(signature);

  for (const untrustedCandidate of candidates) {
    const candidateResult = signedTenantCandidateSchema.safeParse(untrustedCandidate);
    if (!candidateResult.success) continue;

    const secret = candidateResult.data.secret;
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
    const expectedBuffer = Buffer.from(expected);
    if (
      expectedBuffer.length === signatureBuffer.length
      && timingSafeEqual(expectedBuffer, signatureBuffer)
    ) {
      return {
        _tag: 'ServiceTenantAuthorized',
        tenant: { id: candidateResult.data.tenantId, [verifiedTenantBrand]: true },
      };
    }
  }

  return { _tag: 'ServiceTenantDenied' };
}
