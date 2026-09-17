import { NextResponse } from 'next/server';
import { createScopedOAuthTransaction, OAUTH_TRANSACTION_TTL_SECONDS } from '../../../../lib/oauth-transaction';
import type { OAuthTransactionStorePort } from '../../../../lib/oauthTransactionStore';
import { organizationContextStatus, type OrganizationContextResult } from '../../../../lib/organizationAuthorization';
import { organizationContextToScope, type VerifiedOrganizationScope } from '../../../../lib/verifiedOrganizationScope';
import { checkRateLimit, normalizeIp, rateLimitDenialStatus, DEFAULT_RATE_LIMIT_POLICIES, type RateLimitStorePort } from '../../../../lib/rateLimit';
import { organizacaoEsperadaDivergente, ORGANIZACAO_ESPERADA_DIVERGENTE } from '../../../../lib/integrations/organizacaoEsperada';
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

/** O escopo verificado, ou a resposta HTTP que recusa a requisicao. */
type AutorizacaoDoAuthorize =
  | { readonly _tag: 'Autorizado'; readonly scope: VerifiedOrganizationScope }
  | { readonly _tag: 'Negado'; readonly response: NextResponse };

/**
 * Todas as recusas do `authorize`, na ordem em que precisam acontecer.
 *
 * Iniciar o OAuth é uma capacidade de GESTÃO, o mesmo contrato de
 * `POST /api/bling/connect`. Sem essa verificação, qualquer `member` poderia
 * disparar a autorização com o Client ID da organização e vincular a conta
 * Bling da empresa a uma transação que ele controla.
 *
 * Ordem: contexto verificado (401/403/503) → capacidade `organization:manage`
 * (403) → organização esperada pela tela (409).
 */
async function autorizarInicioDoOAuth(
  request: Request,
  resolveOrganizationContext: BlingAuthorizeDependencies['resolveOrganizationContext'],
): Promise<AutorizacaoDoAuthorize> {
  const contextResult = await resolveOrganizationContext(request);
  if (contextResult._tag !== 'OrganizationContextResolved') {
    const status = organizationContextStatus(contextResult);
    return {
      _tag: 'Negado',
      response: NextResponse.json(
        { success: false, error: status === 503 ? 'Serviço de autorização indisponível.' : 'Sessão inválida ou expirada.' },
        { status },
      ),
    };
  }

  if (!contextResult.context.capabilities.has('organization:manage')) {
    return {
      _tag: 'Negado',
      response: NextResponse.json(
        { success: false, error: 'Capacidade insuficiente para gerenciar integrações' },
        { status: 403 },
      ),
    };
  }

  // A organizacao que a tela acreditava estar ativa quando o botao foi
  // clicado. Divergiu? A autorizacao seria iniciada com o Client ID de outra
  // organizacao — e nao ha por que adivinhar qual delas o usuario quis.
  const esperada = new URL(request.url).searchParams.get('organizacao_esperada');
  if (organizacaoEsperadaDivergente(esperada, contextResult.context.organizationId)) {
    return {
      _tag: 'Negado',
      response: NextResponse.json({ success: false, error: ORGANIZACAO_ESPERADA_DIVERGENTE }, { status: 409 }),
    };
  }

  return { _tag: 'Autorizado', scope: organizationContextToScope(contextResult.context) };
}

/**
 * `GET /api/bling/authorize` — inicia a conexão OAuth com o Bling.
 *
 * Fluxo: rate limit → autorização de gestão → Client ID da organização →
 * transação OAuth persistida → URL de autorização + cookie da transação.
 *
 * Não grava credenciais nem tokens: só prepara a transação que o callback
 * consumirá. O cookie é `httpOnly`, restrito ao caminho do callback e expira
 * junto com a transação.
 *
 * VEIO DE: `autorizar()` em `IntegrationsPanel.tsx`.
 * ONDE O NAVEGADOR SAI DO ORBITA: esta rota só devolve `authorizeUrl`; é o
 * painel que redireciona a aba para o Bling. A pessoa autoriza lá e o Bling a
 * devolve para `GET /api/bling/callback` (ver `callback/handler.ts`).
 */
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

    const autorizacao = await autorizarInicioDoOAuth(request, dependencies.resolveOrganizationContext);
    if (autorizacao._tag === 'Negado') return autorizacao.response;

    const { scope } = autorizacao;
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
      // O prazo do cookie e o prazo da transacao sao o mesmo prazo.
      maxAge: OAUTH_TRANSACTION_TTL_SECONDS,
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
