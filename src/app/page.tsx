'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  FileText,
  CheckCircle,
  AlertTriangle,
  MessageSquare,
  MessageCircle,
  Send,
  Sparkles,
  ArrowRight,
  Lock,
  Mail,
  Search,
  RefreshCw,
  X,
  Plus,
} from "lucide-react";
import type { Produto, Cliente, ChatwootConversation, ChatwootMessage, ItemPedido } from '@/types';
import { supabase } from '@/lib/supabaseClient';
import {
  descreverProgresso,
  jobEmAndamento,
  syncEnqueueResponseSchema,
  syncStatusResponseSchema,
  type SyncJobStatusValue,
} from '@/lib/config/syncContract';
import type { User as SupabaseUser } from '@supabase/supabase-js';
import { PedidoEnriquecido } from '@/repositories/pedidoRepository';
import { AppWindow } from '@/components/shell/AppWindow';
import { Rail } from '@/components/shell/Rail';
import { OrganizacaoAtiva } from '@/components/shell/OrganizacaoAtiva';
import { SeletorDeFundo, useFundo } from '@/components/shell/SeletorDeFundo';
import { VendasEPedidos } from '@/components/vendas/VendasEPedidos';
import { EstoqueEProdutos } from '@/components/estoque/EstoqueEProdutos';
import { ClientesEContatos } from '@/components/clientes/ClientesEContatos';
import { ClienteDetailModal } from '@/components/ClienteDetailModal';
import { ProductDetailModal } from '@/components/ProductDetailModal';
import { ClienteEditModal } from '@/components/ClienteEditModal';
import { ManualOrderModal } from '@/components/ManualOrderModal';
import { StartupLoader } from '@/components/StartupLoader';
import { FinanceiroTab } from '@/components/financeiro/FinanceiroTab';
import { RegisterForm } from '@/components/auth/RegisterForm';
import { OrganizationPanel } from '@/components/organizacao/OrganizationPanel';
import { IntegrationsPanel } from '@/components/integracoes/IntegrationsPanel';
import { BillingPanel } from '@/components/billing/BillingPanel';
import { fetchWithAuth } from '@/lib/fetchWithAuth';
import {
  usePapelNaOrganizacaoAtiva,
  type SelecaoDeOrganizacao,
} from '@/components/organizacao/usePapelNaOrganizacaoAtiva';
import { useStartupPorOrganizacao } from '@/components/organizacao/useStartupPorOrganizacao';
import { useOrganizationsList } from '@/components/organizacao/useOrganizationsList';
import { useLeituraDoPainel } from '@/components/painel/useLeituraDoPainel';
import { VisaoGeral } from '@/components/painel/VisaoGeral';
import { descreverErro } from '@/lib/erroLegivel';

/**
 * Identidade do usuário logado — **e nada além disso**.
 *
 * Ticket 22, fatia C: este tipo carregava um `role` que a própria tela inventava,
 * a partir de `app_metadata.role`, da substring `dono` no e-mail, do e-mail fixo
 * `admin@haux.com.br` e do que estivesse no `localStorage`. Nenhuma dessas
 * fontes é autoridade, e as três primeiras davam aparência de proprietário a
 * quem não é. O papel agora vem do vínculo persistido, por
 * `usePapelNaOrganizacaoAtiva`.
 */
interface UserSession {
  email: string;
  name: string;
}

/** Deriva a identidade Orbita a partir de um usuário autenticado do Supabase. */
function deriveUserSession(user: SupabaseUser): UserSession {
  return {
    email: user.email || '',
    name: user.user_metadata?.full_name || user.email?.split('@')[0] || 'Usuário',
  };
}

function OrbitaLogo({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 110.88 117.1" fill="none" xmlns="http://www.w3.org/2000/svg">
      <polygon fill="url(#orbita-poly-grad)" points="42.72 22.97 51.52 3.89 58.66 3.96 68.16 23.01 67.59 71.89 65.58 87.31 45.1 86.91 43.34 71.93 42.72 22.97"/>
      <path fill="#692A6F" d="M43.94,29.68c-1.53,1.37-2.38,3.99-2.56,6.12-16.87,2.74-29.08,14.06-41.38,28.71C4.08,44.03,22.32,28.02,42.72,22.97c2.1,1.36,1.18,5.16,1.22,6.71Z"/>
      <path fill="#BF406A" d="M91.36,79.64c.5,9.17,4.32,17.39-5.85,23.99-4.76-3.4-7.18-8.74-6.35-14.49l1.4-9.59c3.48.3,7.29-.45,10.8.08Z"/>
      <path fill="#BF406A" d="M30.35,79.59c.25,9.54,4.92,16.53-5.91,24.22-9.3-8.77-6.34-13.94-4.85-24.25,3.47-.28,7.34.05,10.76.04Z"/>
      <path fill="#ED8F60" d="M30.35,79.59c-3.42.01-7.29-.31-10.76-.04-2.25-.75-3.44-3.12-2.83-6.06,1.05-5.06,5.57-8.87,10.6-10.32,13.17-3.79,13.05-15.72,14.02-27.39.18-2.12,1.03-4.75,2.56-6.12.24,9.02.73,26.93,0,37.53-.21,2.99-1.5,5.43.82,8.44-5.07,2.62-11.51-1.76-14.4,3.95Z"/>
      <path fill="#F0E675" d="M61.34,18.44c-4.65.58-8.36.45-12.43.03-.27-5.3,3.09-8.84,6.26-12.26,3.65,4.04,6.53,7.2,6.17,12.22Z"/>
      <path fill="#ED8F60" d="M63.11,90.33c-4.75-1.76-3.04,5.93-7.74,6.41-5.7.58-2-9.42-8.61-6.27-.7-.39-1.54-.69-2.06-1.26-.49-.52-.6-2.11.4-2.31,1.86-.37,4.53.41,5.25-1.13l4.86-11.34c.62,3.37,2.13,5.84,3.04,8.68,2.11,6.65,7.55,1.27,7.66,5.24.01.49-.34,1.28-.98,1.46l-1.82.51Z"/>
      <path fill="#692A6F" d="M63.11,90.33c.88,5.27,3.62,11.37.54,16.43l-6.28,10.34h-4.53c-7.38-13.13-8.9-9.75-6.08-26.62,6.61-3.16,2.91,6.85,8.61,6.27,4.7-.48,2.99-8.17,7.74-6.41Z"/>
      <path fill="#692A6F" d="M58.66,3.96c-2.78.58-4.62.34-7.14-.07.2-1.95,1.53-3.58,3.01-3.84,2.02-.36,4.02,1.32,4.13,3.91Z"/>
      <path fill="#692A6F" d="M66.94,29.72c1.53,1.37,2.38,3.99,2.56,6.12,16.87,2.74,29.08,14.06,41.38,28.71-4.08-20.47-22.32-36.48-42.72-41.54-2.1,1.36-1.18,5.16-1.22,6.71Z"/>
      <path fill="#ED8F60" d="M80.53,79.64c3.42.01,7.29-.31,10.76-.04,2.25-.75,3.44-3.12,2.83-6.06-1.05-5.06-5.57-8.87-10.6-10.32-13.17-3.79-13.05-15.72-14.02-27.39-.18-2.12-1.03-4.75-2.56-6.12-.24,9.02-.73,26.93,0,37.53.21,2.99,1.5,5.43-.82,8.44,5.07,2.62,11.51-1.76,14.4,3.95Z"/>
      <defs>
        <linearGradient id="orbita-poly-grad" x1="42" y1="3" x2="68" y2="87" gradientUnits="userSpaceOnUse">
          <stop stopColor="#F0E675" />
          <stop offset="1" stopColor="#ED8F60" />
        </linearGradient>
      </defs>
    </svg>
  );
}


