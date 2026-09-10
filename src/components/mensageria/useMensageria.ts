import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { chaveDaSelecao, useLeituraPorOrganizacao } from '@/components/organizacao/useLeituraPorOrganizacao';
import type { SelecaoDeOrganizacao } from '@/components/organizacao/usePapelNaOrganizacaoAtiva';
import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import type { ChatwootConversation, ChatwootMessage } from '@/types';
import { espelhoSupabase, type EspelhoDaMensageria } from './espelhoDaMensageria';
import {
  estadoVazio,
  falhaDaResposta,
  historicoVisivel,
  type EstadoDaConversa,
  type MensagemOtimista,
} from './estadoDaConversa';
import { useEnvio } from './useEnvio';

/** O que a superfície de mensageria expõe para a tela. */
export interface Mensageria {
  readonly conversas: readonly ChatwootConversation[] | null;
  readonly carregandoConversas: boolean;
  readonly erroDeConversas: string | null;
  readonly recarregarConversas: () => void;

  readonly selecionada: ChatwootConversation | null;
  readonly selecionar: (conversa: ChatwootConversation | null) => void;

  readonly historico: readonly ChatwootMessage[];
  readonly otimistas: readonly MensagemOtimista[];
  readonly carregandoHistorico: boolean;
  readonly erroDeHistorico: string | null;
  readonly recarregarHistorico: () => void;

  readonly rascunho: string;
  readonly escreverRascunho: (texto: string) => void;
  readonly enviando: boolean;
  readonly enviar: () => void;
  /** Devolve ao compositor o texto de um envio que falhou, e some com a linha falha. */
  readonly recuperarRascunho: (idOtimista: number) => void;

  readonly alterandoStatus: boolean;
  readonly alternarStatus: () => void;

  readonly sincronizando: boolean;
  readonly sincronizar: () => void;
  readonly avisoDaSincronizacao: string | null;

  /** A indisponibilidade que o servidor afirmou, quando afirmou. Nunca suposta. */
  readonly integracaoIndisponivel: string | null;
  /** Se a assinatura da lista está confirmadamente ativa **agora**. */
  readonly tempoRealDeConversas: boolean;
  /** Se a assinatura do histórico da conversa aberta está confirmadamente ativa **agora**. */
  readonly tempoRealDeMensagens: boolean;
}

/**
 * A mensageria desktop, escopada na organização ativa verificada.
 *
 * ## O que este hook conserta, e por quê cada coisa estava errada
 *
 * - **Escopo.** As quatro leituras eram `select('*')` sem filtro nenhum, e
 *   confiavam em RLS. A política de Chatwoot autoriza toda organização de que o
 *   usuário é membro (`32_contrair_tenancy_legado.sql`), então membro de A e B
 *   via as duas listas fundidas. O filtro por organização ativa vive agora em
 *   `EspelhoDaMensageria`, uma vez só.
 * - **Leituras duplicadas.** Havia dois efeitos idênticos lendo `chatwoot_messages`
 *   na mesma dependência (`selectedConversa`), e ainda um terceiro relendo
 *   conversas ao abrir a aba. Cada seleção disparava duas requisições que
 *   corriam entre si.
 * - **Histórico velho sob seleção nova.** Nenhum dos dois efeitos limpava a
 *   lista antes de ler, então as mensagens da conversa anterior ficavam na tela
 *   sob o cabeçalho da conversa nova, e sumiam só quando a leitura voltasse.
 * - **Resposta atrasada.** A guarda era `isMounted`, que só cobre desmontagem.
 *   A resposta de A voltando depois da troca para B era gravada por cima de B.
 * - **Erro silencioso.** `try {} catch {}` vazio, `if (!error && dados)` — falha
 *   de leitura desenhava exatamente a mesma tela que "não há mensagens".
 * - **Subscription.** A da lista era global e nunca recriada; a de mensagens
 *   deduplicava por conteúdo + 5 s e engolia mensagens legítimas repetidas.
 *
 * A superfície é montada só enquanto a aba está aberta: fechá-la desmonta as
 * subscriptions e o estado junto, que é o comportamento que já existia e o mais
 * seguro dos dois.
 *
 * @param selecao - A organização ativa confirmada e a versão que a selecionou.
 *   `null` sem sessão ou sem organização — e aí a tela não lê nem assina nada.
 */
