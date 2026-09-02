import { z } from 'zod';

import { credentialsVault } from '../lib/integrations/credentialsVault';
import { supabaseServer } from '../lib/supabaseServer';

import { refreshBlingToken } from './blingOAuth';

/**
 * Obtenção e renovação do token OAuth do Bling, como **uma** capacidade.
 *
 * As duas coisas eram passos separados espalhados pelo cliente, e a separação
 * era artificial: obter já renova quando o token venceu, e renovar precisa de
 * tudo o que obter precisa — conexão, cofre, lock. Testar uma sem a outra
 * obrigava a substituir método por método, e foi assim que uma prova acabou
 * desviando exatamente da linha que estava em questão.
 *
 * Juntas num tipo, elas viram uma fronteira só — a mesma que a construção
 * normal usa e a que os testes trocam. A porta não existe para o teste; ela
 * existe porque este é o limite entre falar com o Bling e descobrir com que
 * credencial falar.
 */
export interface TokenDoBling {
  /**
   * Token válido para uso imediato, renovando se o atual já venceu.
   *
   * @param signal prazo da operação em curso. É conferido **entre** os passos
   *   externos — busca da conexão, leitura do cofre, renovação —, porque cada
   *   um deles é uma ida à rede e pode ter consumido o orçamento sozinho.
   * @throws quando não há conexão, não há credencial, ou o prazo estourou.
   */
  obter(signal?: AbortSignal): Promise<string>;

  /**
   * Renovação forçada, independente da validade do token atual.
   *
   * Usada quando o Bling responde 401/403 mesmo com um token que ainda não
   * venceu — escopo alterado na conta, por exemplo.
   */
  renovar(): Promise<string>;
}

/**
 * As credenciais, lidas em vez de afirmadas.
 *
 * O cofre devolve `Record<string, unknown>`, e o código antigo alcançava os
 * campos com `as string` em cada uso. Um `as` aqui é a mesma classe de erro que
 * esta série vem perseguindo: afirmar forma sem conferir.
 */
const credenciaisSchema = z.object({
  access_token: z.string().min(1).optional(),
  client_id: z.string().min(1).optional(),
  client_secret: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  token_expires_at: z.string().min(1).optional(),
});

export type CredenciaisDoBling = z.infer<typeof credenciaisSchema>;

/** Lê o que o cofre devolveu, descartando o que não serve. */
export function lerCredenciais(bruto: unknown): CredenciaisDoBling | null {
  const lido = credenciaisSchema.safeParse(bruto);
  return lido.success ? lido.data : null;
}

/** O token venceu? Sem data, trata-se como válido — é o que o código sempre fez. */
function vencido(credenciais: CredenciaisDoBling, agora: () => number): boolean {
  if (!credenciais.token_expires_at) return false;
  return agora() >= new Date(credenciais.token_expires_at).getTime();
}

/**
 * Onde a credencial mora, como **uma** fronteira.
 *
 * Conexão, leitura e escrita andam juntas: as três falam do mesmo registro, e
 * separá-las permitiria dublar uma e deixar as outras reais — que é exatamente
 * o que a revisão apontou como perigoso na versão anterior das portas.
 */
export interface ArmazenamentoDeCredenciais {
  readonly acharConexaoId: (organizacaoId: string) => Promise<string | null>;
  readonly ler: (organizacaoId: string, conexaoId: string) => Promise<unknown>;
  readonly gravar: (
    organizacaoId: string,
    conexaoId: string,
    credenciais: Record<string, unknown>,
  ) => Promise<unknown>;
  /** `true` quando este processo ficou com o lock da renovação. */
  readonly tentarLock: (conexaoId: string) => Promise<boolean>;
  readonly soltarLock: (conexaoId: string) => Promise<unknown>;
}

/** O armazenamento de produção — trocado **por inteiro**, nunca campo a campo. */
export const ARMAZENAMENTO_SUPABASE: ArmazenamentoDeCredenciais = {
  acharConexaoId: async (organizacaoId) => {
    const { data } = await supabaseServer
      .from('conexoes_integracao')
      .select('id')
      .eq('organizacao_id', organizacaoId)
      .eq('provedor', 'bling')
      .maybeSingle();
    return data?.id ?? null;
  },
  ler: (organizacaoId, conexaoId) => credentialsVault.getDecryptedCredentials(organizacaoId, conexaoId),
  gravar: (organizacaoId, conexaoId, credenciais) =>
    credentialsVault.saveEncryptedCredentials(organizacaoId, conexaoId, credenciais),
  tentarLock: async (conexaoId) => {
    const { data, error } = await supabaseServer.rpc('acquire_conexao_token_lock', {
      p_conexao_id: conexaoId,
      p_timeout_seconds: 30,
    });
    if (error) console.error('Erro ao adquirir lock de conexao Bling:', error);
    return Boolean(data);
  },
  soltarLock: async (conexaoId) => {
    await supabaseServer.rpc('release_conexao_token_lock', { p_conexao_id: conexaoId });
  },
};

