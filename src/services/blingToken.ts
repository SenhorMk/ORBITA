import { z } from 'zod';

import type { BlingOAuthTokenExchangeResult, BlingRefreshTokenInput } from './blingOAuth';

/**
 * Obtenção e renovação do token OAuth do Bling.
 *
 * Só **orquestração**: o que fazer, em que ordem, e o que conferir entre um
 * passo e outro. Quem fala com o banco, com o cofre e com o OAuth do Bling
 * entra por porta — inclusive na produção, montada em
 * `blingCredenciaisSupabase.ts`. Antes o módulo carregava as três coisas
 * juntas, o que o fazia mudar por três motivos diferentes e deixava um teste
 * sair na rede sem querer.
 *
 * Obter e renovar moram no mesmo tipo porque são a mesma capacidade: obter
 * **já renova** quando o token venceu, e renovar precisa de tudo o que obter
 * precisa. Separá-las obrigava a substituir método por método nos testes.
 */
export interface TokenDoBling {
  /**
   * Token válido para uso imediato, renovando se o atual já venceu.
   *
   * @param signal prazo da operação em curso, conferido **entre** os passos
   *   externos: cada um é ida à rede e pode ter consumido o orçamento sozinho.
   * @throws {ErroDeTokenDoBling} com `motivo` dizendo qual passo falhou.
   */
  obter(signal?: AbortSignal): Promise<string>;

  /**
   * Renovação forçada, mesmo com token ainda dentro da validade.
   *
   * Usada quando o Bling responde 401/403 a um token não vencido — escopo
   * alterado na conta, por exemplo.
   *
   * @throws {ErroDeTokenDoBling}
   */
  renovar(): Promise<string>;
}

/** Qual passo falhou. */
export type MotivoDoErroDeToken =
  | 'sem-conexao'
  | 'armazenamento-falhou'
  | 'credencial-ausente'
  | 'credencial-invalida'
  | 'lock-indisponivel'
  | 'troca-recusada'
  | 'troca-falhou'
  | 'concorrencia-expirada';

/** Frase pública de cada motivo, quando a falha vem de uma porta que rejeitou. */
const MENSAGEM_POR_MOTIVO: Readonly<Record<MotivoDoErroDeToken, string>> = {
  'sem-conexao': 'Bling nao conectado para esta organizacao. Conclua os passos 1 e 2 em Integracoes.',
  'armazenamento-falhou':
    'Não foi possível consultar as credenciais do Bling agora. Tente de novo em alguns instantes.',
  'credencial-ausente': 'Credenciais do Bling incompletas para esta organização.',
  'credencial-invalida':
    'As credenciais do Bling guardadas para esta organização não estão no formato esperado. '
    + 'Reconecte a conta em "Conectar APIs".',
  'lock-indisponivel':
    'Não foi possível coordenar a renovação do token do Bling. Tente de novo em alguns instantes.',
  'troca-recusada': 'O Bling recusou a renovação do token.',
  'troca-falhou': 'Não foi possível falar com o Bling para renovar o token. Tente de novo.',
  'concorrencia-expirada':
    'A renovação do token do Bling por outro processo não terminou a tempo. Tente de novo.',
};

/**
 * Falha da capacidade de token, com o passo identificado.
 *
 * Os caminhos de falha eram `Error` genérica com texto diferente: quem chama
 * não conseguia distinguir "a conta não está conectada" de "o lock do banco
 * falhou" sem comparar mensagem, que é a forma mais frágil possível.
 */
export class ErroDeTokenDoBling extends Error {
  readonly motivo: MotivoDoErroDeToken;

  /**
   * @param motivo qual passo falhou — é por ele que o chamador decide, e não
   *   pela mensagem.
   * @param mensagem frase pública, já sem diagnóstico interno.
   * @param opcoes `cause` guarda a rejeição original da porta, para o log.
   */
  constructor(motivo: MotivoDoErroDeToken, mensagem: string, opcoes?: { cause?: unknown }) {
    super(mensagem, opcoes);
    this.name = 'ErroDeTokenDoBling';
    this.motivo = motivo;
  }
}

/**
 * As credenciais, lidas em vez de afirmadas.
 *
 * O cofre devolve `Record<string, unknown>`, e o código antigo alcançava os
 * campos com `as string` em cada uso: um `access_token` numérico viraria string
 * por decreto.
 *
 * `token_expires_at` exige data **parseável**. Antes, uma string inválida
 * produzia `NaN` na comparação, `agora() >= NaN` dava `false`, e um token com
 * validade ilegível passava por vigente para sempre.
 */
