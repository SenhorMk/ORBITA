import { NextResponse } from 'next/server';
import { consumeOAuthTransaction } from '../../../../lib/oauth-transaction';
import type { OAuthTransactionStorePort } from '../../../../lib/oauthTransactionStore';
import type { BlingOAuthTokenExchangeResult } from '../../../../services/blingOAuth';
import { checkRateLimit, normalizeIp, rateLimitDenialStatus, DEFAULT_RATE_LIMIT_POLICIES, type RateLimitStorePort } from '../../../../lib/rateLimit';
import { logger } from '../../../../lib/observability/logger';
import { getCorrelationId } from '../../../../lib/observability/correlation';

export const dynamic = 'force-dynamic';

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

/** Explicit dependencies for the Bling callback handler; production wiring lives in `GET`. */
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

/** Build the Bling OAuth callback handler around explicit rate-limit, transaction and provider seams. */
export function createBlingCallbackHandler(dependencies: BlingCallbackDependencies) {
  return async function blingCallbackHandler(request: Request): Promise<NextResponse> {
    const correlationId = getCorrelationId(request);
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const stateParam = searchParams.get('state');
    const errorParam = searchParams.get('error');
    const cookieHeader = request.headers.get('cookie') || '';
    const transactionMatch = cookieHeader.match(/orbita_oauth_transaction=([^;]+)/);
    const transactionCookie = transactionMatch ? decodeURIComponent(transactionMatch[1]) : null;

    const ipRateLimit = await checkRateLimit(
      dependencies.rateLimitStore,
      'bling_callback',
      normalizeIp(request),
      DEFAULT_RATE_LIMIT_POLICIES.bling_callback,
    );
    if (ipRateLimit._tag !== 'RateLimitAllowed') {
      logger.warn('bling_callback.rate_limited', { subsystem: 'app', correlationId, provider: 'bling', tag: ipRateLimit._tag });
      return clearOAuthTransaction(
        htmlPage('error', 'Muitas tentativas. Tente novamente mais tarde.', rateLimitDenialStatus(ipRateLimit)),
      );
    }

    if (!stateParam || !transactionCookie) {
      return clearOAuthTransaction(
        htmlPage('error', 'Transação OAuth ausente ou inválida. Tente conectar novamente.'),
      );
    }

    // Consume the single-use transaction (constant-time state check, CAS
    // consumption) BEFORE branching on provider error/success and BEFORE any
    // token exchange. A replayed callback URL (same cookie/state) is denied
    // here with no further effect: no second consumption, no second exchange.
    const transaction = await consumeOAuthTransaction(transactionCookie, stateParam, dependencies.oauthTransactionStore);
    if (transaction._tag === 'InvalidOAuthTransaction') {
      logger.warn('bling_callback.transaction_denied', {
        subsystem: 'app',
        correlationId,
        provider: 'bling',
        reason: transaction.reason,
      });
      const status = transaction.reason === 'store-unavailable' ? 503 : 400;
      return clearOAuthTransaction(
        htmlPage(
          'error',
          transaction.reason === 'store-unavailable'
            ? 'Serviço de autorização indisponível. Tente novamente em instantes.'
            : 'Transação OAuth expirada ou inválida. Tente conectar novamente.',
          status,
        ),
      );
    }
    const userId = transaction.userId;
    const organizacaoId = transaction.organizacaoId;

    const actorRateLimit = await checkRateLimit(
      dependencies.rateLimitStore,
      'bling_callback',
      `actor:${userId}`,
      DEFAULT_RATE_LIMIT_POLICIES.bling_callback,
    );
    if (actorRateLimit._tag !== 'RateLimitAllowed') {
      logger.warn('bling_callback.actor_rate_limited', { subsystem: 'app', correlationId, provider: 'bling', tag: actorRateLimit._tag });
      return clearOAuthTransaction(
        htmlPage('error', 'Muitas tentativas. Tente novamente mais tarde.', rateLimitDenialStatus(actorRateLimit)),
      );
    }

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
      return clearOAuthTransaction(
        htmlPage('error', 'Não foi possível concluir a conexão com o Bling.'),
      );
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
  };
}

function clearOAuthTransaction(response: NextResponse): NextResponse {
  response.cookies.set('orbita_oauth_transaction', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/api/bling/callback',
  });
  return response;
}

