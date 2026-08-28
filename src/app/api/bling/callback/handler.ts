import { NextResponse } from 'next/server';
import { consumeOAuthTransaction } from '../../../../lib/oauth-transaction';
import type { OAuthTransactionStorePort } from '../../../../lib/oauthTransactionStore';
import type { BlingOAuthTokenExchangeResult } from '../../../../services/blingOAuth';
import { checkRateLimit, normalizeIp, rateLimitDenialStatus, DEFAULT_RATE_LIMIT_POLICIES, type RateLimitStorePort } from '../../../../lib/rateLimit';
import { logger } from '../../../../lib/observability/logger';
import { getCorrelationId } from '../../../../lib/observability/correlation';

/** Credentials resolved for the token exchange, plus where to persist the resulting tokens. */
export interface ResolvedBlingCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly organizationConnectionId: string | null;
  readonly legacyRecordId: string | null;
}

/** Input required to persist tokens after a successful exchange. */
export interface PersistBlingTokensInput {
  readonly userId: string;
  readonly organizacaoId: string | undefined;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly organizationConnectionId: string | null;
  readonly legacyRecordId: string | null;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
}

/** Explicit dependencies for the Bling callback handler; production wiring lives in `route.ts`'s `GET`. */
export interface BlingCallbackDependencies {
  readonly oauthTransactionStore: OAuthTransactionStorePort;
  readonly rateLimitStore: RateLimitStorePort;
  readonly exchangeAuthorizationCode: (input: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly code: string;
  }) => Promise<BlingOAuthTokenExchangeResult>;
  readonly resolveCredentials: (
    userId: string,
    organizacaoId: string | undefined,
  ) => Promise<ResolvedBlingCredentials | null>;
  readonly persistTokens: (input: PersistBlingTokensInput) => Promise<void>;
}

/** Enforces one rate-limit policy for the callback, returning a denial page when exceeded. */
async function enforceCallbackRateLimit(
  rateLimitStore: RateLimitStorePort,
  key: string,
  correlationId: string,
  logEvent: string,
): Promise<NextResponse | null> {
  const decision = await checkRateLimit(rateLimitStore, 'bling_callback', key, DEFAULT_RATE_LIMIT_POLICIES.bling_callback);
  if (decision._tag === 'RateLimitAllowed') return null;
  logger.warn(logEvent, { subsystem: 'app', correlationId, provider: 'bling', tag: decision._tag });
  return clearOAuthTransaction(
    htmlPage('error', 'Muitas tentativas. Tente novamente mais tarde.', rateLimitDenialStatus(decision)),
  );
}

/** Consumes the single-use OAuth transaction tied to the callback's cookie/state pair. */
async function resolveCallbackTransaction(
  request: Request,
  oauthTransactionStore: OAuthTransactionStorePort,
  correlationId: string,
): Promise<
  | { readonly _tag: 'Resolved'; readonly userId: string; readonly organizacaoId: string | undefined }
  | { readonly _tag: 'Denied'; readonly response: NextResponse }
> {
  const { searchParams } = new URL(request.url);
  const stateParam = searchParams.get('state');
  const cookieHeader = request.headers.get('cookie') || '';
  const transactionMatch = cookieHeader.match(/orbita_oauth_transaction=([^;]+)/);
  const transactionCookie = transactionMatch ? decodeURIComponent(transactionMatch[1]) : null;

  if (!stateParam || !transactionCookie) {
    return {
      _tag: 'Denied',
      response: clearOAuthTransaction(htmlPage('error', 'Transação OAuth ausente ou inválida. Tente conectar novamente.')),
    };
  }

  // Consume the single-use transaction (constant-time state check, CAS
  // consumption) BEFORE branching on provider error/success and BEFORE any
  // token exchange. A replayed callback URL (same cookie/state) is denied
  // here with no further effect: no second consumption, no second exchange.
  const transaction = await consumeOAuthTransaction(transactionCookie, stateParam, oauthTransactionStore);
  if (transaction._tag === 'InvalidOAuthTransaction') {
    logger.warn('bling_callback.transaction_denied', {
      subsystem: 'app',
      correlationId,
      provider: 'bling',
      reason: transaction.reason,
    });
    const status = transaction.reason === 'store-unavailable' ? 503 : 400;
    return {
      _tag: 'Denied',
      response: clearOAuthTransaction(
        htmlPage(
          'error',
          transaction.reason === 'store-unavailable'
            ? 'Serviço de autorização indisponível. Tente novamente em instantes.'
            : 'Transação OAuth expirada ou inválida. Tente conectar novamente.',
          status,
        ),
      ),
    };
  }

  return { _tag: 'Resolved', userId: transaction.userId, organizacaoId: transaction.organizacaoId };
}

