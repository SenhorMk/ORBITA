import { NextResponse } from 'next/server';
import { createScopedOAuthTransaction } from '../../../../lib/oauth-transaction';
import type { OAuthTransactionStorePort } from '../../../../lib/oauthTransactionStore';
import { organizationContextStatus, type OrganizationContextResult } from '../../../../lib/organizationAuthorization';
import { organizationContextToScope, type VerifiedOrganizationScope } from '../../../../lib/verifiedOrganizationScope';
import { checkRateLimit, normalizeIp, rateLimitDenialStatus, DEFAULT_RATE_LIMIT_POLICIES, type RateLimitStorePort } from '../../../../lib/rateLimit';
import { logger } from '../../../../lib/observability/logger';
import { getCorrelationId } from '../../../../lib/observability/correlation';

export const dynamic = 'force-dynamic';

const BLING_OAUTH_AUTHORIZE_URL =
  process.env.BLING_OAUTH_AUTHORIZE_URL || 'https://www.bling.com.br/Api/v3/oauth/authorize';

/** Explicit dependencies for the Bling authorize handler; production wiring lives in `GET`. */
export interface BlingAuthorizeDependencies {
  readonly resolveOrganizationContext: (request: Request) => Promise<OrganizationContextResult>;
  readonly findBlingClientId: (scope: VerifiedOrganizationScope) => Promise<string | null>;
  readonly oauthTransactionStore: OAuthTransactionStorePort;
  readonly rateLimitStore: RateLimitStorePort;
}

/** Build the Bling OAuth authorize handler around explicit rate-limit, organization and transaction seams. */
export function createBlingAuthorizeHandler(dependencies: BlingAuthorizeDependencies) {
  return async function blingAuthorizeHandler(request: Request): Promise<NextResponse> {
    const correlationId = getCorrelationId(request);

    const rateLimitDecision = await checkRateLimit(
      dependencies.rateLimitStore,
      'bling_authorize',
      normalizeIp(request),
      DEFAULT_RATE_LIMIT_POLICIES.bling_authorize,
    );
    if (rateLimitDecision._tag !== 'RateLimitAllowed') {
      logger.warn('bling_authorize.rate_limited', { subsystem: 'app', correlationId, provider: 'bling', tag: rateLimitDecision._tag });
      return NextResponse.json(
        { success: false, error: 'Muitas tentativas. Tente novamente mais tarde.' },
        { status: rateLimitDenialStatus(rateLimitDecision) },
      );
    }

    const contextResult = await dependencies.resolveOrganizationContext(request);
    if (contextResult._tag !== 'OrganizationContextResolved') {
      const status = organizationContextStatus(contextResult);
      return NextResponse.json(
        { success: false, error: status === 503 ? 'Serviço de autorização indisponível.' : 'Sessão inválida ou expirada.' },
        { status },
      );
    }

    const scope = organizationContextToScope(contextResult.context);
    const clientId = await dependencies.findBlingClientId(scope);

    if (!clientId) {
      return NextResponse.json(
        { success: false, error: 'Nenhum Client ID configurado para esta conta.' },
        { status: 409 },
      );
    }

    const transaction = await createScopedOAuthTransaction(scope, dependencies.oauthTransactionStore);
    if (transaction._tag === 'OAuthTransactionCreationFailed') {
      logger.error('bling_authorize.transaction_store_unavailable', {
        subsystem: 'app',
        correlationId,
        provider: 'bling',
        reason: transaction.reason,
      });
      return NextResponse.json(
        { success: false, error: 'Configuração segura do servidor incompleta.' },
        { status: 503 },
      );
    }

    const authorizeUrl =
      `${BLING_OAUTH_AUTHORIZE_URL}` +
      `?response_type=code` +
      `&client_id=${encodeURIComponent(clientId)}` +
      `&state=${encodeURIComponent(transaction.state)}`;

    logger.info('bling_authorize.url_issued', { subsystem: 'app', correlationId, provider: 'bling' });

    const response = NextResponse.json({ success: true, authorizeUrl });
    response.cookies.set('orbita_oauth_transaction', transaction.cookieValue, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 600,
      path: '/api/bling/callback',
    });

    return response;
  };
}

/** Production Bling OAuth authorize route. */
export async function GET(request: Request): Promise<NextResponse> {
  const { supabaseServer } = await import('../../../../lib/supabaseServer');
  const { createSupabaseOAuthTransactionStore } = await import('../../../../lib/oauthTransactionStore');
  const { createSupabaseRateLimitStore } = await import('../../../../lib/rateLimitStore');
  const { resolveActiveRequestOrganizationContext } = await import('../../../../lib/requestOrganizationContext');

  const handler = createBlingAuthorizeHandler({
    resolveOrganizationContext: resolveActiveRequestOrganizationContext,
    findBlingClientId: async (scope) => {
      const { data } = await supabaseServer
        .from('conexoes_integracao')
        .select('metadata')
        .eq('organizacao_id', scope.organizationId)
        .eq('provedor', 'bling')
        .maybeSingle();
      // SAFETY: PostgREST JSON is narrowed to an object and client_id is validated before use.
      const parsed = typeof data?.metadata === 'object' && data.metadata !== null
        ? data.metadata as Record<string, unknown>
        : null;
      return typeof parsed?.client_id === 'string' && parsed.client_id.length > 0
        ? parsed.client_id
        : null;
    },
    oauthTransactionStore: createSupabaseOAuthTransactionStore(supabaseServer),
    rateLimitStore: createSupabaseRateLimitStore(supabaseServer),
  });

  return handler(request);
}
