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

/**
 * Lê do cofre o Client ID e o Client Secret do aplicativo Bling da organização.
 *
 * A organização vem da transação OAuth consumida. Sem organização, sem conexão
 * ou com credencial fora do contrato, devolve `null` — não há leitura
 * alternativa por usuário.
 */
async function resolveProductionCredentials(
  supabaseServer: ProductionSupabaseClient,
  credentialsVault: ProductionCredentialsVault,
  organizacaoId: string,
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
        };
      }
    }
  }

  // A credencial do aplicativo vive apenas no cofre por organização; a tabela
  // legada `integracoes_bling` não é fonte de leitura.
  return null;
}

/**
 * Persiste os tokens no cofre privado da organização.
 *
 * ## `conectado` é a ÚLTIMA escrita
 *
 * São três escritas separadas (não uma transação), e só a última afirma que a
 * conexão existe:
 *
 * 1. garantir a linha em `pendente`, só para obter o `id`;
 * 2. gravar os tokens cifrados no cofre (um único upsert da credencial inteira);
 * 3. registrar `integration.connection_authorized` (PRE-008): sem rastro, não
 *    há reativação;
 * 4. só então declarar `conectado`, com a evidência de saúde zerada.
 *
 * Uma falha em 2 deixa `pendente`: a tela diz "Configurado, falta autorizar",
 * que é a verdade. Uma falha em 3 ou 4 deixa tokens gravados sob um `pendente` —
 * o estado afirma menos do que existe, e refazer a autorização não causa dano.
 * Qualquer falha lança, e o callback responde com página de erro.
 */
export async function persistOrganizationTokens(
  supabaseServer: ProductionSupabaseClient,
  credentialsVault: ProductionCredentialsVault,
  productionLogger: ProductionLogger,
  organizacaoId: string,
  input: PersistBlingTokensInput,
  registrarAutorizacao: (conexaoId: string) => Promise<void>,
): Promise<void> {
  const { data: conn, error: connErr } = await supabaseServer
    .from('conexoes_integracao')
    .upsert(
      {
        organizacao_id: organizacaoId,
        provedor: 'bling',
        nome: 'Principal',
        status: 'pendente',
        metadata: { client_id: input.clientId },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organizacao_id, provedor, nome' },
    )
    .select('id')
    .single();

  if (connErr || !conn?.id) {
    // Lança, e não retorna: um retorno silencioso faria o callback escrever a
    // página de sucesso sem token nenhum gravado.
    productionLogger.error('bling_callback.connection_persist_failed', { subsystem: 'app', provider: 'bling' });
    throw new Error('Falha ao gravar a conexao Bling da organizacao');
  }

  await credentialsVault.saveEncryptedCredentials(organizacaoId, conn.id, {
    client_id: input.clientId,
    client_secret: input.clientSecret,
    access_token: input.accessToken,
    refresh_token: input.refreshToken,
    token_expires_at: input.expiresAt,
  });
  productionLogger.info('bling_callback.credentials_saved', { subsystem: 'app', provider: 'bling' });

  try {
    await registrarAutorizacao(String(conn.id));
  } catch {
    productionLogger.error('bling_callback.audit_failed', { subsystem: 'app', provider: 'bling' });
    throw new Error('Falha ao auditar a autorizacao Bling da organizacao');
  }

  // Com os tokens no cofre, e so agora, a conexao pode se dizer conectada. A
  // evidencia de saude nasce limpa: autorizar nao e ter sido verificado.
  const { error: statusErr } = await supabaseServer
    .from('conexoes_integracao')
    .update({
      status: 'conectado',
      last_health_check_at: null,
      last_health_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conn.id)
    .eq('organizacao_id', organizacaoId);

  if (statusErr) {
    productionLogger.error('bling_callback.status_persist_failed', { subsystem: 'app', provider: 'bling' });
    throw new Error('Falha ao concluir a conexao Bling da organizacao');
  }
}

/** Production Bling OAuth callback route. */
export async function GET(request: Request): Promise<NextResponse> {
  const { supabaseServer } = await import('../../../../lib/supabaseServer');
  const { createSupabaseOAuthTransactionStore } = await import('../../../../lib/oauthTransactionStore');
  const { createSupabaseRateLimitStore } = await import('../../../../lib/rateLimitStore');
  const { exchangeBlingAuthorizationCode } = await import('../../../../services/blingOAuth');
  const { credentialsVault } = await import('../../../../lib/integrations/credentialsVault');
  const { logger: productionLogger } = await import('../../../../lib/observability/logger');
  const { auditarAutorizacaoOAuth } = await import('../../../../services/auditoriaDeConexao');

  const handler = createBlingCallbackHandler({
    oauthTransactionStore: createSupabaseOAuthTransactionStore(supabaseServer),
    rateLimitStore: createSupabaseRateLimitStore(supabaseServer),
    exchangeAuthorizationCode: exchangeBlingAuthorizationCode,
    resolveCredentials: (organizacaoId) => resolveProductionCredentials(supabaseServer, credentialsVault, organizacaoId),
    persistTokens: (input) => persistOrganizationTokens(
      supabaseServer, credentialsVault, productionLogger, input.organizacaoId, input,
      (conexaoId) => auditarAutorizacaoOAuth(
        supabaseServer,
        { organizationId: input.organizacaoId, actorId: input.userId },
        { provedor: 'bling', conexaoId, status: 'conectado', correlationId: input.correlationId },
      ),
    ),
  });

  return handler(request);
}
