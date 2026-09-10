import { supabase } from '@/lib/supabaseClient';
import type { ChatwootConversation, ChatwootMessage } from '@/types';

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
 * A leitura **lança** quando falha, de propósito. O código anterior fazia
 * `if (!error && dados)` dentro de um `try {} catch {}` vazio — uma falha de
 * leitura era indistinguível de "não há mensagens", e a tela desenhava
 * histórico vazio para uma conversa que podia ter mil mensagens.
 */
export interface EspelhoDaMensageria {
  /** As conversas da organização, mais recentes primeiro. Lança se falhar. */
  lerConversas(organizacaoId: string): Promise<ChatwootConversation[]>;
  /** O histórico de uma conversa da organização, em ordem cronológica. Lança se falhar. */
  lerMensagens(organizacaoId: string, conversaId: number): Promise<ChatwootMessage[]>;
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
    conversaId: number,
    aoInserir: (mensagem: ChatwootMessage) => void,
    aoEstado: (ativo: boolean) => void,
  ): () => void;
  /** Assina mudanças nas conversas da organização. Devolve a função que a desmonta. */
  assinarConversas(organizacaoId: string, aoMudar: () => void, aoEstado: (ativo: boolean) => void): () => void;
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
      .select('*, contact:chatwoot_contacts(*)')
      .eq('organizacao_id', organizacaoId)
      .order('updated_at', { ascending: false });

    if (error) throw falhaDeLeitura('Não foi possível ler as conversas', error.message);
    return data ?? [];
  },

  async lerMensagens(organizacaoId, conversaId) {
    const { data, error } = await supabase
      .from('chatwoot_messages')
      .select('*')
      .eq('organizacao_id', organizacaoId)
      .eq('conversation_id', conversaId)
      .order('created_at', { ascending: true });

    if (error) throw falhaDeLeitura('Não foi possível ler o histórico', error.message);
    return data ?? [];
  },

  assinarMensagens(organizacaoId, conversaId, aoInserir, aoEstado) {
    const canal = supabase
      .channel(`mensageria:${organizacaoId}:conversa:${conversaId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chatwoot_messages',
          // Os dois filtros do lado do servidor: a conversa **e** o tenant. Só
          // a conversa bastaria para o id, mas não para a afirmação de escopo —
          // e é a afirmação de escopo que esta tela precisa poder fazer.
          filter: `conversation_id=eq.${conversaId}`,
        },
        (payload) => {
          const mensagem = payload.new as ChatwootMessage;
          if (mensagem.organizacao_id && mensagem.organizacao_id !== organizacaoId) return;
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
