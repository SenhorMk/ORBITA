import { useCallback, useEffect, useRef } from 'react';

import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import type { ChatwootConversation, ChatwootMessage } from '@/types';
import { falhaDaResposta, type EstadoDaConversa, type FalhaDaAcao, type MensagemOtimista } from './estadoDaConversa';

/** Aplica uma mudança ao estado de uma conversa **só** se ela ainda for a corrente. */
export type AlterarConversa = (
  chave: string,
  mudanca: (anterior: EstadoDaConversa) => EstadoDaConversa,
) => void;

/** O compositor: o rascunho, o envio, a repetição segura e a recuperação do texto. */
export interface Envio {
  readonly escreverRascunho: (texto: string) => void;
  readonly enviar: () => void;
  /** Repete o mesmo pedido (mesmo `commandId`): o servidor devolve a mesma intenção. */
  readonly tentarDeNovo: (idOtimista: number) => void;
  readonly recuperarRascunho: (idOtimista: number) => void;
}

/**
 * Quanto esperar entre duas leituras do desfecho de um envio pendente: começa em
 * 1 s e dobra até 15 s. Com o worker desligado o envio fica na fila, e a tela não
 * pode virar um laço de consultas por segundo.
 */
const PRIMEIRA_LEITURA_MS = 1_000;
const LEITURA_MAIS_ESPACADA_MS = 15_000;

/** Um envio como o servidor o descreve (`GET /api/chatwoot/send`). */
interface EnvioDoServidor {
  readonly commandId: string;
  readonly conteudo: string;
  readonly estado: 'pendente' | 'enviando' | 'enviado' | 'recusado' | 'desconhecido';
  readonly explicacao: string;
  readonly mensagemIdLocal: string | null;
  readonly criadoEm: string;
}

function lerEnvios(corpo: unknown): readonly EnvioDoServidor[] | null {
  const envios = (corpo as { envios?: unknown } | null)?.envios;
  if (!Array.isArray(envios)) return null;
  return envios.filter((e): e is EnvioDoServidor =>
    typeof e?.commandId === 'string' && typeof e?.conteudo === 'string' && typeof e?.estado === 'string');
}

/** O estado da bolha para o que o servidor afirma; `null` = virou histórico. */
function estadoDaBolha(envio: EnvioDoServidor): MensagemOtimista['estado'] | null {
  switch (envio.estado) {
    case 'enviado': return null;
    case 'recusado': return 'recusada';
    case 'desconhecido': return 'incerta';
    default: return 'pendente';
  }
}

