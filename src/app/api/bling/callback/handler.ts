/**
 * Retorno do OAuth do Bling (`GET /api/bling/callback`), sem dependências de produção.
 *
 * Ordem das etapas, e por que ela importa:
 * 1. rate limit por IP;
 * 2. consumo da transação de uso único — antes de olhar `code` ou `error`,
 *    para que um retorno repetido nunca produza efeito;
 * 3. rate limit por ator, agora conhecido;
 * 4. recusa do provedor ou ausência de `code`;
 * 5. credenciais do aplicativo da organização vinculada à transação;
 * 6. troca do código por tokens e persistência — só então a página de sucesso.
 *
 * Toda resposta limpa o cookie da transação.
 */
import { NextResponse } from 'next/server';
import { consumeOAuthTransaction } from '../../../../lib/oauth-transaction';
import type { OAuthTransactionStorePort } from '../../../../lib/oauthTransactionStore';
import type { BlingOAuthTokenExchangeResult } from '../../../../services/blingOAuth';
import { checkRateLimit, normalizeIp, rateLimitDenialStatus, DEFAULT_RATE_LIMIT_POLICIES, type RateLimitStorePort } from '../../../../lib/rateLimit';
import { logger } from '../../../../lib/observability/logger';
import { getCorrelationId } from '../../../../lib/observability/correlation';
import { resolveAppBaseUrl } from '../../../../lib/config/appBaseUrl';

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
    // As duas metades falham por motivos completamente diferentes, e juntá-las
    // numa mensagem só apagaria o diagnóstico.
    const semState = !stateParam;
    const semCookie = !transactionCookie;
    logger.warn('bling_callback.transaction_missing', {
      subsystem: 'app',
      correlationId,
      provider: 'bling',
      tag: semState && semCookie ? 'sem-state-e-sem-cookie' : semState ? 'sem-state' : 'sem-cookie',
    });

    const mensagem = semState && semCookie
      ? 'O Bling não devolveu o parâmetro state e o cookie da sessão de conexão também não chegou. '
        + 'Comece de novo pelo botão Conectar Bling, na mesma aba e no mesmo endereço.'
      : semState
        ? 'O Bling não devolveu o parâmetro state no retorno. Confira, no cadastro do aplicativo, '
          + 'se a URL de retorno é exatamente https://orbita.mkautobots.site/api/bling/callback, sem barra no final.'
        : 'O cookie da sessão de conexão não chegou até aqui. Isso acontece quando a autorização demora '
          + 'demais, quando ela é concluída em outra aba, ou quando o navegador bloqueia cookies deste site. '
          + 'Clique em Conectar Bling e conclua a autorização na mesma aba.';

    return {
      _tag: 'Denied',
      response: clearOAuthTransaction(htmlPage('error', mensagem)),
    };
  }

  // Consume the single-use transaction (state hash match + conditional update)
  // BEFORE branching on provider error/success and BEFORE any token exchange.
  // A replayed callback URL (same cookie/state) is denied here with no
  // further effect: no second consumption, no second exchange.
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

  // A página de sucesso só pode ser escrita DEPOIS de os tokens estarem
  // gravados. Uma falha de persistência vira página de erro com o cookie da
  // transação limpo, nunca "Conexão Realizada!" sem token no cofre.
  try {
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
  } catch (causa) {
    logger.error('bling_callback.token_persist_failed', {
      subsystem: 'app',
      correlationId,
      provider: 'bling',
      reason: causa instanceof Error ? causa.name : 'unknown',
    });
    return clearOAuthTransaction(
      htmlPage(
        'error',
        'A autorizacao foi concedida pelo Bling, mas os tokens nao puderam ser gravados com seguranca. '
        + 'A conexao nao foi estabelecida. Clique em Conectar Bling para tentar de novo.',
        500,
      ),
    );
  }

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
      // O Bling diz por que recusou (`error` e `error_description` da RFC 6749);
      // a página mostra um motivo acionável, sem ecoar texto arbitrário.
      const motivo = describeProviderDenial(errorParam, searchParams.get('error_description'));
      logger.warn('bling_callback.provider_denied', {
        subsystem: 'app',
        correlationId,
        provider: 'bling',
        tag: sanitizeOAuthErrorCode(errorParam),
      });
      return clearOAuthTransaction(htmlPage('error', `O Bling recusou a autorização. ${motivo}`));
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


