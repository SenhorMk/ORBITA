import { z } from 'zod';

import type { BlingOAuthTokenExchangeResult, BlingRefreshTokenInput } from './blingOAuth';

/**
 * Obtenção e renovação do token OAuth do Bling.
 *
 * Só **orquestração**: o que fazer, em que ordem, e o que conferir entre um
 * passo e outro. Quem fala com o banco, com o cofre e com o OAuth do Bling
 * entra por porta — inclusive na produção, montada em
 * `blingCredenciaisSupabase.ts`.
 *
 * Obter e renovar moram no mesmo tipo porque são a mesma capacidade: obter
 * **já renova** quando o token venceu, e renovar precisa de tudo o que obter
 * precisa.
 *
 * **A falha é valor, não exceção.** É a convenção das fronteiras revisadas
 * deste repositório (`BlingCallResult`, `BlingOAuthTokenExchangeResult`), e
 * aqui ela resolve um problema concreto: enquanto a falha era exceção, o
 * contrato "toda falha é tipada" ficava sempre maior que o código — bastava uma
 * porta rejeitar, um `AbortSignal` disparar ou um `dormir` quebrar para algo
 * cru atravessar. Com união, o compilador cobra o tratamento.
 */
export interface TokenDoBling {
  /**
   * Token válido para uso imediato, renovando se o atual já venceu.
   *
   * @param signal prazo da operação em curso, conferido **entre** os passos
   *   externos: cada um é ida à rede e pode ter consumido o orçamento sozinho.
   */
  obter(signal?: AbortSignal): Promise<ResultadoDoToken>;

  /**
   * Renovação forçada, mesmo com token ainda dentro da validade.
   *
   * Usada quando o Bling responde 401/403 a um token não vencido — escopo
   * alterado na conta, por exemplo.
   */
  renovar(): Promise<ResultadoDoToken>;
}

/** Qual passo falhou. É por aqui que o chamador decide, nunca pela mensagem. */
export type MotivoDaFalhaDeToken =
  | 'sem-conexao'
  | 'armazenamento-falhou'
  | 'credencial-ausente'
  | 'credencial-invalida'
  | 'lock-indisponivel'
  | 'troca-recusada'
  | 'troca-falhou'
  | 'concorrencia-expirada'
  | 'prazo-esgotado';

/**
 * Falha da capacidade de token.
 *
 * `mensagem` é pública e escrita aqui; `causa` é **só diagnóstico** e nunca vai
 * para resposta nenhuma — é onde a rejeição original da porta fica guardada,
 * inclusive quando ela carrega texto livre do provedor.
 */
export interface FalhaDeToken {
  readonly motivo: MotivoDaFalhaDeToken;
  readonly mensagem: string;
  readonly causa?: unknown;
}

export type ResultadoDoToken =
  | { readonly _tag: 'TokenObtido'; readonly token: string }
  | { readonly _tag: 'TokenFalhou'; readonly falha: FalhaDeToken };

/** Frase pública de cada motivo. Vocabulário fechado, escrito aqui. */
const MENSAGEM_POR_MOTIVO: Readonly<Record<MotivoDaFalhaDeToken, string>> = {
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
  'prazo-esgotado': 'A leitura das credenciais do Bling não terminou dentro do tempo previsto.',
};

function falhar(motivo: MotivoDaFalhaDeToken, causa?: unknown): ResultadoDoToken {
  return { _tag: 'TokenFalhou', falha: { motivo, mensagem: MENSAGEM_POR_MOTIVO[motivo], causa } };
}

/**
 * As credenciais, lidas em vez de afirmadas.
 *
 * O cofre devolve `Record<string, unknown>`, e o código antigo alcançava os
 * campos com `as string` em cada uso: um `access_token` numérico viraria string
 * por decreto.
 *
 * `token_expires_at` é ISO **explícito** e transformado uma única vez em epoch.
 * Antes eram dois parses — um `refine` com o `Date` permissivo e outro na
 * comparação —, e o permissivo aceita coisas como `'2026'`.
 */
