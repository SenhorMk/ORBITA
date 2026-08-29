import { NextResponse } from 'next/server';
import { createBlingCallbackHandler, type BlingCallbackDependencies, type PersistBlingTokensInput, type ResolvedBlingCredentials } from './handler';
import { blingVaultCredentialsSchema } from '@/lib/config/blingCredentialsContract';

export const dynamic = 'force-dynamic';

// Re-exported so existing tests and callers can keep importing the pure
// handler and its types from `./route` — the production entrypoint.
export { createBlingCallbackHandler };
export type { BlingCallbackDependencies, PersistBlingTokensInput, ResolvedBlingCredentials };

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
      // Mesma forma que `POST /api/bling/connect` grava, validada aqui pelo
      // schema compartilhado em vez de casts — a fronteira escrita/leitura do
      // cofre é fechada por um único módulo.
      const parsedCreds = blingVaultCredentialsSchema.safeParse(creds);
      if (parsedCreds.success) {
        return {
          clientId: parsedCreds.data.client_id,
          clientSecret: parsedCreds.data.client_secret,
          organizationConnectionId: String(conn.id),
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