const credenciaisSchema = z.object({
  access_token: z.string().min(1).optional(),
  client_id: z.string().min(1).optional(),
  client_secret: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  // ISO explícito, e **um** parse: o valor já chega como epoch. Antes eram dois
  // — um `refine` com o `Date` permissivo e outro na comparação —, e o
  // permissivo aceita coisas que ninguém quer, como `'2026'`.
  token_expires_at: z.iso
    .datetime({ offset: true })
    .transform((valor) => new Date(valor).getTime())
    .optional(),
});

type Credenciais = z.infer<typeof credenciaisSchema>;

/** Lê o que o cofre devolveu. `null` quando a forma não confere. */
export function lerCredenciais(bruto: unknown): Credenciais | null {
  const lido = credenciaisSchema.safeParse(bruto);
  return lido.success ? lido.data : null;
}

/** Sem data de validade, trata-se como vigente — é o que o código sempre fez. */
function vencido(credenciais: Credenciais, agora: () => number): boolean {
  if (credenciais.token_expires_at === undefined) return false;
  return agora() >= credenciais.token_expires_at;
}

/** O que a busca da conexão encontrou. */
export type ResultadoDaConexao =
  | { readonly _tag: 'Encontrada'; readonly conexaoId: string }
  /** A organização realmente não tem conexão Bling. */
  | { readonly _tag: 'SemConexao' }
  /** A consulta falhou — o banco recusou, caiu, expirou. */
  | { readonly _tag: 'Indisponivel'; readonly causa: unknown };

/** Resultado de disputar o lock de renovação. */
export type ResultadoDoLock =
  | { readonly _tag: 'Adquirido' }
  /** Outro processo está renovando agora. */
  | { readonly _tag: 'Ocupado' }
  /** A tentativa em si falhou — o banco recusou, caiu, expirou. */
  | { readonly _tag: 'Indisponivel'; readonly causa: unknown };

/**
 * Onde a credencial mora, como **uma** fronteira.
 *
 * As cinco operações falam do mesmo registro; separá-las permitiria dublar uma
 * e deixar as outras reais.
 */
export interface ArmazenamentoDeCredenciais {
  readonly acharConexaoId: (organizacaoId: string) => Promise<ResultadoDaConexao>;
  readonly ler: (organizacaoId: string, conexaoId: string) => Promise<unknown>;
  readonly gravar: (
    organizacaoId: string,
    conexaoId: string,
    credenciais: Record<string, unknown>,
  ) => Promise<void>;
  readonly tentarLock: (conexaoId: string) => Promise<ResultadoDoLock>;
  readonly soltarLock: (conexaoId: string) => Promise<void>;
}

/** A troca OAuth propriamente dita, injetada para o teste não sair na rede. */
export type TrocaDeToken = (entrada: BlingRefreshTokenInput) => Promise<BlingOAuthTokenExchangeResult>;

/**
 * Tudo o que a capacidade precisa, sem padrão escondido para o externo.
 *
 * `armazenamento` e `trocarToken` são **obrigatórios** de propósito: um
 * padrão real aqui permitiria montar a capacidade meio dublada e meio ligada
 * à produção sem nada avisar. Só o que é interno — relógio, espera, número de
 * tentativas — tem padrão.
 */
export interface OpcoesDoToken {
  /** Organização dona da conexão; entra em toda leitura e gravação. */
  readonly organizacaoId: string;
  /** Onde a credencial mora. Ver `ArmazenamentoDeCredenciais`. */
  readonly armazenamento: ArmazenamentoDeCredenciais;
  /** A troca OAuth. Injetada para nenhum teste sair na rede sem querer. */
  readonly trocarToken: TrocaDeToken;
  /** Conexão já conhecida, quando o chamador a tem. */
  readonly conexaoId?: string;
  /** Relógio, injetável para as provas de expiração não dependerem do real. */
  readonly agora?: () => number;
  /** Espera entre tentativas enquanto outro processo detém o lock. */
  readonly dormir?: (ms: number) => Promise<void>;
  /** Tentativas de esperar o outro processo publicar o token. */
  readonly tentativasDeEspera?: number;
}

const TENTATIVAS_PADRAO = 15;
const INTERVALO_ENTRE_TENTATIVAS_MS = 2000;

