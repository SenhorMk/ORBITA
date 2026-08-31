import type { SupabaseClient } from '@supabase/supabase-js';

import { authorizeSignedServiceTenant } from '../../../../lib/auth';
import { blingVaultCredentialsSchema } from '../../../../lib/config/blingCredentialsContract';
import { credentialsVault } from '../../../../lib/integrations/credentialsVault';

/**
 * Resolução do tenant do webhook do Bling a partir do cofre de credenciais.
 *
 * Existe como módulo próprio porque era exatamente aqui que a fronteira estava
 * testada de um lado só. O ticket 10b moveu a credencial do Bling para o cofre
 * (`conexoes_integracao` + `credenciais_integracao`) e o webhook continuou
 * lendo `integracoes_bling`, que ficou com zero linhas — nenhum secret para
 * conferir contra a assinatura, portanto `403` em **todo** evento legítimo. O
 * teste do webhook não pegou porque semeava `integracoes_bling` ele mesmo.
 *
 * A defesa é a inversão: a leitura passa por `blingVaultCredentialsSchema`, o
 * mesmo schema que `POST /api/bling/connect` usa para **escrever**. Renomear a
 * chave quebra as duas pontas de uma vez, em vez de silenciar uma delas.
 */

/** Conexão Bling candidata a autenticar um evento, já ligada à sua organização. */
export interface BlingWebhookConnection {
  readonly id: string;
  readonly organizacaoId: string;
}

/** Porta estreita de leitura usada para autenticar o webhook, sem acoplar a rota ao Supabase. */
export interface BlingWebhookTenantStore {
  /** Lista as conexões Bling de todas as organizações, candidatas à conferência de assinatura. */
  readonly listConnections: () => Promise<readonly BlingWebhookConnection[]>;
  /** Devolve o `client_secret` em claro de uma conexão, ou `null` se o cofre não o tiver. */
  readonly getClientSecret: (connection: BlingWebhookConnection) => Promise<string | null>;
}

/** Resultado tipado da resolução da conexão que assinou o evento. */
export type BlingWebhookConnectionResult =
  | { readonly _tag: 'ConnectionResolved'; readonly connection: BlingWebhookConnection }
  | { readonly _tag: 'SignatureUnmatched' }
  | { readonly _tag: 'ConnectionStoreUnavailable'; readonly cause: string };

/** Adapta o Supabase à porta de leitura, buscando o secret sempre pelo cofre. */
export function createSupabaseBlingWebhookTenantStore(
  supabase: SupabaseClient,
): BlingWebhookTenantStore {
  return {
    async listConnections() {
      const { data, error } = await supabase
        .from('conexoes_integracao')
        .select('id, organizacao_id')
        .eq('provedor', 'bling');
      if (error) throw new Error(error.message);
      return (data || [])
        .filter((row): row is { id: string; organizacao_id: string } =>
          typeof row?.id === 'string' && typeof row?.organizacao_id === 'string')
        .map((row) => ({ id: row.id, organizacaoId: row.organizacao_id }));
    },

    async getClientSecret(connection) {
      const raw = await credentialsVault.getDecryptedCredentials(
        connection.organizacaoId,
        connection.id,
        supabase,
      );
      if (!raw) return null;
      const parsed = blingVaultCredentialsSchema.safeParse(raw);
      return parsed.success ? parsed.data.client_secret : null;
    },
  };
}

/**
 * Descobre qual conexão Bling assinou o corpo bruto recebido.
 *
 * A organização vem da própria linha da conexão: não há resolução por
 * `user_id` legado, nem por `membros_organizacao`, nem ramo de ambiguidade —
 * uma conexão pertence a exatamente uma organização, por construção.
 *
 * @param store - Porta de leitura das conexões e dos secrets.
 * @param rawBody - Corpo exatamente como recebido, antes de qualquer parse.
 * @param signature - Conteúdo do header `x-bling-signature-256`.
 * @returns A conexão autenticada, ou a recusa tipada correspondente.
 */
export async function resolveSignedBlingConnection(
  store: BlingWebhookTenantStore,
  rawBody: string,
  signature: string,
): Promise<BlingWebhookConnectionResult> {
  let connections: readonly BlingWebhookConnection[];
  try {
    connections = await store.listConnections();
  } catch (err: unknown) {
    return {
      _tag: 'ConnectionStoreUnavailable',
      cause: err instanceof Error ? err.message : 'falha ao listar conexões Bling',
    };
  }

  const candidates: Array<{ tenantId: string; secret: string; connection: BlingWebhookConnection }> = [];
  for (const connection of connections) {
    let secret: string | null;
    try {
      secret = await store.getClientSecret(connection);
    } catch (err: unknown) {
      // Um cofre que não abre para UMA conexão não pode derrubar as demais,
      // mas também não pode sumir: sem isto, uma chave de cifra trocada vira
      // "assinatura inválida" e a investigação começa do lado errado.
      console.error(
        `❌ Webhook Bling: falha ao ler o secret da conexão ${connection.id} no cofre:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    if (!secret) continue;
    candidates.push({ tenantId: connection.organizacaoId, secret, connection });
  }

  const authorization = authorizeSignedServiceTenant(rawBody, signature, candidates);
  if (authorization._tag !== 'ServiceTenantAuthorized') {
    return { _tag: 'SignatureUnmatched' };
  }

  const authenticated = candidates.find((c) => c.connection.organizacaoId === authorization.tenant.id);
  if (!authenticated) {
    // Inalcançável: o tenant autorizado saiu desta mesma lista. Falha fechado
    // em vez de devolver uma conexão arbitrária.
    return { _tag: 'SignatureUnmatched' };
  }

  return { _tag: 'ConnectionResolved', connection: authenticated.connection };
}