/**
 * O envio de uma mensagem pelo contrato do MSG-008 (`POST /api/chatwoot/send`).
 *
 * Enviar registra uma intenção: o servidor responde 202 sem ter chamado o
 * Chatwoot, e a mensagem só vira histórico quando o worker grava o recibo. A
 * regra continua uma só — **nada aqui afirma entrega que o servidor não
 * confirmou** — e o `commandId`, gerado antes da rede, é o que torna repetir
 * seguro: clique duplo, falta de resposta ou reload repetem o mesmo pedido, e o
 * servidor devolve a mesma intenção. Ao abrir a conversa, os envios ainda sem
 * recibo voltam à tela, para o reload não esconder o que está na fila.
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
  const chaveAtual = estadoAtual?.chave ?? null;
  const conversaId = selecionada?.id_local ?? null;
  const proximoId = useRef(0);
  const idLocal = () => {
    proximoId.current += 1;
    // Negativo e decrescente: nunca colide com um id do Chatwoot nem entre si.
    return -(Date.now() * 1000 + proximoId.current);
  };

  /** Aplica o que o servidor diz dos envios desta conversa às bolhas dela. */
  const aplicarEnvios = useCallback((chave: string, conversa: string, envios: readonly EnvioDoServidor[], incluirNovos: boolean) => {
    alterar(chave, (anterior) => {
      const porComando = new Map(envios.map((e) => [e.commandId, e]));
      const confirmadas: ChatwootMessage[] = [];
      const otimistas = anterior.otimistas.flatMap((o): MensagemOtimista[] => {
        const envio = porComando.get(o.commandId);
        if (!envio || o.estado === 'enviando') return [o];
        const estado = estadoDaBolha(envio);
        if (estado === null) {
          if (envio.mensagemIdLocal !== null) {
            confirmadas.push({
              id_local: envio.mensagemIdLocal,
              conversa_id_local: conversa,
              content: envio.conteudo,
              message_type: 'outgoing',
              created_at: envio.criadoEm,
            });
          }
          return [];
        }
        return [{ ...o, estado, erro: estado === 'pendente' ? null : envio.explicacao }];
      });
      const conhecidos = new Set(otimistas.map((o) => o.commandId));
      const recuperados = incluirNovos
        ? envios.flatMap((e): MensagemOtimista[] => {
          const estado = estadoDaBolha(e);
          if (estado === null || conhecidos.has(e.commandId)) return [];
          return [{ id: idLocal(), commandId: e.commandId, conteudo: e.conteudo, estado, erro: estado === 'pendente' ? null : e.explicacao, criadaEm: e.criadoEm }];
        })
        : [];
      if (confirmadas.length === 0 && recuperados.length === 0 && otimistas.length === anterior.otimistas.length
          && otimistas.every((o, i) => o === anterior.otimistas[i])) {
        return anterior;
      }
      return { ...anterior, extras: [...anterior.extras, ...confirmadas], otimistas: [...recuperados.reverse(), ...otimistas] };
    });
  }, [alterar]);

  const consultar = useCallback(async (chave: string, conversa: string, incluirNovos: boolean) => {
    try {
      const resposta = await fetchWithAuth(`/api/chatwoot/send?conversaId=${encodeURIComponent(conversa)}`);
      if (!resposta.ok) return;
      const envios = lerEnvios(await resposta.json());
      if (envios !== null && chaveDaConversaRef.current === chave) aplicarEnvios(chave, conversa, envios, incluirNovos);
    } catch {
      // Sem leitura agora, a bolha fica como estava; a próxima tentativa lê de novo.
    }
  }, [aplicarEnvios, chaveDaConversaRef, fetchWithAuth]);

  // Ao abrir a conversa: o que ainda está na fila ou sem desfecho volta à tela.
  useEffect(() => {
    if (chaveAtual === null || conversaId === null) return;
    void consultar(chaveAtual, conversaId, true);
  }, [chaveAtual, consultar, conversaId]);

  // Enquanto houver envio na fila, acompanha o desfecho.
  const temPendente = (estadoAtual?.otimistas ?? []).some((o) => o.estado === 'pendente');
  useEffect(() => {
    if (!temPendente || chaveAtual === null || conversaId === null) return;
    let ativo = true;
    let espera = PRIMEIRA_LEITURA_MS;
    let timer: ReturnType<typeof setTimeout>;
    const agendar = () => {
      if (!ativo) return;
      timer = setTimeout(() => {
        void consultar(chaveAtual, conversaId, false).finally(agendar);
        espera = Math.min(espera * 2, LEITURA_MAIS_ESPACADA_MS);
      }, espera);
    };
    agendar();
    return () => {
      ativo = false;
      clearTimeout(timer);
    };
  }, [chaveAtual, consultar, conversaId, temPendente]);

  const postar = useCallback((chave: string, conversa: ChatwootConversation, otimista: MensagemOtimista) => {
    const marcar = (estado: MensagemOtimista['estado'], falha: FalhaDaAcao | null) =>
      alterar(chave, (anterior) => ({
        ...anterior,
        integracaoIndisponivel: falha?.indisponivel ? falha.mensagem : anterior.integracaoIndisponivel,
        otimistas: anterior.otimistas.map((o) => (o.id === otimista.id ? { ...o, estado, erro: falha?.mensagem ?? null } : o)),
      }));

    void (async () => {
      try {
        const resposta = await fetchWithAuth('/api/chatwoot/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Só o UUID local e o comando: o servidor resolve conexão e id remoto.
          body: JSON.stringify({ conversaId: conversa.id_local, commandId: otimista.commandId, content: otimista.conteudo }),
        });
        if (!resposta.ok) {
          // O servidor respondeu com erro: nada foi registrado nem enviado.
          marcar('falhou', await falhaDaResposta(resposta));
          return;
        }
        const corpo = await resposta.json();
        const envio = corpo?.envio;
        if (corpo?.success !== true || envio?.commandId !== otimista.commandId || typeof envio?.estado !== 'string') {
          // Sem a intenção de volta, não há o que acompanhar, e afirmar fila
          // assim mesmo seria inventar. Repetir o mesmo comando é seguro.
          marcar('sem_resposta', { mensagem: 'O servidor respondeu em um formato inesperado.', indisponivel: false });
          return;
        }
        if (envio.estado === 'desconhecido') {
          marcar('incerta', { mensagem: 'A entrega não foi confirmada e pode ter acontecido. Não reenvie: confira no Chatwoot.', indisponivel: false });
          return;
        }
        if (envio.estado === 'recusado') {
          marcar('recusada', { mensagem: 'O Chatwoot recusou esta mensagem.', indisponivel: false });
          return;
        }
        // Na fila (ou já enviada, numa repetição): o acompanhamento decide.
        marcar('pendente', null);
      } catch {
        // Sem resposta, não se sabe se o servidor registrou. Repetir com o
        // mesmo comando é seguro; um envio novo não seria.
        marcar('sem_resposta', { mensagem: 'Não houve resposta do servidor.', indisponivel: false });
      }
    })();
  }, [alterar, fetchWithAuth]);

  const enviar = useCallback(() => {
    const chave = chaveDaConversaRef.current;
    const conversa = selecionada;
    if (chave === null || conversa === null) return;
    const conteudo = (estadoAtual?.rascunho ?? '').trim();
    if (conteudo === '' || estadoAtual === null) return;
    if (estadoAtual.otimistas.some((o) => o.estado === 'enviando')) return;

    const otimista: MensagemOtimista = {
      id: idLocal(),
      commandId: crypto.randomUUID(),
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
    postar(chave, conversa, otimista);
  }, [alterar, chaveDaConversaRef, estadoAtual, postar, selecionada]);

  const tentarDeNovo = useCallback((idOtimista: number) => {
    const chave = chaveDaConversaRef.current;
    const conversa = selecionada;
    const alvo = estadoAtual?.otimistas.find((o) => o.id === idOtimista && o.estado === 'sem_resposta');
    if (chave === null || conversa === null || !alvo) return;
    alterar(chave, (anterior) => ({
      ...anterior,
      otimistas: anterior.otimistas.map((o) => (o.id === idOtimista ? { ...o, estado: 'enviando', erro: null } : o)),
    }));
    postar(chave, conversa, alvo);
  }, [alterar, chaveDaConversaRef, estadoAtual, postar, selecionada]);

  const recuperarRascunho = useCallback(
    (idOtimista: number) => {
      const chave = chaveDaConversaRef.current;
      if (chave === null) return;
      alterar(chave, (anterior) => {
        // Só o que comprovadamente não foi aplicado volta como texto novo.
        const alvo = anterior.otimistas.find((o) => o.id === idOtimista && (o.estado === 'falhou' || o.estado === 'recusada'));
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

  return { escreverRascunho, enviar, tentarDeNovo, recuperarRascunho };
}