/**
 * A orquestração do token, com todas as dependências externas injetadas.
 *
 * `blingCredenciaisSupabase.ts` monta a composição de produção; os testes
 * montam a deles **por inteiro**, nunca campo a campo.
 *
 * A instância guarda o `conexaoId` depois de resolvê-lo uma vez: dentro de uma
 * mesma organização ele não muda, e repetir a consulta a cada chamada seria
 * uma ida à rede por token entregue.
 *
 * **Toda falha sai como `ErroDeTokenDoBling`** — inclusive rejeição de porta,
 * convertida com a causa original em `cause`. Antes o contrato dizia isso e o
 * código não cumpria: só os caminhos decididos aqui eram tipados.
 */
export class TokenDoBlingOrquestrado implements TokenDoBling {
  private readonly organizacaoId: string;
  private conexaoId?: string;
  private readonly armazenamento: ArmazenamentoDeCredenciais;
  private readonly trocarToken: TrocaDeToken;
  private readonly agora: () => number;
  private readonly dormir: (ms: number) => Promise<void>;
  private readonly tentativasDeEspera: number;

  constructor(opcoes: OpcoesDoToken) {
    this.organizacaoId = opcoes.organizacaoId;
    this.conexaoId = opcoes.conexaoId;
    this.armazenamento = opcoes.armazenamento;
    this.trocarToken = opcoes.trocarToken;
    this.agora = opcoes.agora ?? Date.now;
    this.dormir = opcoes.dormir ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.tentativasDeEspera = opcoes.tentativasDeEspera ?? TENTATIVAS_PADRAO;
  }

  async obter(signal?: AbortSignal): Promise<string> {
    const conexaoId = await this.resolverConexao();

    // A busca da conexão é ida à rede e pode ter estourado o orçamento sozinha.
    // Sem esta conferência, a leitura do cofre — outra ida — começaria já fora
    // do prazo.
    signal?.throwIfAborted();

    const credenciais = await this.lerDoCofre(conexaoId);
    if (!credenciais.access_token) {
      throw new ErroDeTokenDoBling(
        'credencial-ausente',
        'Bling nao conectado para esta organizacao. Conclua os passos 1 e 2 em Integracoes.',
      );
    }

    if (!vencido(credenciais, this.agora)) return credenciais.access_token;

    // Renovar é o passo mais caro e o menos interrompível: disputa lock e pode
    // esperar outro processo. É o último ponto onde dá para evitar o gasto.
    signal?.throwIfAborted();
    return await this.renovar();
  }

  async renovar(): Promise<string> {
    const conexaoId = await this.resolverConexao();
    const lock = await this.chamarPorta('lock-indisponivel', () =>
      this.armazenamento.tentarLock(conexaoId),
    );

    if (lock._tag === 'Indisponivel') {
      // **Falhar ao disputar não é "outro está renovando".** Tratar as duas
      // igual mandava o chamador esperar meio minuto por uma renovação que
      // ninguém estava fazendo.
      throw new ErroDeTokenDoBling(
        'lock-indisponivel',
        'Não foi possível coordenar a renovação do token do Bling. Tente de novo em alguns instantes.',
      );
    }

    if (lock._tag === 'Ocupado') {
      return await this.esperarOutroProcessoRenovar(conexaoId);
    }

    // Solto em sucesso **e** em falha: um lock retido depois de um erro trava a
    // renovação de todo mundo até o timeout do banco.
    //
    // **Qual falha prevalece:** a da operação. Um `finally` com `await` cru
    // deixaria a falha do unlock substituir a da renovação, e o chamador
    // receberia "não consegui soltar o lock" no lugar de "o Bling recusou o
    // token" — a causa raiz sumiria atrás da limpeza.
    try {
      const token = await this.renovarComLock(conexaoId);
      await this.chamarPorta('lock-indisponivel', () => this.armazenamento.soltarLock(conexaoId));
      return token;
    } catch (falhaDaOperacao: unknown) {
      await this.armazenamento.soltarLock(conexaoId).catch(() => {});
      throw falhaDaOperacao;
    }
  }

