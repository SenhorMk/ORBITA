import { credentialsVault } from '../lib/integrations/credentialsVault';
import { registrarFalhaInterna } from '../lib/observability/falhaInterna';
import { supabaseServer } from '../lib/supabaseServer';

import { refreshBlingToken } from './blingOAuth';
import {
  TokenDoBlingOrquestrado,
  type ArmazenamentoDeCredenciais,
  type TokenDoBling,
} from './blingToken';
import {
  erroRegistravel,
  lerResultadoDaConexao,
  lerResultadoDoLock,
} from './blingCredenciaisContrato';

/**
 * A composição de **produção** da capacidade de token.
 *
 * Mora separada da orquestração porque muda por outro motivo: aqui é Supabase,
 * cofre e OAuth concretos; lá é a ordem dos passos. Juntos, o módulo mudava por
 * três razões diferentes — e um teste da orquestração acabou saindo na rede,
 * porque o OAuth vinha por import direto.
 *
 * A **tradução** de `{ data, error }` para os tipos do domínio mora em
 * `blingCredenciaisContrato.ts`, que não depende de infraestrutura e por isso
 * pode ser provado direto.
 */

const ARMAZENAMENTO_SUPABASE: ArmazenamentoDeCredenciais = {
  acharConexaoId: async (organizacaoId) => {
    const resposta = await supabaseServer
      .from('conexoes_integracao')
      .select('id')
      .eq('organizacao_id', organizacaoId)
      .eq('provedor', 'bling')
      .maybeSingle();

    const resultado = lerResultadoDaConexao(resposta);
    if (resultado._tag === 'Indisponivel') {
      // **Falha de infraestrutura não é "sem conexão".** O `error` era
      // descartado, e o `null` resultante virava "conclua os passos 1 e 2 em
      // Integrações" — mandando o lojista reconectar uma conta que já estava
      // conectada, enquanto o problema real era do banco.
      registrarFalhaInterna('bling.token.achar-conexao', erroRegistravel(resposta.error));
    }
    return resultado;
  },

  ler: (organizacaoId, conexaoId) => credentialsVault.getDecryptedCredentials(organizacaoId, conexaoId),

  gravar: async (organizacaoId, conexaoId, credenciais) => {
    // `saveEncryptedCredentials` lança quando o upsert falha, então uma
    // gravação recusada vira rejeição — e não um sucesso silencioso com o
    // refresh token novo perdido.
    await credentialsVault.saveEncryptedCredentials(organizacaoId, conexaoId, credenciais);
  },

  tentarLock: async (conexaoId) => {
    const resposta = await supabaseServer.rpc('acquire_conexao_token_lock', {
      p_conexao_id: conexaoId,
      p_timeout_seconds: 30,
    });

    const resultado = lerResultadoDoLock(resposta);
    if (resultado._tag === 'Indisponivel') {
      registrarFalhaInterna('bling.token.lock', erroRegistravel(resposta.error));
    }
    return resultado;
  },

  soltarLock: async (conexaoId) => {
    const { error } = await supabaseServer.rpc('release_conexao_token_lock', { p_conexao_id: conexaoId });

    if (error) {
      // Um unlock recusado deixa a renovação de todo mundo travada até o
      // timeout do banco. O erro era descartado em silêncio: ninguém ficava
      // sabendo, e o sintoma aparecia depois como lentidão sem causa.
      registrarFalhaInterna('bling.token.soltar-lock', erroRegistravel(error));
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
