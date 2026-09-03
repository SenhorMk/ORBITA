import { credentialsVault } from '../lib/integrations/credentialsVault';
import { registrarFalhaInterna } from '../lib/observability/falhaInterna';
import { supabaseServer } from '../lib/supabaseServer';

import { refreshBlingToken } from './blingOAuth';
import {
  TokenDoBlingOrquestrado,
  type ArmazenamentoDeCredenciais,
  type ResultadoDaConexao,
  type ResultadoDoLock,
  type TokenDoBling,
} from './blingToken';

/**
 * A composição de **produção** da capacidade de token.
 *
 * Mora separada da orquestração porque muda por outro motivo: aqui é Supabase,
 * cofre e OAuth concretos; lá é a ordem dos passos. Juntos, o módulo mudava por
 * três razões diferentes — e um teste da orquestração acabou saindo na rede,
 * porque o OAuth vinha por import direto.
 */
const ARMAZENAMENTO_SUPABASE: ArmazenamentoDeCredenciais = {
  acharConexaoId: async (organizacaoId): Promise<ResultadoDaConexao> => {
    const { data, error } = await supabaseServer
      .from('conexoes_integracao')
      .select('id')
      .eq('organizacao_id', organizacaoId)
      .eq('provedor', 'bling')
      .maybeSingle();

    if (error) {
      // **Falha de infraestrutura não é "sem conexão".** O `error` era
      // descartado, e o `null` resultante virava "conclua os passos 1 e 2 em
      // Integrações" — mandando o lojista reconectar uma conta que já estava
      // conectada, enquanto o problema real era do banco.
      registrarFalhaInterna('bling.token.achar-conexao', error);
      return { _tag: 'Indisponivel', causa: error };
    }

    return data?.id ? { _tag: 'Encontrada', conexaoId: data.id } : { _tag: 'SemConexao' };
  },

  ler: (organizacaoId, conexaoId) => credentialsVault.getDecryptedCredentials(organizacaoId, conexaoId),

  gravar: async (organizacaoId, conexaoId, credenciais) => {
    await credentialsVault.saveEncryptedCredentials(organizacaoId, conexaoId, credenciais);
  },

  tentarLock: async (conexaoId): Promise<ResultadoDoLock> => {
    const { data, error } = await supabaseServer.rpc('acquire_conexao_token_lock', {
      p_conexao_id: conexaoId,
      p_timeout_seconds: 30,
    });

    if (error) {
      // O erro **não** é impresso cru: um erro do Postgres carrega `details` e
      // `hint`, que trazem valor de linha (CWE-209, a política do ticket 22).
      // E ele deixou de virar "outro processo está renovando": falhar ao
      // disputar o lock é outra coisa, e o chamador precisa distinguir.
      registrarFalhaInterna('bling.token.lock', error);
      return { _tag: 'Indisponivel', causa: error };
    }

    return data ? { _tag: 'Adquirido' } : { _tag: 'Ocupado' };
  },

  soltarLock: async (conexaoId) => {
    const { error } = await supabaseServer.rpc('release_conexao_token_lock', { p_conexao_id: conexaoId });

    if (error) {
      // Um unlock recusado deixa a renovação de todo mundo travada até o
      // timeout do banco. O erro era descartado em silêncio: ninguém ficava
      // sabendo, e o sintoma aparecia depois como lentidão sem causa.
      registrarFalhaInterna('bling.token.soltar-lock', error);
      throw new Error('Falha ao liberar o lock de renovação do token do Bling.');
    }
  },
};

/** A capacidade de token que a produção usa, montada por inteiro. */
export function tokenDoBlingReal(organizacaoId: string, conexaoId?: string): TokenDoBling {
  return new TokenDoBlingOrquestrado({
    organizacaoId,
    conexaoId,
    armazenamento: ARMAZENAMENTO_SUPABASE,
    trocarToken: (entrada) => refreshBlingToken(entrada),
  });
}
