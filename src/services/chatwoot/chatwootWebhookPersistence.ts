import { normalizeToE164 } from '../../lib/utils';
import { ChatwootWebhookEventSchema, type ChatwootWebhookEvent } from './chatwootPort';

export function mapChatwootChannel(channelStr?: string): string {
  if (!channelStr) return 'Channel::Whatsapp';
  const upper = channelStr.toUpperCase();
  if (upper.includes('WHATSAPP')) return 'Channel::Whatsapp';
  if (upper.includes('WEBWIDGET') || upper.includes('WEB_WIDGET') || upper.includes('WEB')) return 'Channel::WebWidget';
  if (upper.includes('API')) return 'Channel::Api';
  if (upper.includes('EMAIL')) return 'Channel::Email';
  if (upper.includes('TELEGRAM')) return 'Channel::Telegram';
  if (upper.includes('SMS')) return 'Channel::Sms';
  if (upper.includes('TWITTER')) return 'Channel::TwitterProfile';
  if (upper.includes('FACEBOOK')) return 'Channel::FacebookPage';
  return 'Channel::Whatsapp';
}

/** Normaliza o `message_type` bruto do Chatwoot. O que não se reconhece é `null`, nunca `incoming`. */
export function mapChatwootMessageType(rawType: unknown): 'incoming' | 'outgoing' | 'system' | 'template' | null {
  if (rawType === 'incoming' || rawType === 0 || rawType === '0') return 'incoming';
  if (rawType === 'outgoing' || rawType === 1 || rawType === '1') return 'outgoing';
  if (rawType === 'system' || rawType === 2 || rawType === '2') return 'system';
  if (rawType === 'template' || rawType === 3 || rawType === '3') return 'template';
  return null;
}

export function senderTypeConhecido(value: string | null | undefined): string | null {
  return value && ['contact', 'user', 'agent'].includes(value) ? value : null;
}

/** Parse a Chatwoot numeric identifier that may arrive as a JSON number or a
 * numeric string, rejecting anything else (never `NaN`/`Infinity` downstream). */
