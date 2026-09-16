import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { readBearerToken } from './bearer-token';

/**
 * Identidade e autorização de serviço — o primeiro degrau da autorização.
 *
 * Este módulo responde "quem é o chamador", nunca "o que ele pode fazer".
 * Identidade não é autorização: papel e capacidade vêm do vínculo persistido
 * em `membros_organizacao`, resolvido por `organizationAuthorization` e
 * `requestOrganizationContext`. `app_metadata` do provedor não concede papel.
 *
 * Duas responsabilidades:
 *
 * - **identidade** — `resolveAuthenticatedIdentity` verifica o bearer junto ao
 *   Supabase Auth e distingue sessão ausente, inválida e provedor indisponível;
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
 * Usado pelo webhook do Bling: `authorizeSignedServiceTenant` prova a origem por
 * HMAC contra segredos que o servidor possui, e devolve a organização daquela
 * conexão. A autoridade é a assinatura, não um metadado do usuário. O símbolo
 * privado impede que outro módulo fabrique um `VerifiedTenant` sem essa prova.
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

/**
 * Verifica o bearer da requisição e devolve apenas a identidade.
 *
 * Erros 4xx do provedor (exceto 429) significam token recusado → `SessionInvalid`,
 * que vira 401. Erros 5xx, 429 ou falha de rede significam que não foi possível
 * decidir → `IdentityProviderUnavailable`, que vira 503. Assim uma instabilidade
 * do provedor não é apresentada ao usuário como "sessão inválida".
 */
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
 * Resolve o tenant de um webhook a partir da assinatura HMAC.
 *
 * Os candidatos vêm do servidor (organização → segredo), nunca do corpo da
 * requisição. Cada segredo chega já em claro: abrir a credencial cifrada é
 * responsabilidade do vault (`credenciais_integracao`), e o chamador precisa
 * dizer de onde a tirou. A comparação usa `timingSafeEqual` para não vazar,
 * pelo tempo de resposta, quantos bytes da assinatura estavam corretos.
 * O primeiro candidato cuja assinatura confere define o tenant.
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
