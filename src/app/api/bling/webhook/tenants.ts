import type { SupabaseClient } from '@supabase/supabase-js';

import { authorizeSignedServiceTenant } from '../../../../lib/auth';
import { descreverErro } from '../../../../lib/erroLegivel';
import { blingVaultCredentialsSchema } from '../../../../lib/config/blingCredentialsContract';
import { credentialsVault } from '../../../../lib/integrations/credentialsVault';

/**
 * Resolução do tenant do webhook do Bling a partir do cofre de credenciais.
 *
 * O secret que assina os eventos é o `client_secret` do aplicativo, guardado
 * cifrado no cofre por conexão (`conexoes_integracao` +
 * `credenciais_integracao`). A tabela legada `integracoes_bling` não é lida.
 *
 * A leitura passa por `blingVaultCredentialsSchema`, o mesmo schema que
 * `POST /api/bling/connect` usa para **escrever**: renomear uma chave quebra as
 * duas pontas de uma vez, em vez de silenciar uma delas.
 *
 * Para autenticar, as conexões Bling de todas as organizações são candidatas;
 * a primeira cujo secret confere o HMAC define a organização
 * (`authorizeSignedServiceTenant`).
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
  /**
   * Nenhuma conexão casou com a assinatura **e** pelo menos uma não pôde ser
   * conferida — o cofre não respondeu para ela. Não é a mesma coisa que
   * assinatura forjada: aqui não sabemos, e dizer "inválida" transformaria uma
   * falha transitória em recusa definitiva do evento.
   */
  | { readonly _tag: 'SignatureUnconfirmable'; readonly cause: string; readonly conexoesAfetadas: readonly string[] }
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
 * A organização vem da própria linha da conexão, que tem um único
 * `organizacao_id`: não há resolução por usuário nem por `membros_organizacao`.
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
  const naoConferidas: Array<{ conexaoId: string; causa: string }> = [];

  for (const connection of connections) {
    let secret: string | null;
    try {
      secret = await store.getClientSecret(connection);
    } catch (err: unknown) {
      // A falha de UMA conexão não derruba as demais: o laço continua, e uma
      // organização saudável ainda autentica normalmente. Mas ela também não
      // some — fica registrada para o caso de nenhuma casar, porque aí a
      // resposta não pode ser "assinatura inválida".
      const causa = descreverErro(err);
      console.error(`❌ Webhook Bling: falha ao ler o secret da conexão ${connection.id} no cofre:`, causa);
      naoConferidas.push({ conexaoId: connection.id, causa });
      continue;
    }
    if (!secret) continue;
    candidates.push({ tenantId: connection.organizacaoId, secret, connection });
  }

  const authorization = authorizeSignedServiceTenant(rawBody, signature, candidates);

  if (authorization._tag !== 'ServiceTenantAuthorized') {
    if (naoConferidas.length > 0) {
      return {
        _tag: 'SignatureUnconfirmable',
        cause: naoConferidas.map((f) => `${f.conexaoId}: ${f.causa}`).join('; '),
        conexoesAfetadas: naoConferidas.map((f) => f.conexaoId),
      };
    }
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