export function useMensageria(
  fetchWithAuth: AuthenticatedFetch,
  selecao: SelecaoDeOrganizacao | null,
  espelho: EspelhoDaMensageria = espelhoSupabase,
): Mensageria {
  const chaveDoContexto = chaveDaSelecao(selecao);

  const lerConversas = useCallback(
    (organizacaoId: string) => espelho.lerConversas(organizacaoId),
    [espelho],
  );
  const leituraDeConversas = useLeituraPorOrganizacao(
    selecao,
    lerConversas,
    'Não foi possível ler as conversas desta organização.',
  );

  // A seleção de conversa é carimbada pelo contexto, e não guardada solta: uma
  // conversa de A que continuasse selecionada em B seria o cabeçalho de um
  // tenant sobre o histórico de outro.
  const [selecionadaCarimbada, setSelecionadaCarimbada] = useState<
    { readonly chave: string; readonly conversa: ChatwootConversation } | null
  >(null);
  const selecionada =
    chaveDoContexto !== null && selecionadaCarimbada?.chave === chaveDoContexto
      ? selecionadaCarimbada.conversa
      : null;

  const chaveDaConversa =
    chaveDoContexto !== null && selecionada !== null ? `${chaveDoContexto}#${selecionada.id}` : null;

  const [estado, setEstado] = useState<EstadoDaConversa | null>(null);
  const estadoAtual = chaveDaConversa !== null && estado?.chave === chaveDaConversa ? estado : null;

  /**
   * A chave que uma resposta precisa encontrar para poder gravar.
   *
   * Ela é atualizada **antes** de qualquer disparo, e toda resposta a consulta
   * antes de tocar em estado. É o que impede a resposta de A de entrar em B — e
   * também a da conversa 1 de entrar na conversa 2.
   */
  const chaveDaConversaRef = useRef(chaveDaConversa);
  chaveDaConversaRef.current = chaveDaConversa;
  const chaveDoContextoRef = useRef(chaveDoContexto);
  chaveDoContextoRef.current = chaveDoContexto;

  /** Aplica uma mudança **só** se a chave alvo ainda for a corrente. */
  const alterar = useCallback((chave: string, mudanca: (anterior: EstadoDaConversa) => EstadoDaConversa) => {
    if (chaveDaConversaRef.current !== chave) return;
    setEstado((anterior) => (anterior?.chave === chave ? mudanca(anterior) : anterior));
  }, []);

  const lerHistorico = useCallback(async () => {
    const chave = chaveDaConversaRef.current;
    const organizacaoId = selecao?.id;
    const conversaId = selecionada?.id;
    if (chave === null || organizacaoId === undefined || conversaId === undefined) return;
    try {
      const mensagens = await espelho.lerMensagens(organizacaoId, conversaId);
      alterar(chave, (anterior) => ({ ...anterior, base: mensagens, erro: null }));
    } catch (causa) {
      const detalhe = causa instanceof Error ? causa.message.trim() : '';
      alterar(chave, (anterior) => ({
        ...anterior,
        base: null,
        erro: detalhe || 'Não foi possível ler o histórico desta conversa.',
      }));
    }
  }, [alterar, espelho, selecao?.id, selecionada?.id]);

  // A leitura do histórico, **uma vez por chave**. O estado é trocado por um
  // vazio na mesma passada em que a chave muda: é isso que faz o histórico
  // anterior sair da tela imediatamente, e não quando a leitura nova voltar.
  useEffect(() => {
    if (chaveDaConversa === null) {
      setEstado(null);
      return;
    }
    setEstado((anterior) => (anterior?.chave === chaveDaConversa ? anterior : estadoVazio(chaveDaConversa)));
    void lerHistorico();
  }, [chaveDaConversa, lerHistorico]);

  // ── Tempo real ──────────────────────────────────────────────────────────
  const [tempoRealDeConversas, setTempoRealDeConversas] = useState(false);
  const [tempoRealDeMensagens, setTempoRealDeMensagens] = useState(false);

  const recarregarConversas = leituraDeConversas.recarregar;
  const organizacaoId = selecao?.id ?? null;

  useEffect(() => {
    setTempoRealDeConversas(false);
    if (organizacaoId === null) return;
    let vigente = true;
    const desassinar = espelho.assinarConversas(
      organizacaoId,
      () => {
        if (vigente) void recarregarConversas();
      },
      (assinado) => {
        if (vigente) setTempoRealDeConversas(assinado);
      },
    );
    return () => {
      vigente = false;
      setTempoRealDeConversas(false);
      desassinar();
    };
  }, [espelho, organizacaoId, recarregarConversas]);

  const conversaId = selecionada?.id ?? null;
  useEffect(() => {
    setTempoRealDeMensagens(false);
    if (organizacaoId === null || conversaId === null || chaveDaConversa === null) return;
    let vigente = true;
    const desassinar = espelho.assinarMensagens(
      organizacaoId,
      conversaId,
      (mensagem) => {
        if (vigente) alterar(chaveDaConversa, (anterior) => ({ ...anterior, extras: [...anterior.extras, mensagem] }));
      },
      (assinado) => {
        if (vigente) setTempoRealDeMensagens(assinado);
      },
    );
    return () => {
      vigente = false;
      setTempoRealDeMensagens(false);
      desassinar();
    };
  }, [alterar, chaveDaConversa, conversaId, espelho, organizacaoId]);

  const { escreverRascunho, enviar, recuperarRascunho } = useEnvio(
    fetchWithAuth,
    chaveDaConversaRef,
    alterar,
    selecionada,
    estadoAtual,
  );

  // ── Resolver / reabrir ──────────────────────────────────────────────────
  const alternarStatus = useCallback(() => {
    const chave = chaveDaConversaRef.current;
    const conversa = selecionada;
    if (chave === null || conversa === null || estadoAtual?.alterandoStatus) return;
    const novoStatus = conversa.status === 'open' ? 'resolved' : 'open';
    alterar(chave, (anterior) => ({ ...anterior, alterandoStatus: true, integracaoIndisponivel: null }));

    void (async () => {
      try {
        const resposta = await fetchWithAuth('/api/chatwoot/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: conversa.id, status: novoStatus }),
        });
        if (!resposta.ok) {
          const falha = await falhaDaResposta(resposta);
          alterar(chave, (anterior) => ({
            ...anterior,
            alterandoStatus: false,
            erro: falha.mensagem,
            integracaoIndisponivel: falha.indisponivel ? falha.mensagem : anterior.integracaoIndisponivel,
          }));
          return;
        }
        alterar(chave, (anterior) => ({ ...anterior, alterandoStatus: false }));
        // A conversa selecionada só é reescrita se ainda for a mesma: uma
        // resposta da conversa 1 não pode reescrever o cabeçalho da conversa 2.
        if (chaveDaConversaRef.current !== chave) return;
        setSelecionadaCarimbada((anterior) =>
          anterior?.conversa.id === conversa.id
            ? { chave: anterior.chave, conversa: { ...anterior.conversa, status: novoStatus } }
            : anterior,
        );
        void recarregarConversas();
      } catch (causa) {
        alterar(chave, (anterior) => ({
          ...anterior,
          alterandoStatus: false,
          erro: causa instanceof Error && causa.message ? causa.message : 'Não houve resposta do servidor.',
        }));
      }
    })();
  }, [alterar, estadoAtual?.alterandoStatus, fetchWithAuth, recarregarConversas, selecionada]);

  // ── Sincronização com o Chatwoot ────────────────────────────────────────
  const [sincronizacao, setSincronizacao] = useState<
    { readonly chave: string; readonly emCurso: boolean; readonly aviso: string | null } | null
  >(null);
  const sincronizacaoAtual =
    chaveDoContexto !== null && sincronizacao?.chave === chaveDoContexto ? sincronizacao : null;

  const sincronizar = useCallback(() => {
    const chave = chaveDoContextoRef.current;
    if (chave === null || sincronizacaoAtual?.emCurso) return;
    setSincronizacao({ chave, emCurso: true, aviso: null });

    const publicar = (aviso: string | null) => {
      if (chaveDoContextoRef.current !== chave) return;
      setSincronizacao({ chave, emCurso: false, aviso });
    };

    void (async () => {
      try {
        const resposta = await fetchWithAuth('/api/chatwoot/sync', { method: 'POST' });
        if (!resposta.ok) {
          publicar((await falhaDaResposta(resposta)).mensagem);
          return;
        }
        const corpo = await resposta.json();
        if (corpo?.success !== true) {
          publicar(typeof corpo?.error === 'string' ? corpo.error : 'A sincronização não foi concluída.');
          return;
        }
        publicar(null);
        if (chaveDoContextoRef.current !== chave) return;
        void recarregarConversas();
        void lerHistorico();
      } catch (causa) {
        publicar(causa instanceof Error && causa.message ? causa.message : 'Não houve resposta do servidor.');
      }
    })();
  }, [fetchWithAuth, lerHistorico, recarregarConversas, sincronizacaoAtual?.emCurso]);

  const selecionar = useCallback(
    (conversa: ChatwootConversation | null) => {
      const chave = chaveDoContextoRef.current;
      if (chave === null) return;
      setSelecionadaCarimbada(conversa === null ? null : { chave, conversa });
    },
    [],
  );

  const historico = useMemo(() => (estadoAtual === null ? [] : historicoVisivel(estadoAtual)), [estadoAtual]);

  return {
    conversas: leituraDeConversas.dados,
    carregandoConversas: leituraDeConversas.carregando,
    erroDeConversas: leituraDeConversas.erro,
    recarregarConversas: () => { void recarregarConversas(); },

    selecionada,
    selecionar,

    historico,
    otimistas: estadoAtual?.otimistas ?? [],
    carregandoHistorico: estadoAtual !== null && estadoAtual.base === null && estadoAtual.erro === null,
    erroDeHistorico: estadoAtual?.erro ?? null,
    recarregarHistorico: () => { void lerHistorico(); },

    rascunho: estadoAtual?.rascunho ?? '',
    escreverRascunho,
    enviando: (estadoAtual?.otimistas ?? []).some((o) => o.estado === 'enviando'),
    enviar,
    recuperarRascunho,

    alterandoStatus: estadoAtual?.alterandoStatus ?? false,
    alternarStatus,

    sincronizando: sincronizacaoAtual?.emCurso ?? false,
    sincronizar,
    avisoDaSincronizacao: sincronizacaoAtual?.aviso ?? null,

    integracaoIndisponivel: estadoAtual?.integracaoIndisponivel ?? null,
    tempoRealDeConversas,
    tempoRealDeMensagens,
  };
}