/**
 * As telas que compõem a si mesmas e ocupam a altura inteira da janela.
 *
 * Nelas a tabela é que fica com o espaço que sobra; as demais continuam
 * empilhando e rolando dentro do `main`, como sempre fizeram.
 */
const TELAS_QUE_OCUPAM_A_JANELA = new Set(['dashboard', 'sales', 'inventory', 'contacts', 'finance', 'organization']);

/** Intervalo entre consultas ao estado do job de sincronização. */
const INTERVALO_POLL_SYNC_MS = 2_000;
/** Teto de espera: 10 minutos. Um catálogo grande leva minutos, não horas. */
const MAX_POLLS_SYNC = 300;

/**
 * Acompanha o job durável até um estado final, atualizando o texto de
 * progresso com os números que o servidor realmente reporta.
 */
async function acompanharSync(
  jobId: string,
  fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response>,
  reportar: (mensagem: string) => void,
): Promise<SyncJobStatusValue | 'desconhecido'> {
  for (let tentativa = 0; tentativa < MAX_POLLS_SYNC; tentativa += 1) {
    await new Promise((resolve) => setTimeout(resolve, INTERVALO_POLL_SYNC_MS));

    const resposta = await fetchWithAuth(`/api/sync/status?job_id=${encodeURIComponent(jobId)}`);
    const corpo = await resposta.json();

    if (!resposta.ok) {
      reportar(`Não foi possível acompanhar a sincronização (HTTP ${resposta.status}): ${corpo?.error ?? ''}`);
      return 'desconhecido';
    }

    const estado = syncStatusResponseSchema.safeParse(corpo);
    if (!estado.success) {
      reportar('O servidor respondeu o estado da sincronização num formato inesperado.');
      return 'desconhecido';
    }

    reportar(descreverProgresso(estado.data.job));
    if (!jobEmAndamento(estado.data.job.status)) return estado.data.job.status;
  }

  reportar('A sincronização continua rodando no servidor. Recarregue a página em alguns minutos.');
  return 'desconhecido';
}

