import { supabase } from '@/lib/supabaseClient';
import type { ChatwootContact, ChatwootConversation, ChatwootMessage } from '@/types';

/**
 * O acesso ao espelho Supabase da mensageria — **e só ele**.
 *
 * Este módulo existe por duas razões concretas, e nenhuma delas é abstração
 * por gosto:
 *
 * 1. **O filtro de organização precisa de um lugar só.** Ele estava ausente das
 *    quatro leituras que a tela fazia, e RLS não o substitui: a política de
 *    `32_contrair_tenancy_legado.sql` é `usuario_pertence_a_organizacao`, o que
 *    autoriza *todas* as organizações de quem é membro de duas. Quem pertence a
 *    A e a B via as conversas das duas misturadas na mesma lista. Com um único
 *    ponto de leitura, o filtro é escrito uma vez e não tem como faltar em uma
 *    das cópias.
 * 2. **A prova de isolamento precisa de uma costura.** Sem ela, provar que a
 *    resposta atrasada de A não entra em B exigiria dublar o cliente Supabase
 *    inteiro dentro de cada teste de componente.
 *
 * Desde o MSG-003B a referência é só o UUID local (`id_local`): as colunas
 * lidas são explícitas e não trazem o id do Chatwoot, e o tempo real filtra a
 * conversa pelo seu UUID. O id remoto existe só no servidor.
 *
 * A leitura **lança** quando falha, de propósito. O código anterior fazia
 * `if (!error && dados)` dentro de um `try {} catch {}` vazio — uma falha de
 * leitura era indistinguível de "não há mensagens", e a tela desenhava
 * histórico vazio para uma conversa que podia ter mil mensagens.
 */
export interface EspelhoDaMensageria {
  /** As conversas da organização, mais recentes primeiro. Lança se falhar. */
  lerConversas(organizacaoId: string): Promise<ChatwootConversation[]>;
  /** O histórico de uma conversa da organização, pelo UUID local, em ordem cronológica. Lança se falhar. */
  lerMensagens(organizacaoId: string, conversaIdLocal: string): Promise<ChatwootMessage[]>;
  /**
   * Assina inserções de mensagem de uma conversa.
   *
   * `aoEstado` recebe `true` só quando a subscription está confirmadamente
   * ativa: é o que autoriza a tela a dizer "tempo real", e nada mais.
   *
   * Devolve a função que a desmonta.
   */
  assinarMensagens(
    organizacaoId: string,
    conversaIdLocal: string,
    aoInserir: (mensagem: ChatwootMessage) => void,
    aoEstado: (ativo: boolean) => void,
  ): () => void;
  /** Assina mudanças nas conversas da organização. Devolve a função que a desmonta. */
  assinarConversas(organizacaoId: string, aoMudar: () => void, aoEstado: (ativo: boolean) => void): () => void;
}

const COLUNAS_DO_CONTATO = 'id_local, organizacao_id, conexao_id, name, email, phone_number, phone_normalizado, avatar_url, created_at, updated_at';
const COLUNAS_DA_CONVERSA = 'id_local, organizacao_id, conexao_id, contato_id_local, status, channel, created_at, updated_at';
const COLUNAS_DA_MENSAGEM = 'id_local, organizacao_id, conexao_id, conversa_id_local, content, message_type, sender_name, sender_type, created_at, updated_at';

const texto = (valor: unknown): string | undefined => (typeof valor === 'string' ? valor : undefined);
const textoOuNulo = (valor: unknown): string | null => texto(valor) ?? null;

const TIPOS_DE_MENSAGEM: readonly ChatwootMessage['message_type'][] = ['incoming', 'outgoing', 'template', 'system', 'activity', '0', '1', '2', '3'];
const TIPOS_DE_REMETENTE: readonly NonNullable<ChatwootMessage['sender_type']>[] = ['contact', 'user', 'agent'];

/** Só os campos do navegador: um evento Realtime traz a linha inteira, inclusive o id remoto. */
function mensagemDoNavegador(linha: Record<string, unknown>): ChatwootMessage {
  return {
    id_local: String(linha.id_local),
    organizacao_id: texto(linha.organizacao_id),
    conexao_id: textoOuNulo(linha.conexao_id),
    conversa_id_local: textoOuNulo(linha.conversa_id_local),
    content: texto(linha.content) ?? '',
    message_type: TIPOS_DE_MENSAGEM.find((tipo) => tipo === linha.message_type) ?? 'incoming',
    sender_name: textoOuNulo(linha.sender_name),
    sender_type: TIPOS_DE_REMETENTE.find((tipo) => tipo === linha.sender_type) ?? null,
    created_at: texto(linha.created_at),
    updated_at: texto(linha.updated_at),
  };
}