const credenciaisSchema = z.object({
  access_token: z.string().min(1).optional(),
  client_id: z.string().min(1).optional(),
  client_secret: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  token_expires_at: z.iso
    .datetime({ offset: true })
    .transform((valor) => new Date(valor).getTime())
    .optional(),
});

type Credenciais = z.infer<typeof credenciaisSchema>;

/** Credenciais com os três campos que a renovação exige. */
type CredenciaisParaRenovar = Credenciais & {
  client_id: string;
  client_secret: string;
  refresh_token: string;
};

/** Estreita em vez de afirmar com `!` nos três campos. */
function completasParaRenovar(credenciais: Credenciais): credenciais is CredenciaisParaRenovar {
  return Boolean(credenciais.client_id && credenciais.client_secret && credenciais.refresh_token);
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
  /** Libera o lock. **Chamado no máximo uma vez** por renovação — ver `renovar`. */
  readonly soltarLock: (conexaoId: string) => Promise<void>;
}

/** A troca OAuth propriamente dita, injetada para o teste não sair na rede. */
export type TrocaDeToken = (entrada: BlingRefreshTokenInput) => Promise<BlingOAuthTokenExchangeResult>;

/**
 * Tudo o que a capacidade precisa, sem padrão escondido para o externo.
 *
 * `armazenamento` e `trocarToken` são **obrigatórios** de propósito: um padrão
 * real aqui permitiria montar a capacidade meio dublada e meio ligada à
 * produção sem nada avisar. Só o que é interno — relógio, espera, número de
 * tentativas — tem padrão.
 */
export interface OpcoesDoToken {
  /** Organização dona da conexão; entra em toda leitura e gravação. */
  readonly organizacaoId: string;
  /** Onde a credencial mora. */
  readonly armazenamento: ArmazenamentoDeCredenciais;
  /** A troca OAuth. Injetada para nenhum teste sair na rede sem querer. */
  readonly trocarToken: TrocaDeToken;
  /** Conexão já conhecida, quando o chamador a tem. */
  readonly conexaoId?: string;
  /** Relógio, para as provas de expiração não dependerem do real. */
  readonly agora?: () => number;
  /** Espera entre tentativas enquanto outro processo detém o lock. */
  readonly dormir?: (ms: number) => Promise<void>;
  /** Tentativas de esperar o outro processo publicar o token. */
  readonly tentativasDeEspera?: number;
}

const TENTATIVAS_PADRAO = 15;
const INTERVALO_ENTRE_TENTATIVAS_MS = 2000;

/** Resultado interno de um passo que pode falhar. */
type Passo<T> =
  | { readonly ok: true; readonly valor: T }
  | { readonly ok: false; readonly falha: ResultadoDoToken };

/**
 * A orquestração do token, com todas as dependências externas injetadas.
 *
 * `blingCredenciaisSupabase.ts` monta a composição de produção; os testes
 * montam a deles **por inteiro**, nunca campo a campo.
 *
 * A instância guarda o `conexaoId` depois de resolvê-lo: dentro de uma mesma
 * organização ele não muda, e repetir a consulta seria uma ida à rede por token
 * entregue.
 */
export class TokenDoBlingOrquestrado implements TokenDoBling {
  private readonly organizacaoId: string;
  private conexaoId?: string;
  private readonly armazenamento: ArmazenamentoDeCredenciais;
  private readonly trocarToken: TrocaDeToken;
  private readonly agora: () => number;
  private readonly dormir: (ms: number) => Promise<void>;
  private readonly tentativasDeEspera: number;

  /** @param opcoes ver `OpcoesDoToken`; as dependências externas não têm padrão. */
  constructor(opcoes: OpcoesDoToken) {
    this.organizacaoId = opcoes.organizacaoId;
    this.conexaoId = opcoes.conexaoId;
    this.armazenamento = opcoes.armazenamento;
    this.trocarToken = opcoes.trocarToken;
    this.agora = opcoes.agora ?? Date.now;
    this.dormir = opcoes.dormir ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.tentativasDeEspera = opcoes.tentativasDeEspera ?? TENTATIVAS_PADRAO;
  }