/** Exchanges the authorization code for tokens and persists them via the configured seam. */
async function exchangeAndPersistTokens(
  dependencies: BlingCallbackDependencies,
  code: string,
  userId: string,
  organizacaoId: string | undefined,
  credentials: ResolvedBlingCredentials,
  correlationId: string,
): Promise<NextResponse> {
  logger.info('bling_callback.exchanging_code', { subsystem: 'app', correlationId, provider: 'bling' });

  const tokenData = await dependencies.exchangeAuthorizationCode({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    code,
  });

  if (tokenData._tag === 'BlingOAuthTokenExchangeFailed') {
    logger.error('bling_callback.token_exchange_failed', {
      subsystem: 'app',
      correlationId,
      provider: 'bling',
      reason: tokenData.reason,
      status: tokenData.status,
    });
    return clearOAuthTransaction(htmlPage('error', 'Não foi possível concluir a conexão com o Bling.'));
  }
  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1_000).toISOString();

  logger.info('bling_callback.tokens_received', { subsystem: 'app', correlationId, provider: 'bling' });

  await dependencies.persistTokens({
    userId,
    organizacaoId,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    organizationConnectionId: credentials.organizationConnectionId,
    legacyRecordId: credentials.legacyRecordId,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt,
  });

  logger.info('bling_callback.completed', { subsystem: 'app', correlationId, provider: 'bling' });

  return clearOAuthTransaction(htmlPage('success', ''));
}

/** Build the Bling OAuth callback handler around explicit rate-limit, transaction and provider seams. */
export function createBlingCallbackHandler(dependencies: BlingCallbackDependencies) {
  return async function blingCallbackHandler(request: Request): Promise<NextResponse> {
    const correlationId = getCorrelationId(request);
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const errorParam = searchParams.get('error');

    const ipDenial = await enforceCallbackRateLimit(dependencies.rateLimitStore, normalizeIp(request), correlationId, 'bling_callback.rate_limited');
    if (ipDenial) return ipDenial;

    const transactionResult = await resolveCallbackTransaction(request, dependencies.oauthTransactionStore, correlationId);
    if (transactionResult._tag === 'Denied') return transactionResult.response;
    const { userId, organizacaoId } = transactionResult;

    const actorDenial = await enforceCallbackRateLimit(dependencies.rateLimitStore, `actor:${userId}`, correlationId, 'bling_callback.actor_rate_limited');
    if (actorDenial) return actorDenial;

    if (errorParam) {
      logger.warn('bling_callback.provider_denied', { subsystem: 'app', correlationId, provider: 'bling' });
      return clearOAuthTransaction(htmlPage('error', 'O Bling recusou a autorização.'));
    }
    if (!code) {
      return clearOAuthTransaction(
        htmlPage('error', 'Código de autorização não retornado pelo Bling.'),
      );
    }

    const credentials = await dependencies.resolveCredentials(userId, organizacaoId);
    if (!credentials) {
      return clearOAuthTransaction(
        htmlPage('error', 'Credenciais não encontradas. Salve as configurações primeiro.'),
      );
    }

    return exchangeAndPersistTokens(dependencies, code, userId, organizacaoId, credentials, correlationId);
  };
}

export function clearOAuthTransaction(response: NextResponse): NextResponse {
  response.cookies.set('orbita_oauth_transaction', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/api/bling/callback',
  });
  return response;
}

export function htmlPage(status: 'success' | 'error', message: string, statusCode: number = status === 'error' ? 400 : 200) {
  const isSuccess = status === 'success';
  const icon = isSuccess ? '✅' : '❌';
  const title = isSuccess ? 'Conexão Realizada!' : 'Erro na Conexão';
  const desc = isSuccess
    ? 'Sua conta do Bling foi vinculada com sucesso. Você já pode fechar esta janela.'
    : message;
  const color = isSuccess ? '#10b981' : '#ef4444';

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - ORBITA</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #09090b;
      color: #f4f4f5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 1rem;
    }
    .card {
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 12px;
      padding: 2.5rem;
      max-width: 440px;
      width: 100%;
      text-align: center;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }
    .icon { font-size: 3.5rem; margin-bottom: 1rem; }
    h1 { font-size: 1.5rem; font-weight: 600; margin: 0 0 0.75rem 0; color: #fff; }
    p { font-size: 0.95rem; color: #a1a1aa; line-height: 1.5; margin: 0 0 1.5rem 0; }
    .btn {
      display: inline-block;
      background: ${color};
      color: #fff;
      font-weight: 500;
      font-size: 0.9rem;
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      text-decoration: none;
      cursor: pointer;
      border: none;
      transition: opacity 0.2s;
    }
    .btn:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${desc}</p>
    <button class="btn" onclick="window.close()">Fechar Janela</button>
  </div>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: 'BLING_AUTH_COMPLETE', status: '${status}' }, '*');
      setTimeout(() => window.close(), 2500);
    }
  </script>
</body>
</html>`;

  return new NextResponse(html, {
    status: statusCode,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