/** Códigos de erro OAuth 2.0 (RFC 6749 §4.1.2.1) devolvidos pelo Bling. */
const OAUTH_DENIAL_HINTS: Readonly<Record<string, string>> = {
  invalid_request: 'A requisição de autorização estava malformada.',
  unauthorized_client: 'Este aplicativo não está autorizado a usar o fluxo authorization_code. Verifique o cadastro do aplicativo no Bling.',
  access_denied: 'A autorização foi negada na tela do Bling — provavelmente o botão de recusar, ou o usuário logado não tem permissão sobre a conta.',
  unsupported_response_type: 'O Bling não aceitou response_type=code para este aplicativo.',
  invalid_scope: 'Os escopos cadastrados no aplicativo não são válidos.',
  server_error: 'O Bling teve uma falha interna. Tente novamente em alguns minutos.',
  temporarily_unavailable: 'O Bling está temporariamente indisponível. Tente novamente em alguns minutos.',
  invalid_client: 'O Client ID não corresponde a nenhum aplicativo ativo no Bling. Confira o Client ID salvo no Passo 1 e se o aplicativo está publicado.',
  // `forbidden` e `insufficient_scope` sao recusas do Bling sobre ESCOPOS, nao
  // sobre as credenciais: a documentacao define escopo como "a representacao da
  // permissao para operar sobre os recursos do usuario". Chegar aqui significa
  // que o usuario Bling que autorizou nao tem permissao sobre algum modulo que
  // o aplicativo declarou — nada no ORBITA muda esse resultado.
  forbidden: 'O usuário do Bling que autorizou não tem permissão sobre algum dos escopos declarados no aplicativo. Autorize com o usuário proprietário da conta, ou remova do cadastro do aplicativo os escopos que esse usuário não acessa. Trocar escopos revoga as autorizações existentes, então refaça o Passo 2 depois.',
  insufficient_scope: 'O aplicativo não declarou no Bling todos os escopos que o ORBITA precisa. Revise a lista de escopos no cadastro do aplicativo e refaça o Passo 2.',
};

/**
 * Reduz o código do provedor a um token curto e seguro para log e exibição.
 * Nunca ecoa conteúdo arbitrário da query string de volta para a página.
 */
export function sanitizeOAuthErrorCode(value: string): string {
  const normalized = value.trim().toLowerCase().slice(0, 40);
  return /^[a-z0-9_-]+$/u.test(normalized) ? normalized : 'unknown_error';
}

/** Mensagem acionável a partir do erro do provedor, sem ecoar texto arbitrário. */
export function describeProviderDenial(errorParam: string, errorDescription: string | null): string {
  const code = sanitizeOAuthErrorCode(errorParam);
  const hint = OAUTH_DENIAL_HINTS[code];
  if (hint) return `(${code}) ${hint}`;

  // Sem correspondência conhecida: mostra o código, e a descrição só quando
  // ela é curta e imprimível — o valor vem da URL e não é confiável.
  const description = (errorDescription ?? '').trim();
  const safeDescription = description.length > 0 && description.length <= 200 && !/[<>]/u.test(description)
    ? ` ${description}`
    : '';
  return `(${code})${safeDescription}`;
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
  const base = resolveAppBaseUrl({
    APP_BASE_URL: process.env.APP_BASE_URL,
    STRIPE_APP_BASE_URL: process.env.STRIPE_APP_BASE_URL,
  });
  const appOrigin = base._tag === 'AppBaseUrlResolved' ? base.origin : null;
  const desc = isSuccess
    ? 'Sua conta do Bling foi vinculada com sucesso.'
    : message;
  const color = isSuccess ? '#10b981' : '#ef4444';
  // Um link de volta ao app, e não `window.close()`: a autorização acontece na
  // própria aba do usuário, então fechá-la fecha o aplicativo.
  const returnLink = appOrigin
    ? `<a class="btn" href="${appOrigin}/?aba=integracoes">Voltar para o ORBITA</a>`
    : '<a class="btn" href="/">Voltar para o ORBITA</a>';

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
    ${returnLink}
  </div>
  <script>
    // Esta pagina so se fecha quando ela mesma foi aberta por script. O fluxo
    // do ORBITA navega a propria aba, entao nao existe opener: chamar
    // window.close() aqui fechava a aba do aplicativo do usuario.
    if (window.opener) {
      window.opener.postMessage(
        { type: 'BLING_AUTH_COMPLETE', status: '${status}' },
        ${JSON.stringify(appOrigin ?? '/')}
      );
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