export default function Home() {
  // Controle de Autenticação
  const [session, setSession] = useState<UserSession | null>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('haux_session');
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch {
          localStorage.removeItem('haux_session');
        }
      }
    }
    return null;
  });
  const identidadeDaSessao = session?.email ?? null;
  const [fundo, escolherFundo] = useFundo();

  /**
   * O estado de organizações, **uma vez só** (Ticket 01).
   *
   * O indicador do topo e a aba de organização olham para o mesmo objeto: se
   * cada um tivesse o seu, trocar de organização pelo topo deixaria a aba
   * anunciando a anterior. A troca continua sendo a mesma de sempre — a rota
   * com o contrato CAS, dentro deste hook.
   *
   * Sem sessão não se consulta nada: `fetchWithAuth` lança sem token, e a tela
   * de login é renderizada por este mesmo componente.
   */
  const listaDeOrganizacoes = useOrganizationsList(fetchWithAuth, identidadeDaSessao);

  /**
   * A organização ativa desta tela, **derivada da mesma fonte que o shell**.
   *
   * Antes ela vinha de um anúncio do painel de organização, por efeito. O
   * anúncio é correto, mas chega tarde: no render em que a fonte compartilhada
   * já expõe B — e o indicador do topo já escreve B na tela —, a seleção ainda
   * era A. Um render inteiro, com paint, em que o nome no topo é de uma
   * organização e os números embaixo são de outra. Num produto multi-tenant, é
   * o defeito que não se pode ter, e nenhum carimbo no consumidor resolve: quem
   * chega atrasado é a própria fonte do escopo.
   *
   * Derivar durante a renderização elimina a janela: não existe momento em que
   * a fonte diz B e a seleção diz A.
   *
   * A versão entra junto porque sair de uma organização e voltar são seleções
   * diferentes — só ela as distingue. E a seleção não sobrevive à sessão que a
   * produziu de graça: `useOrganizationsList` já devolve organização ativa nula
   * para uma leitura de outra sessão.
   */
  const organizacaoAtivaId = listaDeOrganizacoes.activeOrg?.organizacao.id ?? null;
  const versaoDaSelecao = listaDeOrganizacoes.selectionVersion;
  const selecaoDeOrganizacao = useMemo<SelecaoDeOrganizacao | null>(
    () => (organizacaoAtivaId === null ? null : { id: organizacaoAtivaId, versao: versaoDaSelecao }),
    [organizacaoAtivaId, versaoDaSelecao],
  );
  const activeOrganizacaoId = selecaoDeOrganizacao?.id ?? null;

  // Autoridade única sobre papel: o vínculo persistido, lido do servidor, para
  // o par (sessão, organização ativa). Trocar qualquer um dos dois invalida o
  // papel anterior antes de a resposta nova chegar.
  const { podeGerir, organizacaoId: organizacaoConfirmada } = usePapelNaOrganizacaoAtiva(
    fetchWithAuth,
    identidadeDaSessao,
    selecaoDeOrganizacao,
  );
  const isOwner = podeGerir;
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [selectedProdutoModal, setSelectedProdutoModal] = useState<Produto | null>(null);
  const [isProductModalOpen, setIsProductModalOpen] = useState(false);
  const [selectedClienteModal, setSelectedClienteModal] = useState<Cliente | null>(null);
  const [isClienteModalOpen, setIsClienteModalOpen] = useState(false);
  // A inicialização é **por organização confirmada**, e só de quem administra.
  // Era um booleano global ao lado de um papel que só conhecia a sessão: quem
  // iniciava em A e trocava para B nunca via a inicialização de B, porque o
  // estado de A continuava valendo (revisão do #66).
  const { mostrarCarregador: showStartupLoader, encerrar: encerrarStartup } =
    useStartupPorOrganizacao(podeGerir, organizacaoConfirmada);


  const handleOpenProductModal = (produto: Produto) => {
    setSelectedProdutoModal(produto);
    setIsProductModalOpen(true);
  };

  // Navegação do Painel (Abas)
  const [activeTab, setActiveTab] = useState<
    'dashboard' | 'sales' | 'inventory' | 'contacts' | 'finance' | 'sac' | 'organization' | 'integrations' | 'billing'
  >('dashboard');

  // Estados dos Modais Interativos do Dashboard
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Estados do Dashboard
  /**
   * A leitura operacional, **carimbada pela organização que a produziu**.
   *
   * O escopo carrega a identidade da sessão e a seleção de organização com a
   * versão: sair de uma organização e voltar são seleções diferentes. Trocar de
   * organização torna a leitura anterior inelegível na hora, e a resposta
   * atrasada da organização de antes não tem onde ser aplicada.
   */
  const escopoDaLeitura = identidadeDaSessao === null
    ? null
    : `${identidadeDaSessao}|${selecaoDeOrganizacao ? `${selecaoDeOrganizacao.id}:${selecaoDeOrganizacao.versao}` : 'sem-organizacao'}`;

  const painel = useLeituraDoPainel(escopoDaLeitura);
  const data = painel.dados;
  const erroDaLeitura = painel.erro;
  const isLoading = painel.carregando;
  const loadDashboardData = painel.recarregar;

  /**
   * Os contatos da tela de Clientes.
   *
   * O recurso ao cliente dos pedidos é o mesmo de antes: quando a leitura não
   * traz `clientes`, a tela ainda consegue listar quem apareceu comprando, sem
   * repetir ninguém. `null` enquanto nenhuma leitura deu certo — vazio e "não
   * sei" continuam sendo coisas diferentes.
   */
  const clientesDoPainel = useMemo<Cliente[] | null>(() => {
    if (!data) return null;
    if (data.clientes && data.clientes.length > 0) return data.clientes;
    return (data.pedidos ?? [])
      .map((pedido) => pedido.cliente)
      .filter((cliente, indice, todos): cliente is Cliente =>
        !!cliente && todos.findIndex((outro) => outro?.id === cliente.id) === indice);
  }, [data]);

  const [isSyncing, setIsSyncing] = useState(false);
  const [nfeLoadingId, setNfeLoadingId] = useState<string | null>(null);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);
  const [selectedPedido, setSelectedPedido] = useState<PedidoEnriquecido | null>(null);
  const [selectedPedidoItems, setSelectedPedidoItems] = useState<Array<ItemPedido & { produto?: Produto }>>([]);
  const [isItemsLoading, setIsItemsLoading] = useState(false);

  // Estados Locais para Modais de Pedido Manual e Cadastro de Contato
  const [isManualOrderOpen, setIsManualOrderOpen] = useState(false);
  const [isClienteEditOpen, setIsClienteEditOpen] = useState(false);
  const [selectedClienteToEdit, setSelectedClienteToEdit] = useState<Cliente | null>(null);

  // Relógio Dinâmico de Sincronização Real do Supabase Cache
  const [lastSyncDate, setLastSyncDate] = useState<Date | null>(null);
  const [syncAgoText, setSyncAgoText] = useState('Não sincronizado');

  // Estados do Chatwoot Recreated UI
  const [conversas, setConversas] = useState<ChatwootConversation[]>([]);
  const [selectedConversa, setSelectedConversa] = useState<ChatwootConversation | null>(null);
  const [mensagens, setMensagens] = useState<ChatwootMessage[]>([]);
  const [newMessageContent, setNewMessageContent] = useState('');
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [conversaFilter, setConversaFilter] = useState<'all' | 'open' | 'resolved'>('open');
  const [conversaSearch, setConversaSearch] = useState('');
  const [isSyncingChatwoot, setIsSyncingChatwoot] = useState(false);
  const [chatwootFeedback, setChatwootFeedback] = useState<string | null>(null);
  const [isChangingStatus, setIsChangingStatus] = useState(false);

  // Helper para fetch autenticado com Supabase JWT

  // Carregar conversas do Supabase
  const loadConversations = async () => {
    try {
      const { data: convs, error } = await supabase
        .from('chatwoot_conversations')
        .select(`
          *,
          contact:chatwoot_contacts(*)
        `)
        .order('updated_at', { ascending: false });

      if (!error && convs) {
        setConversas(convs);
      }
    } catch {
      // Silencioso para evitar overlay de erro de RLS
    }
  };

  // Carregar mensagens de uma conversa selecionada
  useEffect(() => {
    let isMounted = true;
    void (async () => {
      if (!selectedConversa?.id) {
        return;
      }
      try {
        const { data: msgs, error } = await supabase
          .from('chatwoot_messages')
          .select('*')
          .eq('conversation_id', selectedConversa.id)
          .order('created_at', { ascending: true });

        if (!error && msgs && isMounted) {
          setMensagens(msgs);
        }
      } catch {
        // Silencioso para evitar overlay de erro de RLS
      }
    })();
    return () => {
      isMounted = false;
    };
  }, [selectedConversa]);

  // Sincronizar conversas com o Chatwoot via API
  const handleSyncChatwoot = async () => {
    setIsSyncingChatwoot(true);
    setChatwootFeedback(null);
    try {
      const response = await fetchWithAuth('/api/chatwoot/sync', { method: 'POST' });
      const result = await response.json();
      if (result.success) {
        setChatwootFeedback(`Sincronizado! +${result.stats.conversations} conversas, +${result.stats.messages} mensagens.`);
        await loadConversations();
      } else {
        setChatwootFeedback(`Erro: ${result.error}`);
      }
    } catch (error) {
      console.error('Erro ao sincronizar Chatwoot:', error);
      setChatwootFeedback('Erro ao comunicar com o servidor.');
    } finally {
      setIsSyncingChatwoot(false);
      setTimeout(() => setChatwootFeedback(null), 5000);
    }
  };

  // Enviar mensagem no chat
  const handleSendChatMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedConversa || !newMessageContent.trim() || isSendingMessage) return;

    const content = newMessageContent.trim();
    setNewMessageContent('');
    setIsSendingMessage(true);

    const tempId = Math.floor(Math.random() * -1000000);
    const tempMsg: ChatwootMessage = {
      id: tempId,
      conversation_id: selectedConversa.id,
      content: content,
      message_type: 'outgoing',
      sender_name: 'Você',
      created_at: new Date().toISOString(),
    };
    setMensagens((prev) => [...prev, tempMsg]);

    try {
      const response = await fetchWithAuth('/api/chatwoot/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: selectedConversa.id, content }),
      });
      const result = await response.json();
      if (!result.success) {
        alert(`Erro ao enviar: ${result.error}`);
        setMensagens((prev) => prev.filter((m) => m.id !== tempId));
      } else {
        setMensagens((prev) => prev.map((m) => m.id === tempId ? { ...result.message, message_type: 'outgoing' } : m));
      }
    } catch (error) {
      console.error('Erro ao enviar mensagem:', error);
      setMensagens((prev) => prev.filter((m) => m.id !== tempId));
    } finally {
      setIsSendingMessage(false);
    }
  };

  // Resolver / Reabrir conversa
  const handleToggleConversaStatus = async () => {
    if (!selectedConversa || isChangingStatus) return;
    setIsChangingStatus(true);

    const newStatus = selectedConversa.status === 'open' ? 'resolved' : 'open';
    try {
      const response = await fetchWithAuth('/api/chatwoot/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: selectedConversa.id, status: newStatus }),
      });
      const result = await response.json();
      if (result.success) {
        setSelectedConversa((prev: ChatwootConversation | null) => prev ? { ...prev, status: newStatus } : null);
        setConversas((prev) => prev.map((c) => c.id === selectedConversa.id ? { ...c, status: newStatus } : c));
      } else {
        alert(`Erro ao alterar status: ${result.error}`);
      }
    } catch (error) {
      console.error('Erro ao alterar status:', error);
    } finally {
      setIsChangingStatus(false);
    }
  };

  // Carregar itens do pedido selecionado
  useEffect(() => {
    let isMounted = true;
    const loadPedidoItems = async () => {
      if (!selectedPedido?.id) {
        if (isMounted) setSelectedPedidoItems([]);
        return;
      }
      setIsItemsLoading(true);
      try {
        const { data: items, error } = await supabase
          .from('itens_pedido')
          // `!fk_item_produto` é obrigatório: as migrations de tenancy criaram
          // uma segunda FK composta para `produtos`, e sem escolher uma delas o
          // PostgREST recusa a consulta inteira (PGRST201). Os itens do pedido
          // nunca carregavam por causa disso.
          .select('*, produto:produtos!fk_item_produto(*)')
          .eq('pedido_id', selectedPedido.id);

        if (error) throw error;
        if (isMounted) setSelectedPedidoItems(items || []);
      } catch (error) {
        console.error('Erro ao carregar itens do pedido:', error);
      } finally {
        if (isMounted) setIsItemsLoading(false);
      }
    };

    void loadPedidoItems();
    return () => {
      isMounted = false;
    };
  }, [selectedPedido]);

  useEffect(() => {
    let isMounted = true;
    if (activeTab === 'sac') {
      void (async () => {
        try {
          const { data: convs, error } = await supabase
            .from('chatwoot_conversations')
            .select('*')
            .order('updated_at', { ascending: false });

          if (!error && convs && isMounted) {
            setConversas(convs);
          }
        } catch {
          // Silencioso para evitar overlay
        }
      })();
    }
    return () => {
      isMounted = false;
    };
  }, [activeTab]);

  useEffect(() => {
    let isMounted = true;
    if (selectedConversa) {
      void (async () => {
        try {
          const { data: msgs, error } = await supabase
            .from('chatwoot_messages')
            .select('*')
            .eq('conversation_id', selectedConversa.id)
            .order('created_at', { ascending: true });

          if (!error && msgs && isMounted) {
            setMensagens(msgs);
          }
        } catch {
          // Silencioso para evitar overlay
        }
      })();
    }
    return () => {
      isMounted = false;
    };
  }, [selectedConversa]);

  // Realtime mensagens
  useEffect(() => {
    if (!selectedConversa) return;

    const channel = supabase
      .channel(`realtime-messages-${selectedConversa.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chatwoot_messages',
          filter: `conversation_id=eq.${selectedConversa.id}`,
        },
        (payload) => {
          const newMsg = payload.new as ChatwootMessage;
          setMensagens((prev) => {
            if (prev.some((m) => m.id === newMsg.id || (m.content === newMsg.content && Math.abs(new Date(m.created_at!).getTime() - new Date(newMsg.created_at!).getTime()) < 5000))) {
              return prev;
            }
            return [...prev, newMsg];
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [selectedConversa]);

  // Realtime conversas
  useEffect(() => {
    const channel = supabase
      .channel('realtime-conversations-list')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'chatwoot_conversations',
        },
        () => {
          loadConversations();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    // Verifica a sessão ativa real diretamente com o Supabase (respeitando a expiração JWT)
    supabase.auth.getSession().then(({ data: { session: supabaseSession }, error }) => {
      if (error || !supabaseSession) {
        setSession(null);
        localStorage.removeItem('haux_session');
      } else {
        const userDetails = deriveUserSession(supabaseSession.user);
        setSession(userDetails);
        localStorage.setItem('haux_session', JSON.stringify(userDetails));
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, supabaseSession) => {
      if (supabaseSession?.user) {
        const userDetails = deriveUserSession(supabaseSession.user);
        setSession(userDetails);
        localStorage.setItem('haux_session', JSON.stringify(userDetails));
      } else if (event === 'SIGNED_OUT') {
        setSession(null);
        localStorage.removeItem('haux_session');
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const updateSyncAgo = () => {
      if (!lastSyncDate) {
        setSyncAgoText('Não sincronizado');
        return;
      }
      const diffMs = Date.now() - lastSyncDate.getTime();
      const diffSecs = Math.floor(diffMs / 1000);
      const diffMins = Math.floor(diffSecs / 60);

      if (diffSecs < 10) {
        setSyncAgoText('Sincronizado agorinha');
      } else if (diffSecs < 60) {
        setSyncAgoText(`Sincronizado há ${diffSecs}s`);
      } else if (diffMins === 1) {
        setSyncAgoText('Sincronizado há 1 min');
      } else {
        setSyncAgoText(`Sincronizado há ${diffMins} mins`);
      }
    };

    updateSyncAgo();
    const interval = setInterval(updateSyncAgo, 10000);
    return () => clearInterval(interval);
  }, [lastSyncDate]);

  // Identidade estável, e não funções inline. O `StartupLoader` já não reinicia
  // por causa dos desfechos — ele os guarda numa referência —, mas passar função
  // nova a cada render o re-renderizaria à toa, e devolveria ao componente a
  // responsabilidade de se defender sozinho (revisão do head `d5a17c0`).
  const concluirStartup = useCallback(() => {
    encerrarStartup();
    void loadDashboardData();
  }, [encerrarStartup, loadDashboardData]);

  const reautenticarBling = useCallback(() => {
    encerrarStartup();
    setActiveTab('integrations');
  }, [encerrarStartup]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthLoading(true);

    const emailTrim = loginEmail.trim();
    const passwordTrim = loginPassword.trim();

    const isDevelopment = process.env.NODE_ENV !== 'production' ||
                          process.env.NEXT_PUBLIC_SUPABASE_URL === 'https://seu-projeto.supabase.co' ||
                          process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('placeholder');

    if (isDevelopment && emailTrim === 'admin' && passwordTrim === 'admin0') {
      // Sessão local de desenvolvimento: identidade sem vínculo, e portanto sem
      // controles de gestão. Ela nunca teve sessão real no Supabase, então as
      // APIs já a negavam — o que mudou é a tela parar de fingir o contrário.
      const devSession: UserSession = {
        email: 'admin@haux.com.br',
        name: 'Desenvolvedor ORBITA',
      };
      setSession(devSession);
      localStorage.setItem('haux_session', JSON.stringify(devSession));
      setAuthLoading(false);
      return;
    }

    if (isDevelopment && emailTrim === 'colaborador' && passwordTrim === 'haux123') {
      const workerSession: UserSession = {
        email: 'colaborador@haux.com.br',
        name: 'Colaborador Portal do Haux',
      };
      setSession(workerSession);
      localStorage.setItem('haux_session', JSON.stringify(workerSession));
      setAuthLoading(false);
      return;
    }

    try {
      const { data: authData, error } = await supabase.auth.signInWithPassword({
        email: emailTrim,
        password: passwordTrim
      });

      if (error) throw error;

      if (authData.user) {
        const userDetails: UserSession = deriveUserSession(authData.user);
        setSession(userDetails);
        localStorage.setItem('haux_session', JSON.stringify(userDetails));
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : 'Falha na autenticação. Verifique os dados.';
      setAuthError(errMsg);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    localStorage.removeItem('haux_session');
    setSession(null);
    await supabase.auth.signOut();
  };

  /**
   * Dispara a sincronização e acompanha o job durável até o fim.
   *
   * `POST /api/sync` responde `202` com `{ jobId, status }` desde o Ticket 12 —
   * ele **enfileira**, não conclui. A versão anterior lia `result.stats.pedidos`
   * dessa resposta; o acesso estourava `TypeError`, o `catch` genérico exibia
   * "Erro ao comunicar com o servidor", e a sincronização parecia quebrada
   * quando na verdade tinha sido aceita. `GET /api/sync/status`, que existe
   * desde o mesmo ticket, não tinha nenhum chamador.
   */
  const handleSync = async (completa = false) => {
    if (!podeGerir) {
      alert('Acesso negado: Somente quem administra a organização pode sincronizar dados do ERP.');
      return;
    }
    setIsSyncing(true);
    setSyncFeedback(null);

    try {
      const response = await fetchWithAuth(completa ? '/api/sync?completa=1' : '/api/sync', { method: 'POST' });
      const corpo = await response.json();

      if (!response.ok) {
        setSyncFeedback(`Erro (HTTP ${response.status}): ${corpo?.error ?? 'falha ao iniciar a sincronização'}`);
        return;
      }

      const aceito = syncEnqueueResponseSchema.safeParse(corpo);
      if (!aceito.success) {
        // Resposta com forma inesperada é problema de contrato, não de rede.
        setSyncFeedback('O servidor aceitou a sincronização mas respondeu num formato inesperado.');
        return;
      }

      setSyncFeedback('Sincronização iniciada...');
      const final = await acompanharSync(aceito.data.jobId, fetchWithAuth, setSyncFeedback);

      if (final === 'completed') {
        setLastSyncDate(new Date());
        loadDashboardData();
      }
    } catch (erro: unknown) {
      setSyncFeedback(`Erro de rede ao falar com o servidor: ${descreverErro(erro)}`);
    } finally {
      setIsSyncing(false);
      setTimeout(() => setSyncFeedback(null), 8000);
    }
  };

  const handleEmitNfe = async (pedidoId: string, blingPedidoId: string) => {
    if (!podeGerir) {
      alert('Acesso negado: Colaboradores não têm permissão para faturamento.');
      return;
    }
    setNfeLoadingId(pedidoId);
    try {
      const response = await fetchWithAuth('/api/nfe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pedidoId, blingPedidoId }),
      });
      const result = await response.json();
      if (result.success) {
        loadDashboardData();
        if (selectedPedido && selectedPedido.id === pedidoId) {
          setSelectedPedido(prev => prev ? { ...prev, status: 'Atendido', nfe: result.data } : null);
        }
      } else {
        alert(`Erro ao emitir NF-e: ${result.error}`);
      }
    } catch {
      alert('Erro de conexão ao emitir NF-e.');
    } finally {
      setNfeLoadingId(null);
    }
  };


  const handleOpenChatwootForPhone = (phone?: string) => {
    setActiveTab('sac');
    if (!phone) return;
    const cleanP = phone.replace(/\D/g, '').slice(-8);
    const targetConv = conversas.find((c) => {
      const cPhone = c.contact?.phone_number || '';
      return cPhone.replace(/\D/g, '').slice(-8) === cleanP;
    });
    if (targetConv) {
      setSelectedConversa(targetConv);
    }
  };

  if (!session) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 relative select-none overflow-hidden">
        <div className="absolute top-1/4 left-1/3 w-96 h-96 bg-[#5e1dad]/20 rounded-full blur-3xl animate-pulse-glow" />
        <div className="absolute bottom-1/4 right-1/3 w-96 h-96 bg-[#42a0ed]/20 rounded-full blur-3xl animate-pulse-glow" style={{ animationDelay: '1.5s' }} />

        <div className="w-full max-w-md space-y-8 z-10 perspective-1000">
          <div className="text-center space-y-4 animate-float">
            <div className="inline-flex h-20 w-20 items-center justify-center rounded-3xl glass-panel text-white shadow-2xl relative group border border-white/20">
              <OrbitaLogo className="h-10 w-10 animate-orbit-spin" />
              <div className="absolute -inset-2 rounded-3xl bg-gradient-to-r from-[#5e1dad] to-[#42a0ed] opacity-30 blur-md pointer-events-none group-hover:opacity-60 transition" />
            </div>
            <div>
              <h1 className="text-4xl font-extrabold tracking-tight text-gradient-orbital uppercase">ORBITA</h1>
              <p className="text-xs text-cyan-400/80 font-bold uppercase tracking-widest mt-1">Ecosistema ERP Bling & Chatwoot</p>
            </div>
          </div>

          <div className="glass-panel p-8 rounded-3xl space-y-6 border border-white/10 shadow-2xl relative">
            <div className="space-y-1">
              <h2 className="text-xl font-bold text-slate-100">
                {authMode === 'signin' ? 'Acesso Autenticado' : 'Criar conta na Órbita'}
              </h2>
              <p className="text-xs text-slate-400">
                {authMode === 'signin'
                  ? 'Entre com sua conta Supabase ou credenciais rápidas de dev.'
                  : 'Cadastre-se para começar. Você receberá um e-mail de confirmação.'}
              </p>
            </div>

            {authError && authMode === 'signin' && (
              <div className="p-3 bg-rose-500/15 border border-rose-500/30 text-rose-300 rounded-xl text-xs font-semibold flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" />
                <span>{authError}</span>
              </div>
            )}

            {authMode === 'signup' ? <RegisterForm /> : (
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs text-slate-300 font-semibold" htmlFor="email-input">E-mail / Usuário Dev</label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-400 pointer-events-none">
                    <Mail className="h-4 w-4" />
                  </span>
                  <input
                    id="email-input"
                    type="text"
                    required
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    placeholder="dev: admin | email@exemplo.com"
                    className="w-full pl-10 pr-4 py-3 rounded-xl glass-input text-sm outline-none transition"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-slate-300 font-semibold" htmlFor="password-input">Senha Credencial</label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-400 pointer-events-none">
                    <Lock className="h-4 w-4" />
                  </span>
                  <input
                    id="password-input"
                    type="password"
                    required
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder="dev: admin0 | sua senha"
                    className="w-full pl-10 pr-4 py-3 rounded-xl glass-input text-sm outline-none transition"
                  />
                </div>
              </div>

              <button
                id="btn-login-submit"
                type="submit"
                disabled={authLoading}
                className="w-full py-3.5 mt-2 rounded-xl glass-button-primary font-semibold text-sm cursor-pointer active:scale-95 transition flex items-center justify-center gap-2"
              >
                {authLoading ? (
                  <RefreshCw className="h-4 w-4 animate-spin text-white" />
                ) : (
                  <>
                    <span>Entrar na Órbita</span>
                    <ArrowRight className="h-4 w-4 text-white" />
                  </>
                )}
              </button>
            </form>
            )}

            <div className="pt-1 text-center text-xs text-slate-400">
              {authMode === 'signin' ? 'Ainda não tem conta?' : 'Já tem uma conta?'}{' '}
              <button
                id="btn-auth-mode-toggle"
                type="button"
                onClick={() => {
                  setAuthError(null);
                  setAuthMode((mode) => (mode === 'signin' ? 'signup' : 'signin'));
                }}
                className="font-semibold text-cyan-300 underline underline-offset-4 hover:text-cyan-200 active:scale-[0.97] transition cursor-pointer"
              >
                {authMode === 'signin' ? 'Criar conta' : 'Entrar'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <StartupLoader
        // A chave é a organização: trocar de organização **desmonta** o
        // carregador da anterior, então nenhum trabalho em curso dela chega
        // atrasado para decidir a tela da nova. O `encerrar` já recusa a
        // chamada de fora da organização atual; a chave fecha o caminho antes
        // dele (revisão do head `2d1795a`).
        key={organizacaoConfirmada ?? 'sem-organizacao'}
        isVisible={showStartupLoader}
        onComplete={concluirStartup}
        onNeedsAuth={reautenticarBling}
        fetchWithAuth={fetchWithAuth}
      />

      <AppWindow>
        {/* A navegação do produto, e a única. */}
        <Rail
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          session={session}
          onLogout={handleLogout}
        />

      {/* A coluna de conteúdo da janela, com as medidas do protótipo. */}
      <div className="orbita-conteudo">

        {/*
          A barra de ações do protótipo: à direita, compacta, uma linha só.
          Substituiu a faixa horizontal grande que existia aqui — ela mudava a
          geometria de toda a tela e não existe em mockup nenhum. O que ficou é
          o que precisa estar à mão de qualquer aba; navegar para Integrações,
          por exemplo, é papel do rail, não de um botão nesta barra.
        */}
        <div className="orbita-acoes">
          <OrganizacaoAtiva
            organizacoes={listaDeOrganizacoes.organizacoes}
            ativa={listaDeOrganizacoes.activeOrg}
            carregando={listaDeOrganizacoes.isLoading}
            trocandoParaId={listaDeOrganizacoes.switchingOrgId}
            onTrocar={listaDeOrganizacoes.handleSwitchOrganization}
          />

          <SeletorDeFundo fundo={fundo} onEscolher={escolherFundo} />

          {isOwner && (
            <>
              <button
                type="button"
                onClick={() => { void handleSync(false); }}
                disabled={isSyncing}
                className="orbita-acao"
                title={`Sincronizar o que mudou no Bling desde a última vez · ${syncAgoText}`}
              >
                <RefreshCw className={`h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`} />
                {isSyncing ? 'Sincronizando…' : 'Sincronizar Bling'}
                <span
                  className="w-[5px] h-[5px] rounded-full"
                  style={{ background: isSyncing ? 'var(--info)' : 'var(--accent)' }}
                  aria-hidden
                />
              </button>
              {/*
                Sincronização completa: relê tudo, ignorando o marcador de
                "última alteração". É a saída quando o marcador avançou sem que
                os dados tivessem sido realmente importados.
              */}
              <button
                type="button"
                onClick={() => { void handleSync(true); }}
                disabled={isSyncing}
                className="orbita-acao"
                title="Reler todo o catálogo do Bling, ignorando a data da última sincronização"
              >
                <RefreshCw className={`h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`} />
                Completa
              </button>
            </>
          )}

          {activeTab === 'sales' && (
            <button
              type="button"
              onClick={() => setIsManualOrderOpen(true)}
              className="orbita-acao"
              style={{ background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-fg)' }}
            >
              <Plus className="h-4 w-4" />
              Novo pedido manual
            </button>
          )}
        </div>

        {syncFeedback && (
          <div
            className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl text-xs font-semibold flex-none"
            style={{ background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--info)' }}
          >
            <span className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 shrink-0" aria-hidden />
              {syncFeedback}
            </span>
            <button
              type="button"
              onClick={() => setSyncFeedback(null)}
              aria-label="Fechar aviso de sincronização"
              style={{ color: 'var(--txt3)' }}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

      {/*
        A área de conteúdo. As telas migradas compõem a si mesmas e ocupam a
        altura toda — a tabela é que fica com o espaço que sobra, e não a
        página; as ainda não migradas continuam empilhando e rolando aqui.
      */}
      <main className={TELAS_QUE_OCUPAM_A_JANELA.has(activeTab)
        ? 'flex-1 min-h-0 flex flex-col'
        : 'flex-1 min-h-0 overflow-y-auto space-y-6 pr-1'}>

        {/* TAB FINANCEIRO */}
        <div className={activeTab === 'finance' ? 'flex flex-col flex-1 min-h-0' : 'hidden'}>
          <FinanceiroTab fetchWithAuth={fetchWithAuth} ativo={activeTab === 'finance'} pedidos={data?.pedidos ?? null} />
        </div>

        {/* TAB ORGANIZAÇÃO & MEMBROS (Ticket 06) */}
        <div className={activeTab === 'organization' ? 'flex flex-col flex-1 min-h-0' : 'hidden'}>
          <OrganizationPanel fetchWithAuth={fetchWithAuth} lista={listaDeOrganizacoes} />
        </div>

        {/* TAB INTEGRAÇÕES: Bling / Chatwoot (Ticket 24b) */}
        <div className={activeTab === 'integrations' ? 'block' : 'hidden'}>
          <IntegrationsPanel fetchWithAuth={fetchWithAuth} />
        </div>

        {/* TAB PLANO & FATURAMENTO (Ticket 24b) */}
        <div className={activeTab === 'billing' ? 'block' : 'hidden'}>
          {activeOrganizacaoId ? (
            <BillingPanel fetchWithAuth={fetchWithAuth} organizacaoId={activeOrganizacaoId} />
          ) : (
            <div className="text-sm text-slate-400">
              Abra a aba Organização para carregar a organização ativa antes de ver o plano.
            </div>
          )}
        </div>

        {/* TAB 1: DASHBOARD */}
        {activeTab === 'dashboard' && (
          <VisaoGeral
            dados={data}
            erroDeLeitura={erroDaLeitura}
            onRecarregar={() => { void loadDashboardData(); }}
          />
        )}


        {/* TAB 2: VENDAS & PEDIDOS */}
        {activeTab === 'sales' && (
          <VendasEPedidos
            pedidos={data?.pedidos ?? null}
            carregando={isLoading}
            erroDeLeitura={erroDaLeitura}
            onRecarregar={() => { void loadDashboardData(); }}
            organizacaoId={organizacaoConfirmada}
            ultimaSincronizacao={lastSyncDate}
            busca={searchQuery}
            onBuscaChange={setSearchQuery}
            onConversarNoWhatsapp={(telefone) => handleOpenChatwootForPhone(telefone)}
            onEmitirNfe={(pedido) => handleEmitNfe(pedido.id || '', pedido.bling_id || '')}
          />
        )}


        {/* TAB 3: ESTOQUE & PRODUTOS */}
        {activeTab === 'inventory' && (
          <EstoqueEProdutos
            produtos={data?.produtos ?? null}
            categorias={data?.categorias ?? []}
            carregando={isLoading}
            erroDeLeitura={erroDaLeitura}
            onRecarregar={() => { void loadDashboardData(); }}
            onAbrirProduto={handleOpenProductModal}
            onCadastrarProduto={() => {
              setSelectedProdutoModal(null);
              setIsProductModalOpen(true);
            }}
          />
        )}

        {/* TAB 4: CLIENTES & CONTATOS */}
        {activeTab === 'contacts' && (
          <ClientesEContatos
            clientes={clientesDoPainel}
            carregando={isLoading}
            erroDeLeitura={erroDaLeitura}
            onRecarregar={() => { void loadDashboardData(); }}
            onAbrirCliente={(cliente) => {
              setSelectedClienteModal(cliente);
              setIsClienteModalOpen(true);
            }}
            onCadastrarCliente={() => {
              setSelectedClienteToEdit(null);
              setIsClienteEditOpen(true);
            }}
          />
        )}

        {/* TAB 5: SAC OMNICHANNEL (CHATWOOT RECREATED) */}
        {activeTab === 'sac' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-[720px]">

            {/* Conversation List Sidebar */}
            <div className="lg:col-span-4 glass-panel rounded-3xl border border-white/10 flex flex-col overflow-hidden">
              <div className="p-4 border-b border-white/10 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <MessageCircle className="h-5 w-5 text-cyan-400" />
                    <h3 className="text-sm font-bold text-white uppercase tracking-wider">Atendimento SAC</h3>
                  </div>
                  <button
                    onClick={handleSyncChatwoot}
                    disabled={isSyncingChatwoot}
                    className="p-2 rounded-xl glass-button-secondary text-cyan-300 hover:text-white"
                    title={chatwootFeedback ?? 'Sincronizar conversas'}
                  >
                    <RefreshCw className={`h-4 w-4 ${isSyncingChatwoot ? 'animate-spin' : ''}`} />
                  </button>
                </div>

                {chatwootFeedback && (
                  <p className="text-[11px] text-cyan-300/80 px-1">{chatwootFeedback}</p>
                )}

                {/* Search Box */}
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Buscar cliente..."
                    value={conversaSearch}
                    onChange={(e) => setConversaSearch(e.target.value)}
                    className="w-full pl-9 pr-3 py-1.5 rounded-xl glass-input text-xs outline-none"
                  />
                </div>

                {/* Filter Tabs */}
                <div className="flex gap-1.5 p-1 rounded-xl glass-panel border border-white/10">
                  <button
                    onClick={() => setConversaFilter('open')}
                    className={`flex-1 py-1 rounded-lg text-[10px] font-bold transition ${conversaFilter === 'open' ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30' : 'text-slate-400'}`}
                  >
                    Abertos ({conversas.filter(c => c.status === 'open').length})
                  </button>
                  <button
                    onClick={() => setConversaFilter('resolved')}
                    className={`flex-1 py-1 rounded-lg text-[10px] font-bold transition ${conversaFilter === 'resolved' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'text-slate-400'}`}
                  >
                    Resolvidos
                  </button>
                  <button
                    onClick={() => setConversaFilter('all')}
                    className={`flex-1 py-1 rounded-lg text-[10px] font-bold transition ${conversaFilter === 'all' ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' : 'text-slate-400'}`}
                  >
                    Todos
                  </button>
                </div>
              </div>

              {/* Conversations List */}
              <div className="flex-1 overflow-y-auto divide-y divide-white/5">
                {conversas.filter(c => {
                  if (conversaFilter !== 'all' && c.status !== conversaFilter) return false;
                  if (conversaSearch.trim()) {
                    const q = conversaSearch.toLowerCase();
                    return c.contact?.name?.toLowerCase().includes(q) || c.contact?.phone_number?.includes(q);
                  }
                  return true;
                }).map((conversa) => (
                  <button
                    type="button"
                    key={conversa.id}
                    onClick={() => setSelectedConversa(conversa)}
                    className={`w-full p-3.5 hover:bg-white/5 cursor-pointer transition flex items-center gap-3 text-left ${selectedConversa?.id === conversa.id ? 'bg-cyan-500/10 border-l-4 border-cyan-400' : ''}`}
                  >
                    <div className="h-10 w-10 rounded-2xl glass-panel flex items-center justify-center font-bold text-cyan-300 border border-cyan-500/30 shrink-0">
                      {conversa.contact?.name ? conversa.contact.name.substring(0, 2).toUpperCase() : 'SAC'}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-bold text-white truncate">{conversa.contact?.name || 'Cliente Whatsapp'}</p>
                        <span className="text-[10px] text-slate-400 font-mono">
                          {conversa.updated_at ? new Date(conversa.updated_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 truncate mt-0.5">{conversa.contact?.phone_number || 'Sem número'}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Active Chat Window */}
            <div className="lg:col-span-8 glass-panel rounded-3xl border border-white/10 flex flex-col overflow-hidden">
              {selectedConversa ? (
                <>
                  {/* Chat Header */}
                  <div className="p-4 border-b border-white/10 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-2xl glass-panel flex items-center justify-center font-bold text-purple-300 border border-purple-500/30 glow-purple">
                        {selectedConversa.contact?.name ? selectedConversa.contact.name.substring(0, 2).toUpperCase() : 'SAC'}
                      </div>
                      <div>
                        <h4 className="text-sm font-bold text-white">{selectedConversa.contact?.name || 'Cliente'}</h4>
                        <p className="text-xs text-slate-400">{selectedConversa.contact?.phone_number || selectedConversa.contact?.email}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <button
                        onClick={handleToggleConversaStatus}
                        disabled={isChangingStatus}
                        className={`px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 cursor-pointer ${
                          selectedConversa.status === 'open'
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 glow-emerald'
                            : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                        }`}
                      >
                        <CheckCircle className="h-3.5 w-3.5" />
                        <span>{selectedConversa.status === 'open' ? 'Marcar Resolvido' : 'Reabrir Conversa'}</span>
                      </button>
                    </div>
                  </div>

                  {/* Messages Content */}
                  <div className="flex-1 p-6 overflow-y-auto space-y-4">
                    {mensagens.map((msg, idx) => {
                      const isOutgoing = msg.message_type === 'outgoing' || msg.sender_name === 'Você';
                      return (
                        <div
                          key={idx}
                          className={`flex flex-col ${isOutgoing ? 'items-end' : 'items-start'}`}
                        >
                          <div
                            className={`max-w-md p-3.5 rounded-2xl text-xs space-y-1 ${
                              isOutgoing
                                ? 'glass-button-primary text-white rounded-br-none shadow-lg'
                                : 'glass-panel text-slate-100 border border-white/10 rounded-bl-none'
                            }`}
                          >
                            <p className="font-semibold text-[10px] opacity-70">{isOutgoing ? 'Você' : (msg.sender_name || 'Cliente')}</p>
                            <p className="leading-relaxed">{msg.content}</p>
                            <span className="text-[9px] opacity-60 text-right block font-mono">
                              {msg.created_at ? new Date(msg.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Send Message Input */}
                  <form onSubmit={handleSendChatMessage} className="p-4 border-t border-white/10 flex items-center gap-3">
                    <input
                      type="text"
                      placeholder="Digite sua resposta em tempo real..."
                      value={newMessageContent}
                      onChange={(e) => setNewMessageContent(e.target.value)}
                      className="flex-1 px-4 py-3 rounded-2xl glass-input text-xs outline-none"
                    />
                    <button
                      type="submit"
                      disabled={isSendingMessage || !newMessageContent.trim()}
                      className="px-5 py-3 rounded-2xl glass-button-primary text-xs font-bold flex items-center gap-2 cursor-pointer active:scale-95 transition"
                    >
                      <Send className="h-4 w-4" />
                      <span className="hidden sm:inline">Enviar</span>
                    </button>
                  </form>
                </>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-3">
                  <div className="h-16 w-16 rounded-3xl glass-panel flex items-center justify-center text-cyan-400 border border-cyan-500/30 glow-cyan animate-float">
                    <MessageSquare className="h-8 w-8" />
                  </div>
                  <h4 className="text-base font-bold text-white">Selecione um Atendimento</h4>
                  <p className="text-xs text-slate-400 max-w-sm">
                    Escolha uma conversa na lista à esquerda para interagir com seus clientes e visualizar integrações com o Bling.
                  </p>
                </div>
              )}
            </div>

          </div>
        )}

      </main>
      </div>
      </AppWindow>

      {/* PEDIDO DETAILS MODAL (GLASSMORPHISM SPATIAL POPUP) */}
      {selectedPedido && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-fade-in">
          <div className="w-full max-w-2xl glass-panel p-6 rounded-3xl border border-white/15 space-y-5 shadow-2xl relative max-h-[90vh] overflow-y-auto">

            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/10 pb-4">
              <div>
                <h3 className="text-lg font-black text-white tracking-tight">Pedido #SO-{selectedPedido.numero}</h3>
                <p className="text-xs text-slate-400">Data: {new Date(selectedPedido.data).toLocaleDateString('pt-BR')}</p>
              </div>

              <button
                onClick={() => setSelectedPedido(null)}
                className="p-2 rounded-xl glass-button-secondary text-slate-400 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Client Info */}
            <div className="glass-card p-4 rounded-2xl border border-white/10 space-y-2 text-xs">
              <h4 className="font-bold text-cyan-300 uppercase tracking-wider">Dados do Cliente</h4>
              <p><span className="text-slate-400 font-semibold">Nome:</span> {selectedPedido.cliente?.nome || 'Consumidor Final'}</p>
              <p><span className="text-slate-400 font-semibold">E-mail:</span> {selectedPedido.cliente?.email || '-'}</p>
              <p><span className="text-slate-400 font-semibold">Telefone:</span> {selectedPedido.cliente?.telefone || '-'}</p>
            </div>

            {/* Items Table */}
            <div className="space-y-2">
              <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider">Itens do Pedido</h4>
              {isItemsLoading ? (
                <div className="py-6 text-center text-xs text-slate-400 flex items-center justify-center gap-2">
                  <RefreshCw className="h-4 w-4 animate-spin text-purple-400" />
                  <span>Carregando itens...</span>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-2xl border border-white/10 glass-card">
                  <table className="w-full text-left text-xs text-slate-300">
                    <thead>
                      <tr className="border-b border-white/10 text-slate-400 uppercase text-[9px] tracking-wider">
                        <th className="py-2.5 px-3">Produto</th>
                        <th className="py-2.5 px-3 text-center">Qtd</th>
                        <th className="py-2.5 px-3 text-right">Valor Un.</th>
                        <th className="py-2.5 px-3 text-right">Subtotal</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {selectedPedidoItems.map((item, idx) => (
                        <tr key={idx}>
                          <td className="py-2.5 px-3 font-semibold text-white">{item.produto?.nome || 'Item do Pedido'}</td>
                          <td className="py-2.5 px-3 text-center font-mono text-cyan-300">{item.quantidade}</td>
                          <td className="py-2.5 px-3 text-right text-slate-300">R$ {Number(item.valor_unitario).toFixed(2)}</td>
                          <td className="py-2.5 px-3 text-right font-bold text-emerald-400">R$ {(item.quantidade * item.valor_unitario).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Total Footer */}
            <div className="pt-4 border-t border-white/10 flex items-center justify-between">
              <div>
                <span className="text-xs text-slate-400 font-semibold">Valor Total do Pedido</span>
                <h3 className="text-xl font-black text-emerald-400">R$ {Number(selectedPedido.total).toFixed(2)}</h3>
              </div>

              {selectedPedido.status === 'Pendente' && isOwner && (
                <button
                  onClick={() => handleEmitNfe(selectedPedido.id || '', selectedPedido.bling_id || '')}
                  disabled={nfeLoadingId === selectedPedido.id}
                  className="px-5 py-2.5 rounded-xl glass-button-primary text-xs font-bold flex items-center gap-2 cursor-pointer"
                >
                  {nfeLoadingId === selectedPedido.id ? (
                    <RefreshCw className="h-4 w-4 animate-spin text-white" />
                  ) : (
                    <>
                      <FileText className="h-4 w-4 text-white" />
                      <span>Emitir Nota Fiscal (NF-e)</span>
                    </>
                  )}
                </button>
              )}
            </div>

          </div>
        </div>
      )}

      {/* Modal de Detalhes do Produto & Cliente */}
      <ProductDetailModal
        isOpen={isProductModalOpen}
        onClose={() => setIsProductModalOpen(false)}
        produto={selectedProdutoModal}
        cliente={
          data?.clientes?.[0] ||
          data?.pedidos?.find(p => p.itens?.some(i => i.produto_id === selectedProdutoModal?.id))?.cliente ||
          null
        }
        onSave={(updated) => {
          painel.atualizarDados((anterior) => ({
            ...anterior,
            produtos: anterior.produtos.map((p) => (p.id === updated.id || p.bling_id === updated.bling_id) ? updated : p),
          }));
        }}
        onOpenChatwoot={handleOpenChatwootForPhone}
      />

      <ClienteDetailModal
        isOpen={isClienteModalOpen}
        onClose={() => setIsClienteModalOpen(false)}
        cliente={selectedClienteModal}
        onOpenChatwoot={() => {
          setActiveTab('sac');
        }}
        onEdit={(cliente) => {
          // O `ClienteEditModal` já sabia editar um contato existente, e
          // `selectedClienteToEdit` já existia — só que nada nunca o preenchia,
          // então a edição não tinha por onde ser aberta. A ação primária do
          // detalhe é o caminho que faltava; nenhuma rota nova, nenhum campo
          // novo.
          //
          // `onDelete` continua deliberadamente sem ser passado: a composição
          // anterior também não o passava, e ligá-lo agora seria estrear um
          // fluxo destrutivo, não preservar um. Ver o cabeçalho de
          // `ClienteDetailModal`.
          setIsClienteModalOpen(false);
          setSelectedClienteToEdit(cliente);
          setIsClienteEditOpen(true);
        }}
      />

      {/* Modal de Incluir Pedido Manual */}
      <ManualOrderModal
        open={isManualOrderOpen}
        onOpenChange={setIsManualOrderOpen}
        onSuccess={loadDashboardData}
        organizacaoId={organizacaoConfirmada}
      />

      {/* Modal de Cadastrar / Editar Contato */}
      <ClienteEditModal
        isOpen={isClienteEditOpen}
        onClose={() => setIsClienteEditOpen(false)}
        cliente={selectedClienteToEdit}
        onSave={() => loadDashboardData()}
      />

    </>
  );
}
