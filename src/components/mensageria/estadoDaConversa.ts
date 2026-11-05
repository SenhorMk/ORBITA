/**
 * O estado de uma conversa aberta, e as regras que o mantêm honesto.
 *
 * Separado do hook porque é a parte que não depende de React: o que conta como
 * histórico, o que conta como mensagem não confirmada, e como uma falha do
 * provedor vira texto para o lojista.
 */
import type { ChatwootMessage } from '@/types';

/**
 * Uma mensagem que a tela escreveu e o servidor ainda não confirmou.
 *
 * Ela existe separada do histórico porque **não é histórico**. A versão
 * anterior empurrava a mensagem otimista para dentro da mesma lista das
 * mensagens reais, com um id negativo, e ela ficava visualmente idêntica a uma
 * mensagem entregue. Quando o envio falhava, a linha simplesmente sumia e um
 * `alert()` do navegador aparecia — o texto do lojista ia junto, porque o
 * campo já tinha sido limpo antes da requisição.
 */
export interface MensagemOtimista {
  /** Identidade local, negativa, que nunca colide com um id do Chatwoot. */
  readonly id: number;
  /** A identidade do pedido no servidor (MSG-008): repetir com ela devolve o mesmo envio. */
  readonly commandId: string;
  readonly conteudo: string;
  /**
   * - `enviando`: o pedido está indo ao servidor;
   * - `pendente`: o servidor registrou e o worker ainda não tem recibo;
   * - `sem_resposta`: não se sabe se o servidor registrou — só repetir o mesmo comando;
   * - `falhou`: o servidor respondeu erro, nada foi registrado — o texto pode voltar;
   * - `incerta`: desconhecido (MSG-007), pode ter chegado — nada a repetir daqui;
   * - `recusada`: o Chatwoot recusou de forma definitiva — o texto pode voltar.
   */
  readonly estado: 'enviando' | 'pendente' | 'sem_resposta' | 'falhou' | 'incerta' | 'recusada';
  /** O motivo da falha, quando houve. */
  readonly erro: string | null;
  readonly criadaEm: string;
}

/**
 * Tudo que pertence a **uma** conversa dentro de **um** contexto.
 *
 * O objeto inteiro carrega uma chave só — `organizacao:versão#conversa` — e
 * essa é a peça central do lifecycle. Trocar de organização, de versão de
 * seleção ou de conversa muda a chave, e com isso histórico, rascunho, erro,
 * envios em curso e carregamento **deixam de valer no mesmo render**, sem
 * ninguém precisar limpar nada e sem janela em que o resíduo anterior apareça
 * sob o contexto novo. É o mesmo desenho de `useLeituraPorOrganizacao`, num
 * eixo a mais.
 */
export interface EstadoDaConversa {
  readonly chave: string;
  /** O que o espelho devolveu. `null` enquanto a leitura desta chave não voltou. */
  readonly base: readonly ChatwootMessage[] | null;
  /** Mensagens que chegaram depois da leitura: realtime e confirmações de envio. */
  readonly extras: readonly ChatwootMessage[];
  readonly otimistas: readonly MensagemOtimista[];
  readonly erro: string | null;
  readonly rascunho: string;
  /** O texto exato de uma indisponibilidade do provedor, quando ele se pronunciou. */
  readonly integracaoIndisponivel: string | null;
  readonly alterandoStatus: boolean;
}

export function estadoVazio(chave: string): EstadoDaConversa {
  return {
    chave,
    base: null,
    extras: [],
    otimistas: [],
    erro: null,
    rascunho: '',
    integracaoIndisponivel: null,
    alterandoStatus: false,
  };
}

/**
 * O histórico visível: espelho + chegadas posteriores, **deduplicado pelo UUID local**.
 *
 * A heurística anterior descartava qualquer mensagem cujo conteúdo fosse igual
 * ao de outra dentro de uma janela de 5 segundos. Duas mensagens legítimas com
 * o mesmo texto — "ok", "obrigado", um código reenviado — são exatamente o caso
 * comum num atendimento, e a segunda desaparecia da tela para sempre. O id é
 * identidade estável e é o único critério aqui: mensagens iguais com ids
 * diferentes são duas mensagens, e as duas aparecem.
 */
export function historicoVisivel(estado: EstadoDaConversa): readonly ChatwootMessage[] {
  const porId = new Map<string, ChatwootMessage>();
  for (const mensagem of estado.base ?? []) porId.set(mensagem.id_local, mensagem);
  for (const mensagem of estado.extras) porId.set(mensagem.id_local, mensagem);
  return [...porId.values()].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
}

/** O resultado de uma ação sobre o Chatwoot, já traduzido para a tela. */
export interface FalhaDaAcao {
  readonly mensagem: string;
  /** `true` quando o servidor disse que a integração não está configurada (409). */
  readonly indisponivel: boolean;
}

export async function falhaDaResposta(resposta: Response): Promise<FalhaDaAcao> {
  const indisponivel = resposta.status === 409;
  try {
    const corpo = await resposta.json();
    const texto = typeof corpo?.error === 'string' && corpo.error ? corpo.error : null;
    return { mensagem: texto ?? `A operação falhou (HTTP ${resposta.status}).`, indisponivel };
  } catch {
    return { mensagem: `A operação falhou (HTTP ${resposta.status}).`, indisponivel };
  }
}