  /** @inheritdoc */
  async obter(signal?: AbortSignal): Promise<ResultadoDoToken> {
    const conexao = await this.resolverConexao();
    if (!conexao.ok) return conexao.falha;

    // A busca da conexão é ida à rede e pode ter estourado o orçamento sozinha.
    // Sem esta conferência, a leitura do cofre — outra ida — começaria já fora
    // do prazo. O motivo do aborto entra como **causa**, não como mensagem.
    if (signal?.aborted) return falhar('prazo-esgotado', signal.reason);

    const lidas = await this.lerDoCofre(conexao.valor);
    if (!lidas.ok) return lidas.falha;

    const credenciais = lidas.valor;
    if (!credenciais.access_token) return falhar('credencial-ausente');

    if (!vencido(credenciais, this.agora)) {
      return { _tag: 'TokenObtido', token: credenciais.access_token };
    }

    // Renovar é o passo mais caro e o menos interrompível: disputa lock e pode
    // esperar outro processo. É o último ponto onde dá para evitar o gasto.
    if (signal?.aborted) return falhar('prazo-esgotado', signal.reason);

    return await this.renovar();
  }

  /** @inheritdoc */
  async renovar(): Promise<ResultadoDoToken> {
    const conexao = await this.resolverConexao();
    if (!conexao.ok) return conexao.falha;
    const conexaoId = conexao.valor;

    const lock = await this.executar(() => this.armazenamento.tentarLock(conexaoId), 'lock-indisponivel');
    if (!lock.ok) return lock.falha;

    if (lock.valor._tag === 'Indisponivel') {
      // **Falhar ao disputar não é "outro está renovando".** Tratar as duas
      // igual mandava o chamador esperar meio minuto por uma renovação que
      // ninguém estava fazendo.
      return falhar('lock-indisponivel', lock.valor.causa);
    }

    if (lock.valor._tag === 'Ocupado') {
      // O lock é do outro processo: não há nada para liberar aqui.
      return await this.esperarOutroProcessoRenovar(conexaoId);
    }

    // **Operação e limpeza separadas, com no máximo uma liberação.**
    //
    // A versão anterior liberava dentro do `try` e de novo no `catch`: quando a
    // primeira liberação falhava depois de uma renovação bem-sucedida, o
    // `soltarLock` rodava **duas vezes**. Como o RPC libera só por
    // `conexao_id`, uma repetição depois de um resultado de rede ambíguo pode
    // apagar o lock que outro processo já tinha adquirido.
    const renovacao = await this.renovarComLock(conexaoId);
    const liberacao = await this.executar(() => this.armazenamento.soltarLock(conexaoId), 'lock-indisponivel');

    // A falha da operação prevalece: ela é a causa raiz, e a limpeza é
    // consequência. No caminho feliz não há causa a preservar, e aí um unlock
    // recusado precisa aparecer — ele trava a renovação de todo mundo.
    if (renovacao._tag === 'TokenFalhou') return renovacao;
    if (!liberacao.ok) return liberacao.falha;
    return renovacao;
  }

  private async resolverConexao(): Promise<Passo<string>> {
    if (this.conexaoId) return { ok: true, valor: this.conexaoId };

    const encontrada = await this.executar(
      () => this.armazenamento.acharConexaoId(this.organizacaoId),
      'armazenamento-falhou',
    );
    if (!encontrada.ok) return encontrada;

    if (encontrada.valor._tag === 'Indisponivel') {
      // **Falha de infraestrutura não é "sem conexão".** Confundir as duas
      // mandava o lojista reconectar uma conta que já estava conectada, e
      // escondia que o problema era do banco.
      return { ok: false, falha: falhar('armazenamento-falhou', encontrada.valor.causa) };
    }

    if (encontrada.valor._tag === 'SemConexao') {
      return { ok: false, falha: falhar('sem-conexao') };
    }

    this.conexaoId = encontrada.valor.conexaoId;
    return { ok: true, valor: this.conexaoId };
  }