export interface OpcoesDoToken {
  readonly organizacaoId: string;
  readonly conexaoId?: string;
  readonly agora?: () => number;
  /** Espera entre tentativas, quando outro processo tem o lock. */
  readonly dormir?: (ms: number) => Promise<void>;
  readonly armazenamento?: ArmazenamentoDeCredenciais;
}

/**
 * Implementação real: conexão pelo Supabase, credencial pelo cofre por
 * organização, renovação com lock.
 *
 * O caminho por `user_id` sobre `integracoes_bling` foi removido no Ticket 10b:
 * `service_role` não tem privilégio nenhum naquela tabela, então toda chamada
 * interativa falhava com `42501 permission denied` antes de chegar ao provedor.
 */
export class TokenDoBlingSupabase implements TokenDoBling {
  private readonly organizacaoId: string;
  private conexaoId?: string;
  private readonly agora: () => number;
  private readonly dormir: (ms: number) => Promise<void>;
  private readonly armazenamento: ArmazenamentoDeCredenciais;

  constructor(opcoes: OpcoesDoToken) {
    this.organizacaoId = opcoes.organizacaoId;
    this.conexaoId = opcoes.conexaoId;
    this.agora = opcoes.agora ?? Date.now;
    this.dormir = opcoes.dormir ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.armazenamento = opcoes.armazenamento ?? ARMAZENAMENTO_SUPABASE;
  }

  async obter(signal?: AbortSignal): Promise<string> {
    const conexaoId = await this.resolverConexao();

    // A busca da conexão também é ida à rede, e pode ter estourado o orçamento
    // sozinha. Sem esta conferência, a leitura do cofre — outra ida — começaria
    // já fora do prazo.
    signal?.throwIfAborted();

    const credenciais = lerCredenciais(await this.armazenamento.ler(this.organizacaoId, conexaoId));
    if (!credenciais?.access_token) {
      throw new Error('Bling nao conectado para esta organizacao. Conclua os passos 1 e 2 em Integracoes.');
    }

    if (vencido(credenciais, this.agora)) {
      // Renovar é o passo mais caro e o menos interrompível: faz *polling* de
      // lock com `await` de banco. Começar um já fora do prazo é o pior gasto
      // possível, e é o último ponto onde dá para evitar.
      signal?.throwIfAborted();
      return await this.renovar();
    }

    return credenciais.access_token;
  }

  async renovar(): Promise<string> {
    const conexaoId = await this.resolverConexao();

    const lockAdquirido = await this.armazenamento.tentarLock(conexaoId);

    if (!lockAdquirido) {
      return await this.esperarOutroProcessoRenovar(conexaoId);
    }

    try {
      return await this.renovarComLock(conexaoId);
    } finally {
      await this.armazenamento.soltarLock(conexaoId);
    }
  }

  private async resolverConexao(): Promise<string> {
    if (!this.conexaoId) {
      this.conexaoId = (await this.armazenamento.acharConexaoId(this.organizacaoId)) ?? undefined;
    }

    if (!this.conexaoId) {
      throw new Error('Bling nao conectado para esta organizacao. Conclua os passos 1 e 2 em Integracoes.');
    }

    return this.conexaoId;
  }

  /** Outro processo tem o lock: espera ele publicar um token válido. */
  private async esperarOutroProcessoRenovar(conexaoId: string): Promise<string> {
    for (let tentativa = 0; tentativa < 15; tentativa += 1) {
      await this.dormir(2000);

      const credenciais = lerCredenciais(await this.armazenamento.ler(this.organizacaoId, conexaoId));
      if (credenciais?.access_token && !vencido(credenciais, this.agora)) {
        return credenciais.access_token;
      }
    }

    throw new Error('Timeout esperando outro processo renovar token Bling da organizacao.');
  }

  private async renovarComLock(conexaoId: string): Promise<string> {
    const credenciais = lerCredenciais(await this.armazenamento.ler(this.organizacaoId, conexaoId));

    if (!credenciais?.client_id || !credenciais.client_secret || !credenciais.refresh_token) {
      throw new Error('Credenciais Bling incompletas no cofre da organizacao.');
    }

    const renovado = await refreshBlingToken({
      clientId: credenciais.client_id,
      clientSecret: credenciais.client_secret,
      refreshToken: credenciais.refresh_token,
    });

    if (renovado._tag === 'BlingOAuthTokenExchangeFailed') {
      throw new Error(`Falha ao renovar token Bling: ${renovado.reason}`);
    }

    await this.armazenamento.gravar(this.organizacaoId, conexaoId, {
      client_id: credenciais.client_id,
      client_secret: credenciais.client_secret,
      access_token: renovado.access_token,
      refresh_token: renovado.refresh_token,
      token_expires_at: new Date(this.agora() + renovado.expires_in * 1000).toISOString(),
    });

    return renovado.access_token;
  }
}