export function parseOptionalInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = parseInt(value.trim(), 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** Os ids dos espelhos são `int` no banco: fora disso a escrita não tem como acertar. */
const MAIOR_ID_DO_ESPELHO = 2_147_483_647;

/** O comando da transação de consumo: dados do evento, sem organização nem conexão. */
export interface ComandoDeConsumoChatwoot {
  readonly evento: string;
  readonly acao: 'espelhar' | 'status' | 'ignorar';
  readonly account_id?: string;
  /** Versões vindas do provedor; sem elas a escrita não passa de uma revisão comprovada. */
  readonly revisao_status_em?: string;
  readonly revisao_conteudo_em?: string;
  readonly abre_caso?: boolean;
  readonly classificacao_inconclusiva?: boolean;
  readonly contato?: Readonly<Record<string, unknown>>;
  readonly conversa?: Readonly<Record<string, unknown>>;
  readonly mensagem?: Readonly<Record<string, unknown>>;
}

export type TraducaoDoEvento =
  | { readonly _tag: 'Comando'; readonly comando: ComandoDeConsumoChatwoot }
  | { readonly _tag: 'PayloadInvalido'; readonly codigo: 'payload_invalido' | 'id_fora_da_faixa' };

/** A versão do provedor em ISO, ou `undefined` se ela não vier ou não for um instante. */
export function revisaoDoProvedor(valor: string | number | undefined): string | undefined {
  if (valor === undefined || valor === '') return undefined;
  // O Chatwoot manda ISO ou segundos desde a época, conforme o evento.
  const segundos = typeof valor === 'number' ? valor : /^\d+$/.test(valor) ? Number(valor) : null;
  const instante = segundos !== null ? new Date(segundos * 1000) : new Date(String(valor));
  return Number.isNaN(instante.getTime()) ? undefined : instante.toISOString();
}

function idDoEspelho(valor: unknown): number | null {
  const id = parseOptionalInt(valor);
  return id !== null && id <= MAIOR_ID_DO_ESPELHO ? id : null;
}

/** Algum id presente, mas que o espelho não consegue guardar. */
function idForaDaFaixa(...valores: readonly unknown[]): boolean {
  return valores.some((v) => {
    const id = parseOptionalInt(v);
    return id !== null && id > MAIOR_ID_DO_ESPELHO;
  });
}

function dadosDoContato(evento: ChatwootWebhookEvent) {
  const remetente = evento.meta?.sender;
  const fragmento = evento.conversation?.contact;
  const id = idDoEspelho(remetente?.id ?? fragmento?.id);
  if (id === null) return undefined;
  const telefone = remetente?.phone_number || fragmento?.phone_number || undefined;
  return {
    id,
    nome: remetente?.name || fragmento?.name || null,
    email: remetente?.email || fragmento?.email || null,
    telefone: telefone ?? null,
    telefone_normalizado: normalizeToE164(telefone),
    avatar_url: remetente?.avatar_url || remetente?.thumbnail || fragmento?.avatar_url || null,
  };
}

function dadosDaConversa(evento: ChatwootWebhookEvent, contatoId: number | undefined, inboxId: number | null) {
  const conversa = evento.conversation;
  const id = idDoEspelho(conversa?.id);
  const contato = contatoId ?? idDoEspelho(conversa?.contact_id ?? conversa?.contact?.id);
  if (id === null || contato === null) return undefined;
  return {
    id,
    contato_id: contato,
    display_id: idDoEspelho(conversa?.display_id),
    status: conversa?.status || null,
    inbox_id: idDoEspelho(conversa?.inbox_id) ?? inboxId,
    canal: mapChatwootChannel(evento.meta?.channel || conversa?.channel),
  };
}

function dadosDaMensagem(evento: ChatwootWebhookEvent) {
  const tipo = mapChatwootMessageType(evento.message_type);
  if (tipo === null) return undefined;
  const id = idDoEspelho(evento.id);
  const conversaId = idDoEspelho(evento.conversation?.id || evento.conversation_id);
  if (id === null || conversaId === null) return undefined;
  return {
    id,
    conversa_id: conversaId,
    conteudo: evento.content || '',
    tipo,
    remetente_nome: evento.sender?.name || null,
    remetente_id: idDoEspelho(evento.sender?.id),
    remetente_tipo: senderTypeConhecido(evento.sender?.type),
    criada_em: revisaoDoProvedor(evento.created_at) ?? null,
    modo: evento.event === 'message_created' ? 'preservar' : 'sobrescrever',
  };
}

/**
 * A regra de abertura exige prova positiva: tipo `incoming` e remetente `contact`,
 * ambos declarados. Nota privada, atendente, sistema e template são outra coisa; o
 * que falta ou não se reconhece fica inconclusivo e não vira atendimento.
 */
function classificarMensagem(evento: ChatwootWebhookEvent): 'cliente' | 'nao_cliente' | 'inconclusiva' {
  if (evento.private) return 'nao_cliente';
  const tipo = mapChatwootMessageType(evento.message_type);
  const remetente = senderTypeConhecido(evento.sender?.type);
  if ((tipo !== null && tipo !== 'incoming') || remetente === 'user' || remetente === 'agent') return 'nao_cliente';
  return tipo === 'incoming' && remetente === 'contact' ? 'cliente' : 'inconclusiva';
}

/**
 * Traduz o payload minimizado da inbox no comando da transação. O payload passou
 * pelo contrato no aceite, mas é relido aqui: a linha pode ser antiga. Tipo fora
 * da lista vira `ignorar`, nunca um efeito por adivinhação.
 */
export function traduzirEventoDaInbox(
  eventType: string,
  inboxId: number | null,
  payload: unknown,
): TraducaoDoEvento {
  if (!['message_created', 'message_updated', 'conversation_status_changed'].includes(eventType)) {
    return { _tag: 'Comando', comando: { evento: eventType, acao: 'ignorar' } };
  }

  const lido = ChatwootWebhookEventSchema.safeParse(payload);
  if (!lido.success || lido.data.event !== eventType) return { _tag: 'PayloadInvalido', codigo: 'payload_invalido' };
  const evento = lido.data;
  const conversa = evento.conversation;

  if (idForaDaFaixa(evento.id, conversa?.id, evento.conversation_id, conversa?.contact_id, evento.meta?.sender?.id, conversa?.contact?.id)) {
    return { _tag: 'PayloadInvalido', codigo: 'id_fora_da_faixa' };
  }

  if (eventType === 'conversation_status_changed') {
    const id = idDoEspelho(conversa?.id);
    if (id === null || !conversa?.status) return { _tag: 'PayloadInvalido', codigo: 'payload_invalido' };
    return {
      _tag: 'Comando',
      comando: {
        evento: eventType,
        acao: 'status',
        revisao_status_em: revisaoDoProvedor(conversa.updated_at ?? evento.updated_at),
        conversa: { id, status: conversa.status },
      },
    };
  }

  const contato = dadosDoContato(evento);
  const mensagem = dadosDaMensagem(evento);
  const classificacao = eventType === 'message_created' && idDoEspelho(evento.id) !== null ? classificarMensagem(evento) : 'nao_cliente';
  return {
    _tag: 'Comando',
    comando: {
      evento: eventType,
      acao: 'espelhar',
      account_id: String(evento.account.id),
      revisao_status_em: revisaoDoProvedor(conversa?.updated_at),
      revisao_conteudo_em: revisaoDoProvedor(evento.updated_at),
      abre_caso: classificacao === 'cliente' && mensagem !== undefined,
      classificacao_inconclusiva: classificacao === 'inconclusiva',
      contato,
      conversa: dadosDaConversa(evento, contato?.id, inboxId),
      mensagem,
    },
  };
}