  private async lerDoCofre(conexaoId: string): Promise<Passo<Credenciais>> {
    const bruto = await this.executar(
      () => this.armazenamento.ler(this.organizacaoId, conexaoId),
      'armazenamento-falhou',
    );
    if (!bruto.ok) return bruto;

    const lido = credenciaisSchema.safeParse(bruto.valor);
    if (!lido.success) {
      return { ok: false, falha: falhar('credencial-invalida', lido.error) };
    }

    return { ok: true, valor: lido.data };
  }

  /** Outro processo tem o lock: espera ele publicar um token válido. */
  private async esperarOutroProcessoRenovar(conexaoId: string): Promise<ResultadoDoToken> {
    for (let tentativa = 0; tentativa < this.tentativasDeEspera; tentativa += 1) {
      // `dormir` é injetável, e pode rejeitar: sem isto a rejeição atravessaria
      // crua e o contrato voltaria a ser maior que o código.
      const espera = await this.executar(
        () => this.dormir(INTERVALO_ENTRE_TENTATIVAS_MS),
        'concorrencia-expirada',
      );
      if (!espera.ok) return espera.falha;

      const lidas = await this.lerDoCofre(conexaoId);
      if (!lidas.ok) return lidas.falha;

      const credenciais = lidas.valor;
      if (credenciais.access_token && !vencido(credenciais, this.agora)) {
        return { _tag: 'TokenObtido', token: credenciais.access_token };
      }
    }

    return falhar('concorrencia-expirada');
  }

  private async renovarComLock(conexaoId: string): Promise<ResultadoDoToken> {
    const lidas = await this.lerDoCofre(conexaoId);
    if (!lidas.ok) return lidas.falha;

    const credenciais = lidas.valor;
    if (!completasParaRenovar(credenciais)) return falhar('credencial-ausente');

    const troca = await this.executar(
      () => this.trocarToken({
        clientId: credenciais.client_id,
        clientSecret: credenciais.client_secret,
        refreshToken: credenciais.refresh_token,
      }),
      'troca-falhou',
    );
    if (!troca.ok) return troca.falha;

    if (troca.valor._tag === 'BlingOAuthTokenExchangeFailed') {
      // Recusa é o Bling dizendo não; `troca-falhou` é não ter conseguido
      // perguntar. A razão do provedor fica na causa, não na mensagem.
      return falhar('troca-recusada', troca.valor);
    }

    const renovado = troca.valor;
    const gravacao = await this.executar(
      () => this.armazenamento.gravar(this.organizacaoId, conexaoId, {
        client_id: credenciais.client_id,
        client_secret: credenciais.client_secret,
        access_token: renovado.access_token,
        // O Bling **rotaciona** o refresh token: guardar o antigo faz a próxima
        // renovação falhar com `invalid_grant`, e a conta cai sozinha.
        refresh_token: renovado.refresh_token,
        token_expires_at: new Date(this.agora() + renovado.expires_in * 1000).toISOString(),
      }),
      'armazenamento-falhou',
    );
    if (!gravacao.ok) return gravacao.falha;

    return { _tag: 'TokenObtido', token: renovado.access_token };
  }

  /**
   * Executa uma porta convertendo rejeição em falha tipada.
   *
   * Sem isto o contrato mentia: a união cobria os caminhos que **este** módulo
   * decide, e qualquer rejeição das portas — banco fora, cofre indisponível,
   * rede, um `dormir` que quebra — atravessava crua para o chamador.
   */
  private async executar<T>(acao: () => Promise<T>, motivo: MotivoDaFalhaDeToken): Promise<Passo<T>> {
    try {
      return { ok: true, valor: await acao() };
    } catch (causa: unknown) {
      return { ok: false, falha: falhar(motivo, causa) };
    }
  }
}