  private async resolverConexao(): Promise<string> {
    if (this.conexaoId) return this.conexaoId;

    const encontrada = await this.chamarPorta('armazenamento-falhou', () =>
      this.armazenamento.acharConexaoId(this.organizacaoId),
    );

    if (encontrada._tag === 'Indisponivel') {
      // **Falha de infraestrutura não é "sem conexão".** Confundir as duas
      // mandava o lojista reconectar uma conta que já estava conectada, e
      // escondia que o problema era do banco.
      throw new ErroDeTokenDoBling(
        'armazenamento-falhou',
        'Não foi possível consultar a conexão com o Bling agora. Tente de novo em alguns instantes.',
      );
    }

    if (encontrada._tag === 'SemConexao') {
      throw new ErroDeTokenDoBling(
        'sem-conexao',
        'Bling nao conectado para esta organizacao. Conclua os passos 1 e 2 em Integracoes.',
      );
    }

    this.conexaoId = encontrada.conexaoId;
    return this.conexaoId;
  }

  /**
   * Executa uma porta convertendo rejeição em falha tipada.
   *
   * Sem isto o contrato mentia: `ErroDeTokenDoBling` cobria os caminhos que
   * **este** módulo decide, e qualquer rejeição das portas — banco fora, cofre
   * indisponível, rede — atravessava crua para o chamador.
   */
  private async chamarPorta<T>(motivo: MotivoDoErroDeToken, acao: () => Promise<T>): Promise<T> {
    try {
      return await acao();
    } catch (causa: unknown) {
      if (causa instanceof ErroDeTokenDoBling) throw causa;
      throw new ErroDeTokenDoBling(motivo, MENSAGEM_POR_MOTIVO[motivo], { cause: causa });
    }
  }

  private async lerDoCofre(conexaoId: string): Promise<Credenciais> {
    const bruto = await this.chamarPorta('armazenamento-falhou', () =>
      this.armazenamento.ler(this.organizacaoId, conexaoId),
    );

    const credenciais = lerCredenciais(bruto);
    if (!credenciais) {
      throw new ErroDeTokenDoBling(
        'credencial-invalida',
        'As credenciais do Bling guardadas para esta organização não estão no formato esperado. '
          + 'Reconecte a conta em "Conectar APIs".',
      );
    }
    return credenciais;
  }

  /** Outro processo tem o lock: espera ele publicar um token válido. */
  private async esperarOutroProcessoRenovar(conexaoId: string): Promise<string> {
    for (let tentativa = 0; tentativa < this.tentativasDeEspera; tentativa += 1) {
      await this.dormir(INTERVALO_ENTRE_TENTATIVAS_MS);

      const bruto = await this.chamarPorta('armazenamento-falhou', () =>
        this.armazenamento.ler(this.organizacaoId, conexaoId),
      );

      const credenciais = lerCredenciais(bruto);
      if (credenciais?.access_token && !vencido(credenciais, this.agora)) {
        return credenciais.access_token;
      }
    }

    throw new ErroDeTokenDoBling(
      'concorrencia-expirada',
      'A renovação do token do Bling por outro processo não terminou a tempo. Tente de novo.',
    );
  }

  private async renovarComLock(conexaoId: string): Promise<string> {
    const credenciais = await this.lerDoCofre(conexaoId);

    if (!credenciais.client_id || !credenciais.client_secret || !credenciais.refresh_token) {
      throw new ErroDeTokenDoBling(
        'credencial-ausente',
        'Credenciais Bling incompletas no cofre da organizacao.',
      );
    }

    const renovado = await this.chamarPorta('troca-falhou', () =>
      this.trocarToken({
        clientId: credenciais.client_id!,
        clientSecret: credenciais.client_secret!,
        refreshToken: credenciais.refresh_token!,
      }),
    );

    if (renovado._tag === 'BlingOAuthTokenExchangeFailed') {
      throw new ErroDeTokenDoBling(
        'troca-recusada',
        `O Bling recusou a renovação do token (${renovado.reason}).`,
      );
    }

    await this.chamarPorta('armazenamento-falhou', () =>
      this.armazenamento.gravar(this.organizacaoId, conexaoId, {
      client_id: credenciais.client_id,
      client_secret: credenciais.client_secret,
      access_token: renovado.access_token,
      // O Bling **rotaciona** o refresh token: guardar o antigo faz a próxima
      // renovação falhar com `invalid_grant`, e a conta cai sozinha.
      refresh_token: renovado.refresh_token,
      token_expires_at: new Date(this.agora() + renovado.expires_in * 1000).toISOString(),
      }),
    );

    return renovado.access_token;
  }
}
