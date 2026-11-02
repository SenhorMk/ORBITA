import { useCallback } from 'react';

import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import type { ChatwootConversation, ChatwootMessage } from '@/types';
import { falhaDaResposta, type EstadoDaConversa, type FalhaDaAcao, type MensagemOtimista } from './estadoDaConversa';

/** Aplica uma mudança ao estado de uma conversa **só** se ela ainda for a corrente. */
export type AlterarConversa = (
  chave: string,
  mudanca: (anterior: EstadoDaConversa) => EstadoDaConversa,
) => void;

/** O compositor: o rascunho, o envio real e a recuperação do texto que falhou. */
export interface Envio {
  readonly escreverRascunho: (texto: string) => void;
  readonly enviar: () => void;
  readonly recuperarRascunho: (idOtimista: number) => void;
}

/**
 * O envio de uma mensagem pelo contrato real (`POST /api/chatwoot/send`).
 *
 * Vive fora do hook principal porque é a parte com regra própria, e a regra é
 * uma só: **nada aqui pode afirmar entrega que o servidor não confirmou**. Daí
 * saem as três decisões que o código anterior errava — a mensagem otimista fica
 * separada do histórico, a falha marca a linha em vez de apagá-la, e nenhum
 * reenvio acontece sozinho, porque uma escrita externa repetida é pior que uma
 * incerteza declarada.
 *
 * @param chaveDaConversaRef - A chave corrente, lida no momento da resposta. É
 *   ela que impede a resposta de uma conversa (ou de um tenant) de entrar em
 *   outra.
 */
export function useEnvio(
  fetchWithAuth: AuthenticatedFetch,
  chaveDaConversaRef: { current: string | null },
  alterar: AlterarConversa,
  selecionada: ChatwootConversation | null,
  estadoAtual: EstadoDaConversa | null,
): Envio {
  const enviar = useCallback(() => {
    const chave = chaveDaConversaRef.current;
    const conversa = selecionada;
    if (chave === null || conversa === null) return;
    const conteudo = (estadoAtual?.rascunho ?? '').trim();
    if (conteudo === '' || estadoAtual === null) return;
    if (estadoAtual.otimistas.some((o) => o.estado === 'enviando')) return;

    // Negativo e decrescente: nunca colide com um id do Chatwoot, e nunca
    // colide com outro otimista da mesma conversa.
    const idOtimista = -Date.now();
    const otimista: MensagemOtimista = {
      id: idOtimista,
      conteudo,
      estado: 'enviando',
      erro: null,
      criadaEm: new Date().toISOString(),
    };
    alterar(chave, (anterior) => ({
      ...anterior,
      rascunho: '',
      integracaoIndisponivel: null,
      otimistas: [...anterior.otimistas, otimista],
    }));

    void (async () => {
      const marcarFalha = (falha: FalhaDaAcao) =>
        alterar(chave, (anterior) => ({
          ...anterior,
          integracaoIndisponivel: falha.indisponivel ? falha.mensagem : anterior.integracaoIndisponivel,
          otimistas: anterior.otimistas.map((o) =>
            o.id === idOtimista ? { ...o, estado: 'falhou' as const, erro: falha.mensagem } : o,
          ),
        }));

      try {
        const resposta = await fetchWithAuth('/api/chatwoot/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Só o UUID local: o servidor resolve conexão e id remoto.
          body: JSON.stringify({ conversaId: conversa.id_local, content: conteudo }),
        });
        if (!resposta.ok) {
          marcarFalha(await falhaDaResposta(resposta));
          return;
        }
        const corpo = await resposta.json();
        if (corpo?.success !== true || typeof corpo?.message?.id_local !== 'string') {
          // O contrato existe e é `{ success, message }`. Sem o id, não há
          // identidade estável para deduplicar, e confirmar assim mesmo seria
          // afirmar entrega a partir de uma resposta que não a sustenta.
          marcarFalha({
            mensagem: typeof corpo?.error === 'string' ? corpo.error : 'O servidor respondeu em um formato inesperado.',
            indisponivel: false,
          });
          return;
        }
        const confirmada: ChatwootMessage = {
          ...corpo.message,
          // O conteúdo é o que **nós** enviamos: a resposta da API do Chatwoot
          // nem sempre o traz de volta, e uma bolha vazia no lugar da mensagem
          // enviada seria pior que não confirmar.
          content: typeof corpo.message.content === 'string' ? corpo.message.content : conteudo,
          conversa_id_local: conversa.id_local,
          message_type: 'outgoing',
          created_at: corpo.message.created_at ?? otimista.criadaEm,
        };
        alterar(chave, (anterior) => ({
          ...anterior,
          extras: [...anterior.extras, confirmada],
          otimistas: anterior.otimistas.filter((o) => o.id !== idOtimista),
        }));
      } catch (causa) {
        // Sem resposta, não se sabe se o Chatwoot recebeu. A mensagem fica
        // marcada como não confirmada e o reenvio é decisão do lojista — um
        // retry automático aqui duplicaria uma escrita externa.
        marcarFalha({
          mensagem: causa instanceof Error && causa.message ? causa.message : 'Não houve resposta do servidor.',
          indisponivel: false,
        });
      }
    })();
  }, [alterar, chaveDaConversaRef, estadoAtual, fetchWithAuth, selecionada]);

  const recuperarRascunho = useCallback(
    (idOtimista: number) => {
      const chave = chaveDaConversaRef.current;
      if (chave === null) return;
      alterar(chave, (anterior) => {
        const alvo = anterior.otimistas.find((o) => o.id === idOtimista && o.estado === 'falhou');
        if (!alvo) return anterior;
        return {
          ...anterior,
          rascunho: anterior.rascunho.trim() === '' ? alvo.conteudo : `${anterior.rascunho} ${alvo.conteudo}`,
          otimistas: anterior.otimistas.filter((o) => o.id !== idOtimista),
        };
      });
    },
    [alterar, chaveDaConversaRef],
  );

  const escreverRascunho = useCallback(
    (texto: string) => {
      const chave = chaveDaConversaRef.current;
      if (chave === null) return;
      alterar(chave, (anterior) => ({ ...anterior, rascunho: texto }));
    },
    [alterar, chaveDaConversaRef],
  );

  return { escreverRascunho, enviar, recuperarRascunho };
}
