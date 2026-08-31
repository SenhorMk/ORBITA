import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { encrypt, decrypt } from '../crypto';

export const integrationProviderSchema = z.enum(['bling', 'chatwoot', 'stripe', 'custom']);
export type IntegrationProvider = z.infer<typeof integrationProviderSchema>;

export const connectionStatusSchema = z.enum(['pendente', 'conectado', 'erro', 'desconectado']);
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

export const createConnectionInputSchema = z.object({
  organizacao_id: z.string().uuid(),
  provedor: integrationProviderSchema,
  nome: z.string().min(1).default('Principal'),
  status: connectionStatusSchema.default('pendente'),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CreateConnectionInput = z.infer<typeof createConnectionInputSchema>;

import { redactSensitiveData } from '../dadosSensiveis';

/** Reexportado para os chamadores que já conheciam este módulo como origem. */
export { redactSensitiveData };

export class CredentialsVault {
  private async getClient(explicitClient?: SupabaseClient): Promise<SupabaseClient> {
    if (explicitClient) {
      return explicitClient;
    }
    const { supabaseServer } = await import('../supabaseServer');
    return supabaseServer;
  }

  /**
   * Encrypts and stores credentials in private storage with versioned encryption.
   */
  async saveEncryptedCredentials(
    orgId: string,
    conexaoId: string,
    rawCredentials: Record<string, unknown>,
    chaveVersao = 'v1',
    client?: SupabaseClient
  ): Promise<void> {
    if (!orgId || !conexaoId) {
      throw new Error('organizacao_id e conexao_id são obrigatórios para salvar credenciais.');
    }

    const plaintext = JSON.stringify(rawCredentials);
    const dadosCifrados = encrypt(plaintext);

    if (!dadosCifrados) {
      throw new Error('Falha ao cifrar credenciais de integração.');
    }

    const dbClient = await this.getClient(client);
    const { error } = await dbClient
      .from('credenciais_integracao')
      .upsert(
        {
          conexao_id: conexaoId,
          organizacao_id: orgId,
          chave_versao: chaveVersao,
          dados_cifrados: dadosCifrados,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'conexao_id' }
      );

    if (error) {
      console.error('Erro ao persistir credenciais cifradas:', redactSensitiveData(error));
      throw new Error(error.message);
    }
  }

  /**
   * Retrieves and decrypts raw credentials strictly scoped by organization and connection.
   * Only server-side adapters should call this method.
   */
  async getDecryptedCredentials(
    orgId: string,
    conexaoId: string,
    client?: SupabaseClient
  ): Promise<Record<string, unknown> | null> {
    if (!orgId || !conexaoId) {
      return null;
    }

    const dbClient = await this.getClient(client);
    const { data, error } = await dbClient
      .from('credenciais_integracao')
      .select('dados_cifrados, chave_versao')
      .eq('organizacao_id', orgId)
      .eq('conexao_id', conexaoId)
      .maybeSingle();

    if (error) {
      console.error('Erro ao consultar credenciais cifradas:', redactSensitiveData(error));
      throw new Error(error.message);
    }

    if (!data?.dados_cifrados) {
      return null;
    }

    const decryptedJson = decrypt(data.dados_cifrados);
    if (!decryptedJson) {
      console.error('Falha na decifração ou integridade das credenciais de integração.');
      return null;
    }

    try {
      return JSON.parse(decryptedJson) as Record<string, unknown>;
    } catch {
      console.error('Erro ao deserializar JSON das credenciais decifradas.');
      return null;
    }
  }

  /**
   * Removes credentials from private storage.
   */
  async deleteCredentials(orgId: string, conexaoId: string, client?: SupabaseClient): Promise<void> {
    const dbClient = await this.getClient(client);
    const { error } = await dbClient
      .from('credenciais_integracao')
      .delete()
      .eq('organizacao_id', orgId)
      .eq('conexao_id', conexaoId);

    if (error) {
      console.error('Erro ao remover credenciais cifradas:', redactSensitiveData(error));
      throw new Error(error.message);
    }
  }
}

export const credentialsVault = new CredentialsVault();