function htmlPage(status: 'success' | 'error', message: string, statusCode: number = status === 'error' ? 400 : 200) {
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

type ProductionSupabaseClient = import('@supabase/supabase-js').SupabaseClient;
type ProductionCredentialsVault = typeof import('../../../../lib/integrations/credentialsVault').credentialsVault;
type ProductionLogger = typeof import('../../../../lib/observability/logger').logger;
type ProductionDecrypt = typeof import('../../../../lib/crypto').decrypt;
type ProductionEncrypt = typeof import('../../../../lib/crypto').encrypt;

/** 1–2. Look up organization-scoped credentials, then fall back to the legacy per-user row. */
async function resolveProductionCredentials(
  supabaseServer: ProductionSupabaseClient,
  credentialsVault: ProductionCredentialsVault,
  decrypt: ProductionDecrypt,
  productionLogger: ProductionLogger,
  userId: string,
  organizacaoId: string | undefined,
): Promise<ResolvedBlingCredentials | null> {
  if (organizacaoId) {
    const { data: conn } = await supabaseServer
      .from('conexoes_integracao')
      .select('id, metadata')
      .eq('organizacao_id', organizacaoId)
      .eq('provedor', 'bling')
      .maybeSingle();

    if (conn?.id) {
      const creds = await credentialsVault.getDecryptedCredentials(organizacaoId, conn.id);
      if (creds?.client_id && creds?.client_secret) {
        return {
          clientId: creds.client_id as string,
          clientSecret: creds.client_secret as string,
          organizationConnectionId: conn.id as string,
          legacyRecordId: null,
        };
      }
    }
  }

  const { data, error } = await supabaseServer
    .from('integracoes_bling')
    .select('id, client_id, client_secret')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    productionLogger.error('bling_callback.legacy_lookup_failed', { subsystem: 'app', provider: 'bling' });
  }

  if (data?.client_id && data?.client_secret) {
    const clientSecret = decrypt(data.client_secret);
    if (clientSecret) {
      return { clientId: data.client_id, clientSecret, organizationConnectionId: null, legacyRecordId: data.id };
    }
  }

  return null;
}

/** 3. Persist tokens into the organization's private credentials vault. */
async function persistOrganizationTokens(
  supabaseServer: ProductionSupabaseClient,
  credentialsVault: ProductionCredentialsVault,
  productionLogger: ProductionLogger,
  organizacaoId: string,
  input: PersistBlingTokensInput,
): Promise<void> {
  const { data: conn, error: connErr } = await supabaseServer
    .from('conexoes_integracao')
    .upsert(
      {
        organizacao_id: organizacaoId,
        provedor: 'bling',
        nome: 'Principal',
        status: 'conectado',
        metadata: { client_id: input.clientId },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organizacao_id, provedor, nome' },
    )
    .select('id')
    .single();

  if (connErr || !conn?.id) {
    productionLogger.error('bling_callback.connection_persist_failed', { subsystem: 'app', provider: 'bling' });
    return;
  }

  await credentialsVault.saveEncryptedCredentials(organizacaoId, conn.id, {
    client_id: input.clientId,
    client_secret: input.clientSecret,
    access_token: input.accessToken,
    refresh_token: input.refreshToken,
    token_expires_at: input.expiresAt,
  });
  productionLogger.info('bling_callback.credentials_saved', { subsystem: 'app', provider: 'bling' });
}

/** 4. Keep the legacy per-user `integracoes_bling` row in sync during migration. */
async function persistLegacyTokens(
  supabaseServer: ProductionSupabaseClient,
  encrypt: ProductionEncrypt,
  input: PersistBlingTokensInput,
): Promise<void> {
  if (input.legacyRecordId) {
    await supabaseServer
      .from('integracoes_bling')
      .update({
        access_token: encrypt(input.accessToken),
        refresh_token: encrypt(input.refreshToken),
        token_expires_at: input.expiresAt,
      })
      .eq('id', input.legacyRecordId);
    return;
  }

  await supabaseServer.from('integracoes_bling').upsert(
    {
      user_id: input.userId,
      client_id: input.clientId,
      client_secret: encrypt(input.clientSecret),
      access_token: encrypt(input.accessToken),
      refresh_token: encrypt(input.refreshToken),
      token_expires_at: input.expiresAt,
    },
    { onConflict: 'user_id' },
  );
}

/** Production Bling OAuth callback route. */
export async function GET(request: Request): Promise<NextResponse> {
  const { supabaseServer } = await import('../../../../lib/supabaseServer');
  const { encrypt, decrypt } = await import('../../../../lib/crypto');
  const { createSupabaseOAuthTransactionStore } = await import('../../../../lib/oauthTransactionStore');
  const { createSupabaseRateLimitStore } = await import('../../../../lib/rateLimitStore');
  const { exchangeBlingAuthorizationCode } = await import('../../../../services/blingOAuth');
  const { credentialsVault } = await import('../../../../lib/integrations/credentialsVault');
  const { logger: productionLogger } = await import('../../../../lib/observability/logger');

  const handler = createBlingCallbackHandler({
    oauthTransactionStore: createSupabaseOAuthTransactionStore(supabaseServer),
    rateLimitStore: createSupabaseRateLimitStore(supabaseServer),
    exchangeAuthorizationCode: exchangeBlingAuthorizationCode,
    resolveCredentials: (userId, organizacaoId) => resolveProductionCredentials(
      supabaseServer, credentialsVault, decrypt, productionLogger, userId, organizacaoId,
    ),
    persistTokens: async (input) => {
      if (input.organizacaoId) {
        await persistOrganizationTokens(supabaseServer, credentialsVault, productionLogger, input.organizacaoId, input);
      }
      await persistLegacyTokens(supabaseServer, encrypt, input);
    },
  });

  return handler(request);
}