function contatoDoNavegador(linha: unknown): ChatwootContact | null {
  if (linha === null || typeof linha !== 'object') return null;
  const c = linha as Record<string, unknown>;
  return {
    id_local: String(c.id_local),
    organizacao_id: texto(c.organizacao_id),
    conexao_id: textoOuNulo(c.conexao_id),
    name: texto(c.name) ?? '',
    email: textoOuNulo(c.email),
    phone_number: textoOuNulo(c.phone_number),
    phone_normalizado: textoOuNulo(c.phone_normalizado),
    avatar_url: textoOuNulo(c.avatar_url),
    created_at: texto(c.created_at),
    updated_at: texto(c.updated_at),
  };
}

function conversaDoNavegador(linha: Record<string, unknown>): ChatwootConversation {
  return {
    id_local: String(linha.id_local),
    organizacao_id: texto(linha.organizacao_id),
    conexao_id: textoOuNulo(linha.conexao_id),
    contato_id_local: textoOuNulo(linha.contato_id_local),
    status: texto(linha.status) ?? 'open',
    channel: textoOuNulo(linha.channel),
    created_at: texto(linha.created_at),
    updated_at: texto(linha.updated_at),
    contact: contatoDoNavegador(linha.contact),
  };
}

/** A mensagem de falha de uma leitura do PostgREST, sem vazar detalhe interno cru. */
function falhaDeLeitura(recurso: string, mensagem: string | undefined): Error {
  return new Error(mensagem?.trim() ? `${recurso}: ${mensagem}` : recurso);
}

/**
 * O espelho de verdade, sobre o cliente Supabase do navegador.
 *
 * Continua sendo o mesmo cliente autenticado de sempre, com as mesmas
 * políticas: o filtro por organização é uma restrição **a mais**, e não um
 * substituto de RLS. A tela pedir só o tenant ativo e o banco só autorizar os
 * tenants do membro são duas garantias diferentes, e é preciso as duas.
 */
export const espelhoSupabase: EspelhoDaMensageria = {
  async lerConversas(organizacaoId) {
    const { data, error } = await supabase
      .from('chatwoot_conversations')
      // O contato vem pela FK composta (organização, UUID local), nunca pelo id remoto.
      .select(`${COLUNAS_DA_CONVERSA}, contact:chatwoot_contacts!fk_chatwoot_conversations_contato_local(${COLUNAS_DO_CONTATO})`)
      .eq('organizacao_id', organizacaoId)
      .order('updated_at', { ascending: false });

    if (error) throw falhaDeLeitura('Não foi possível ler as conversas', error.message);
    return (data ?? []).map((linha) => conversaDoNavegador(linha as Record<string, unknown>));
  },

  async lerMensagens(organizacaoId, conversaIdLocal) {
    const { data, error } = await supabase
      .from('chatwoot_messages')
      .select(COLUNAS_DA_MENSAGEM)
      .eq('organizacao_id', organizacaoId)
      .eq('conversa_id_local', conversaIdLocal)
      .order('created_at', { ascending: true });

    if (error) throw falhaDeLeitura('Não foi possível ler o histórico', error.message);
    return (data ?? []).map((linha) => mensagemDoNavegador(linha as Record<string, unknown>));
  },

  assinarMensagens(organizacaoId, conversaIdLocal, aoInserir, aoEstado) {
    const canal = supabase
      .channel(`mensageria:${organizacaoId}:conversa:${conversaIdLocal}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chatwoot_messages',
          // O filtro do servidor é o UUID local da conversa, único entre
          // instalações; o id remoto 50 de outra conexão nunca casa.
          filter: `conversa_id_local=eq.${conversaIdLocal}`,
        },
        (payload) => {
          const mensagem = mensagemDoNavegador(payload.new as Record<string, unknown>);
          // A afirmação de escopo da tela: o tenant **e** a conversa, conferidos de novo.
          if (mensagem.organizacao_id !== organizacaoId || mensagem.conversa_id_local !== conversaIdLocal) return;
          aoInserir(mensagem);
        },
      )
      .subscribe((status) => aoEstado(status === 'SUBSCRIBED'));

    return () => {
      aoEstado(false);
      void supabase.removeChannel(canal);
    };
  },

  assinarConversas(organizacaoId, aoMudar, aoEstado) {
    const canal = supabase
      .channel(`mensageria:${organizacaoId}:conversas`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'chatwoot_conversations',
          filter: `organizacao_id=eq.${organizacaoId}`,
        },
        () => aoMudar(),
      )
      .subscribe((status) => aoEstado(status === 'SUBSCRIBED'));

    return () => {
      aoEstado(false);
      void supabase.removeChannel(canal);
    };
  },
};
