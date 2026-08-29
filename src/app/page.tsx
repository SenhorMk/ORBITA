'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import {
  DollarSign,
  TrendingUp,
  ShoppingBag,
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
  User,
  Key,
  LogOut,
  ChevronRight,
  Search,
  Box,
  Percent,
  RefreshCw,
  X,
  Activity,
  Package,
  Image as ImageIcon,
  Plus,
} from "lucide-react";
import type { Produto, Cliente, Categoria, ChatwootConversation, ChatwootMessage, ItemPedido } from '@/types';
import { supabase } from '@/lib/supabaseClient';
import type { User as SupabaseUser } from '@supabase/supabase-js';
import { PedidoEnriquecido } from '@/repositories/pedidoRepository';
import { SetupWizard } from '@/components/SetupWizard';
import { Sidebar } from '@/components/Sidebar';
import { GradientMenu } from '@/components/GradientMenu';
import { TransactionList } from '@/components/TransactionList';
import { HealthMonitor } from '@/components/HealthMonitor';
import { BudgetCard } from '@/components/ui/analytics-bento';
import { List2 } from "@/components/ui/list-2";
import TableWithDialog from "@/components/ui/table-with-dialog";
import { ClienteDetailModal } from '@/components/ClienteDetailModal';
import { ProductDetailModal } from '@/components/ProductDetailModal';
import { ClienteEditModal } from '@/components/ClienteEditModal';
import { ManualOrderModal } from '@/components/ManualOrderModal';
import { isProdutoSynced, validateProdutoForBling } from '@/lib/utils';
import { StartupLoader } from '@/components/StartupLoader';
import { FinanceiroTab } from '@/components/FinanceiroTab';
import { RegisterForm } from '@/components/auth/RegisterForm';
import { OrganizationPanel } from '@/components/organizacao/OrganizationPanel';
import { IntegrationsPanel } from '@/components/integracoes/IntegrationsPanel';
import { BillingPanel } from '@/components/billing/BillingPanel';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from '@/components/ui/dialog';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { format, subDays, isAfter, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';

// Tipo de Usuário Logado
interface UserSession {
  email: string;
  role: 'dono' | 'colaborador';
  name: string;
}

/** Deriva a sessão de usuário Orbita a partir de um usuário autenticado do Supabase. */
function deriveUserSession(user: SupabaseUser): UserSession {
  const isOwner = user.app_metadata?.role === 'dono' ||
    user.email?.includes('dono') ||
    user.email === 'admin@haux.com.br';
  return {
    email: user.email || '',
    name: user.user_metadata?.full_name || user.email?.split('@')[0] || 'Usuário',
    role: isOwner ? 'dono' : 'colaborador',
  };
}

/** Search box bound to the shared `searchQuery` state, reused across the top nav and the sales tab. */
function SearchQueryInput({
  containerClassName,
  iconClassName,
  inputClassName,
  placeholder,
  value,
  onChange,
}: {
  containerClassName: string;
  iconClassName: string;
  inputClassName: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className={containerClassName}>
      <Search className={iconClassName} />
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={inputClassName}
      />
    </div>
  );
}

/** Rounded product thumbnail used in both the synced and unsynced product lists. */
function ProductThumbnail({
  produto,
  imageUrl,
  variant,
}: {
  produto: Produto;
  imageUrl: string | undefined;
  variant: 'synced' | 'unsynced';
}) {
  const isSynced = variant === 'synced';
  return (
    <div
      className={`relative h-12 w-12 shrink-0 flex items-center justify-center rounded-xl overflow-hidden border bg-black/40 shadow-inner ${
        isSynced ? 'border-white/15' : 'border-amber-500/30'
      }`}
    >
      <ImageIcon
        className={`absolute h-5 w-5 z-0 ${
          isSynced ? 'text-purple-400 opacity-60' : 'text-amber-500 opacity-50'
        }`}
      />
      {imageUrl && (
        <Image
          src={imageUrl}
          alt={produto.nome}
          width={48}
          height={48}
          unoptimized
          className={`h-full w-full object-cover relative z-10 ${isSynced ? '' : 'opacity-70'}`}
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
        />
      )}
    </div>
  );
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
  const isOwner = session?.role === 'dono';
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [selectedProdutoModal, setSelectedProdutoModal] = useState<Produto | null>(null);
  const [isProductModalOpen, setIsProductModalOpen] = useState(false);
  const [selectedClienteModal, setSelectedClienteModal] = useState<Cliente | null>(null);
  const [isClienteModalOpen, setIsClienteModalOpen] = useState(false);
  const [showStartupLoader, setShowStartupLoader] = useState(false);
  const [hasStartedUp, setHasStartedUp] = useState(false);

  const handleOpenProductModal = (produto: Produto) => {
    setSelectedProdutoModal(produto);
    setIsProductModalOpen(true);
  };

  // Navegação do Painel (Abas)
  const [activeTab, setActiveTab] = useState<
    'dashboard' | 'sales' | 'inventory' | 'contacts' | 'finance' | 'sac' | 'chats' | 'organization' | 'integrations' | 'billing'
  >('dashboard');

  // Organização ativa (Ticket 24b): resolvida pelo servidor via OrganizationPanel,
  // nunca escolhida localmente. Usada apenas para escopar a leitura de plano/limites.
  const [activeOrganizacaoId, setActiveOrganizacaoId] = useState<string | null>(null);

  // Estados para filtros e ordenação na aba Vendas
  const [filterDays, setFilterDays] = useState<string>('all');
  const [sortBy, setSortBy] = useState('recent');

  // Estados dos Modais Interativos do Dashboard
  const [faturamentoPeriod, setFaturamentoPeriod] = useState<'7' | '30' | '180' | '365' | 'all'>('30');
  const [novosPedidosTab, setNovosPedidosTab] = useState<'Novo' | 'Aberto' | 'Em Processamento' | 'Despachado' | 'Enviado'>('Novo');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Estados do Dashboard
  const [data, setData] = useState<{
    pedidos: PedidoEnriquecido[];
    produtos: Produto[];
    clientes: Cliente[];
    categorias?: Categoria[];
    estatisticas: {
      faturamento30Dias: number;
      totalPedidos: number;
      pendentes: number;
      cancelados: number;
      atendidos: number;
    }
  } | null>(null);

  const [isLoading, setIsLoading] = useState(true);
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

  // Estados Locais para Filtros da aba Inventário

  const [inventorySearch, setInventorySearch] = useState('');
  const [inventoryCategory, setInventoryCategory] = useState('all');
  const [inventoryMinPrice, setInventoryMinPrice] = useState('');
  const [inventoryMaxPrice, setInventoryMaxPrice] = useState('');
  const [inventoryStatus, setInventoryStatus] = useState<'all' | 'active' | 'inactive'>('all');

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
  const fetchWithAuth = useCallback(async (url: string, options: RequestInit = {}) => {
    let token = '';

    try {
      const { data } = await supabase.auth.getSession();
      token = data.session?.access_token || '';
    } catch (error) {
      console.error('Erro ao buscar token do supabase no fetchWithAuth:', error);
    }

    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string> | undefined),
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    return fetch(url, {
      ...options,
      headers,
    });
  }, []);

  // Resolver de imagem do produto
  const getProductImage = (produto: Produto): string | undefined => {
    return produto.imagem_url;
  };

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
          .select('*, produto:produtos(*)')
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
    if (activeTab === 'chats' || activeTab === 'sac') {
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

  const loadDashboardData = useCallback(async () => {
    try {
      // Verificar se as APIs estão conectadas
      const configRes = await fetchWithAuth('/api/config');
      const configData = await configRes.json();
      if (configData.success && configData.config && !configData.config.bling.isConnected) {
        setIsWizardOpen(true);
      }

      const response = await fetchWithAuth('/api/dashboard');
      const result = await response.json();
      if (result.success) {
        setData(result.data);
      }
    } catch (error) {
      console.error('Erro ao carregar dados do dashboard:', error);
    } finally {
      setIsLoading(false);
    }
  }, [fetchWithAuth]);

  useEffect(() => {
    let isMounted = true;
    void (async () => {
      if (session) {
        await loadDashboardData();
      }
    })();
    const interval = setInterval(() => {
      if (isMounted && session) {
        void loadDashboardData();
      }
    }, 30000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [session, loadDashboardData]);

  useEffect(() => {
    if (session?.role === 'dono' && !hasStartedUp) {
      const timer = setTimeout(() => {
        setShowStartupLoader(true);
        setHasStartedUp(true);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [session, hasStartedUp]);

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
      const devSession: UserSession = {
        email: 'admin@haux.com.br',
        name: 'Desenvolvedor ORBITA',
        role: 'dono'
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
        role: 'colaborador'
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
        const isOwner = authData.user.app_metadata?.role === 'dono' ||
                        authData.user.email?.includes('dono') ||
                        authData.user.email === 'admin@haux.com.br';
        const userDetails: UserSession = {
          email: authData.user.email || '',
          name: authData.user.user_metadata?.full_name || authData.user.email?.split('@')[0] || 'Usuário',
          role: isOwner ? 'dono' : 'colaborador'
        };
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

  const handleSync = async () => {
    if (session?.role !== 'dono') {
      alert('Acesso negado: Somente o dono da loja pode sincronizar dados do ERP.');
      return;
    }
    setIsSyncing(true);
    setSyncFeedback(null);
    try {
      const response = await fetchWithAuth('/api/sync', { method: 'POST' });
      const result = await response.json();
      if (result.success) {
        setSyncFeedback(`Sincronizado! +${result.stats.pedidos} pedidos, +${result.stats.produtos || 0} produtos, +${result.stats.clientes} clientes.`);
        setLastSyncDate(new Date());
        loadDashboardData();
      } else {
        setSyncFeedback(`Erro: ${result.error}`);
      }
    } catch {
      setSyncFeedback('Erro ao comunicar com o servidor.');
    } finally {
      setIsSyncing(false);
      setTimeout(() => setSyncFeedback(null), 5000);
    }
  };

  const handleEmitNfe = async (pedidoId: string, blingPedidoId: string) => {
    if (session?.role !== 'dono') {
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

  const [currentDateBaseline] = useState(() => Date.now());

  const getFilteredAndSortedPedidos = () => {
    if (!data?.pedidos) return [];

    let filtered = [...data.pedidos];

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(p =>
        p.numero.toLowerCase().includes(query) ||
        (p.cliente?.nome && p.cliente.nome.toLowerCase().includes(query)) ||
        (p.status && p.status.toLowerCase().includes(query))
      );
    }

    if (filterDays !== 'all') {
      const days = parseInt(filterDays, 10);
      const limitTime = currentDateBaseline - days * 24 * 60 * 60 * 1000;
      filtered = filtered.filter(p => new Date(p.data).getTime() >= limitTime);
    }

    if (sortBy === 'recent') {
      filtered.sort((a, b) => new Date(b.data).getTime() - new Date(a.data).getTime());
    } else if (sortBy === 'old') {
      filtered.sort((a, b) => new Date(a.data).getTime() - new Date(b.data).getTime());
    } else if (sortBy === 'highest') {
      filtered.sort((a, b) => Number(b.total) - Number(a.total));
    }

    return filtered;
  };

  const getWeeklySalesData = () => {
    const daysMap: { [key: string]: number } = {
      'Dom': 0, 'Seg': 0, 'Ter': 0, 'Qua': 0, 'Qui': 0, 'Sex': 0, 'Sáb': 0
    };
    const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

    if (data?.pedidos) {
      data.pedidos.forEach(p => {
        const d = new Date(p.data);
        const dayName = dayNames[d.getDay()];
        if (dayName && daysMap[dayName] !== undefined) {
          daysMap[dayName] += Number(p.total || 0);
        }
      });
    }

    return Object.keys(daysMap).map(day => ({
      day,
      value: daysMap[day]
    }));
  };

  const totalVendidoMesAtual = data?.estatisticas.faturamento30Dias || 0;
  const faturamentoMesAnterior = 12500;
  const variacaoFaturamento = totalVendidoMesAtual > 0
    ? ((totalVendidoMesAtual - faturamentoMesAnterior) / faturamentoMesAnterior) * 100
    : 0;
  const lucroEstimado = totalVendidoMesAtual * 0.42;

  const getFaturamentoChartData = () => {
    if (!data?.pedidos) return [];
    let filtered = data.pedidos;
    const now = new Date();

    if (faturamentoPeriod !== 'all') {
      const days = parseInt(faturamentoPeriod);
      const cutoff = subDays(now, days);
      filtered = filtered.filter(p => isAfter(parseISO(p.data), cutoff));
    }

    const grouped = filtered.reduce((acc, pedido) => {
      const dateKey = format(parseISO(pedido.data), 'yyyy-MM-dd');
      if (!acc[dateKey]) acc[dateKey] = 0;
      acc[dateKey] += Number(pedido.total || 0);
      return acc;
    }, {} as Record<string, number>);

    return Object.entries(grouped)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, total]) => ({
        date: format(parseISO(date), 'dd MMM', { locale: ptBR }),
        faturamento: total
      }));
  };

  const lucroDetalhes = () => {
    const revenue = totalVendidoMesAtual;
    const cost = revenue * 0.58;
    const profit = revenue * 0.42;
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const currentDay = now.getDate();
    const dailyAverage = currentDay > 0 ? profit / currentDay : 0;
    const projectedProfit = dailyAverage * daysInMonth;

    return { revenue, cost, profit, projectedProfit };
  };

  const pedidosNfePendente = data?.pedidos?.filter(p => p.status === 'A Emitir' || !p.nfe) || [];
  const novosPedidosFluxo = data?.pedidos?.filter(p => p.status === novosPedidosTab) || [];
  const filteredPedidosList = getFilteredAndSortedPedidos();

  const handleOpenChatwootForPhone = (phone?: string) => {
    setActiveTab('chats');
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
    <div className="min-h-screen flex font-sans select-none bg-[#0d0818] text-slate-100">

      <StartupLoader
        isVisible={showStartupLoader}
        onComplete={() => {
          setShowStartupLoader(false);
          loadDashboardData();
        }}
        onNeedsAuth={() => {
          setShowStartupLoader(false);
          setIsWizardOpen(true);
        }}
        fetchWithAuth={fetchWithAuth}
      />

      {/* Retractable Motion Glass Sidebar */}
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        session={session}
        onOpenSetup={() => setIsWizardOpen(true)}
        onLogout={handleLogout}
        badges={{
          sales: data?.pedidos?.length,
          chats: conversas?.filter(c => c.status === 'open')?.length
        }}
      />

      {/* Main Content Area Right */}
      <div className="flex-1 flex flex-col min-w-0 h-screen overflow-y-auto">
        {/* SPATIAL TOPBAR */}
        <header className="sticky top-0 z-30 glass-panel border-b border-white/10 px-6 py-3.5 backdrop-blur-xl">
          <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">

            {/* Health Monitor & Search */}
            <div className="flex items-center gap-4">
              <HealthMonitor
                supabaseConnected={true}
                blingConnected={true}
                chatwootConnected={true}
                onRefresh={loadDashboardData}
              />

              <SearchQueryInput
                containerClassName="relative w-64 hidden sm:block"
                iconClassName="absolute left-3 top-2.5 h-4 w-4 text-slate-400"
                inputClassName="w-full pl-9 pr-3 py-1.5 rounded-full glass-input text-xs outline-none"
                placeholder="Pesquisar no sistema..."
                value={searchQuery}
                onChange={setSearchQuery}
              />
            </div>

            {/* Sync Status Badge & Actions */}
            <div className="flex items-center gap-3">

              {isOwner && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsWizardOpen(true)}
                    className="px-3 py-2 rounded-xl bg-purple-600/30 hover:bg-purple-600/50 border border-purple-500/40 text-purple-200 text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
                    title="Configurar credenciais reais do Bling ERP e Chatwoot"
                  >
                    <Key className="h-3.5 w-3.5 text-purple-400" />
                    <span className="hidden md:inline">Configurar APIs</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleSync}
                    disabled={isSyncing}
                    className="px-3.5 py-2 rounded-xl glass-button-primary text-xs font-bold flex items-center gap-2 cursor-pointer active:scale-95 transition"
                    title={`Sincronizar pedidos e clientes do Bling ERP · ${syncAgoText}`}
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                    <span className="hidden sm:inline">{isSyncing ? 'Sincronizando...' : 'Sincronizar Bling'}</span>
                  </button>
                </div>
              )}

              <button
                type="button"
                onClick={handleLogout}
                className="p-2 rounded-xl glass-button-secondary text-slate-300 hover:text-rose-400 transition cursor-pointer"
                title="Sair da sessão"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        </header>

      {/* Sync Feedback Toast */}
      {syncFeedback && (
        <div className="max-w-7xl mx-auto w-full px-6 pt-4">
          <div className="p-3.5 rounded-2xl glass-panel border border-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center justify-between glow-cyan animate-float">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-cyan-400 shrink-0 animate-spin" />
              <span>{syncFeedback}</span>
            </div>
            <button onClick={() => setSyncFeedback(null)} className="text-slate-400 hover:text-white">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* MAIN CONTAINER */}
      <main className="max-w-7xl mx-auto w-full px-6 pt-6 flex-1 space-y-6">

        {/* SPATIAL TAB NAVIGATION BAR */}
        <div className="glass-panel p-1.5 rounded-2xl border border-white/10 flex items-center gap-1.5 overflow-x-auto no-scrollbar shadow-xl">
          <button
            onClick={() => setActiveTab('dashboard')}
            className={`px-4 py-2.5 rounded-xl text-xs font-bold transition flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === 'dashboard'
                ? 'glass-button-primary text-white shadow-lg'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
            }`}
          >
            <TrendingUp className="h-4 w-4" />
            <span>Dashboard</span>
          </button>

          <button
            onClick={() => setActiveTab('sales')}
            className={`px-4 py-2.5 rounded-xl text-xs font-bold transition flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === 'sales'
                ? 'glass-button-primary text-white shadow-lg'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
            }`}
          >
            <ShoppingBag className="h-4 w-4" />
            <span>Vendas & Pedidos</span>
            {data?.pedidos && (
              <span className="px-2 py-0.5 rounded-full text-[10px] bg-white/20 text-white font-mono">
                {data.pedidos.length}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('inventory')}
            className={`px-4 py-2.5 rounded-xl text-xs font-bold transition flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === 'inventory'
                ? 'glass-button-primary text-white shadow-lg'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
            }`}
          >
            <Box className="h-4 w-4" />
            <span>Estoque & Produtos</span>
          </button>

          <button
            onClick={() => setActiveTab('contacts')}
            className={`px-4 py-2.5 rounded-xl text-xs font-bold transition flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === 'contacts'
                ? 'glass-button-primary text-white shadow-lg'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
            }`}
          >
            <User className="h-4 w-4" />
            <span>Clientes & Contatos</span>
          </button>

          <button
            onClick={() => setActiveTab('sac')}
            className={`px-4 py-2.5 rounded-xl text-xs font-bold transition flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === 'sac' || activeTab === 'chats'
                ? 'glass-button-primary text-white shadow-lg'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
            }`}
          >
            <MessageSquare className="h-4 w-4 text-cyan-400" />
            <span>SAC Omnichannel</span>
            {conversas.length > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] bg-cyan-500/30 text-cyan-300 font-mono border border-cyan-500/40">
                {conversas.filter(c => c.status === 'open').length}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('finance')}
            className={`px-4 py-2.5 rounded-xl text-xs font-bold transition flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === 'finance'
                ? 'glass-button-primary text-white shadow-lg'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
            }`}
          >
            <DollarSign className="h-4 w-4 text-[#FFD60A]" />
            <span>Financeiro</span>
          </button>
        </div>

        {/* TAB FINANCEIRO */}
        <div className={activeTab === 'finance' ? 'block' : 'hidden'}>
          <FinanceiroTab fetchWithAuth={fetchWithAuth} />
        </div>

        {/* TAB ORGANIZAÇÃO & MEMBROS (Ticket 24b) */}
        <div className={activeTab === 'organization' ? 'block' : 'hidden'}>
          <OrganizationPanel fetchWithAuth={fetchWithAuth} onActiveOrgChange={setActiveOrganizacaoId} />
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
          <div className="space-y-6">

            {/* SPATIAL METRIC CARDS 3D GRID */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">

              {/* Card 1: Faturamento Mês Atual */}
              <Dialog>
                <DialogTrigger asChild>
                  <button aria-label="Ver detalhes de Faturamento dos últimos 30 dias" className="text-left w-full glass-card glass-card-hover p-5 rounded-3xl border border-white/10 relative overflow-hidden group">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Faturamento (30d)</span>
                      <div className="h-10 w-10 rounded-2xl glass-panel flex items-center justify-center text-[#F0E675] border border-[#692A6F]/40 glow-eminence">
                        <DollarSign className="h-5 w-5" />
                      </div>
                    </div>
                    <div className="mt-4">
                      <h3 className="text-2xl font-black text-white tracking-tight">
                        R$ {totalVendidoMesAtual.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                      </h3>
                      <div className="mt-2 flex items-center gap-1.5 text-xs font-bold text-[#F0E675]">
                        <TrendingUp className="h-3.5 w-3.5" />
                        <span>+{variacaoFaturamento.toFixed(1)}% vs mês anterior</span>
                      </div>
                    </div>
                  </button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-[700px]">
                  <DialogHeader>
                    <DialogTitle>Evolução de Faturamento</DialogTitle>
                    <DialogDescription>
                      Histórico detalhado do faturamento filtrado por período.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="flex gap-2 my-2 overflow-x-auto pb-2">
                    {['7', '30', '180', '365', 'all'].map(period => (
                      <Button
                        key={period}
                        variant={faturamentoPeriod === period ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setFaturamentoPeriod(period as '7' | '30' | '180' | '365' | 'all')}
                        className="text-xs rounded-xl"
                      >
                        {period === 'all' ? 'Total' : `${period} Dias`}
                      </Button>
                    ))}
                  </div>
                  <div className="h-[300px] w-full mt-4">
                    <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height: 300 }}>

                      <AreaChart data={getFaturamentoChartData()}>
                        <defs>
                          <linearGradient id="colorFaturamento" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#F0E675" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#F0E675" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                        <XAxis dataKey="date" stroke="#ffffff50" fontSize={12} tickLine={false} axisLine={false} />
                        <YAxis stroke="#ffffff50" fontSize={12} tickLine={false} axisLine={false} tickFormatter={value => `R$${(value as number).toLocaleString('pt-BR')}`} />
                        <Tooltip
                          contentStyle={{ backgroundColor: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px' }}
                          itemStyle={{ color: '#F0E675', fontWeight: 'bold' }}
                          formatter={(val: unknown) => [`R$ ${Number(val).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`, 'Faturamento']}
                        />
                        <Area type="monotone" dataKey="faturamento" stroke="#F0E675" strokeWidth={3} fillOpacity={1} fill="url(#colorFaturamento)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </DialogContent>
              </Dialog>

              {/* Card 2: Lucro Estimado */}
              <Dialog>
                <DialogTrigger asChild>
                  <button aria-label="Ver detalhes de Lucro Estimado" className="text-left w-full glass-card glass-card-hover p-5 rounded-3xl border border-white/10 relative overflow-hidden group">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Lucro Estimado</span>
                      <div className="h-10 w-10 rounded-2xl glass-panel flex items-center justify-center text-[#ED8F60] border border-[#ED8F60]/40 glow-apricot">
                        <Percent className="h-5 w-5" />
                      </div>
                    </div>
                    <div className="mt-4">
                      <h3 className="text-2xl font-black text-white tracking-tight">
                        R$ {lucroEstimado.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                      </h3>
                      <p className="mt-2 text-xs text-slate-400">Margem estimada de 42% sobre faturamento</p>
                    </div>
                  </button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-[425px]">
                  <DialogHeader>
                    <DialogTitle>Detalhamento de Lucro</DialogTitle>
                    <DialogDescription>
                      Cálculo de projeção matemática para o fim do mês baseada na margem padrão de 42%.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-4 py-4">
                    <div className="flex justify-between items-center border-b border-white/10 pb-2">
                      <span className="text-sm text-slate-400">Faturamento 30d</span>
                      <span className="font-medium text-white">R$ {lucroDetalhes().revenue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between items-center border-b border-white/10 pb-2">
                      <span className="text-sm text-slate-400">Custos & Impostos Estimados (58%)</span>
                      <span className="font-medium text-red-400">- R$ {lucroDetalhes().cost.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between items-center border-b border-white/10 pb-2">
                      <span className="text-sm text-slate-400">Lucro Líquido Atual (42%)</span>
                      <span className="font-medium text-green-400">R$ {lucroDetalhes().profit.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between items-center bg-[#ED8F60]/10 p-3 rounded-xl mt-2 border border-[#ED8F60]/20">
                      <span className="text-sm text-[#ED8F60] font-bold">Projeção Mês Atual</span>
                      <span className="font-black text-[#ED8F60]">R$ {lucroDetalhes().projectedProfit.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>

              {/* Card 3: Pedidos A Emitir NF-e */}
              <Dialog>
                <DialogTrigger asChild>
                  <button aria-label="Ver detalhes de Pedidos A Emitir NF-e" className="text-left w-full glass-card glass-card-hover p-5 rounded-3xl border border-white/10 relative overflow-hidden group">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">A Emitir NF-e</span>
                      <div className="h-10 w-10 rounded-2xl glass-panel flex items-center justify-center text-[#BF406A] border border-[#BF406A]/40 glow-blush">
                        <FileText className="h-5 w-5" />
                      </div>
                    </div>
                    <div className="mt-4">
                      <h3 className="text-2xl font-black text-[#BF406A] tracking-tight">
                        {pedidosNfePendente.length} pedidos
                      </h3>
                      <p className="mt-2 text-xs text-slate-400">Aguardando geração de nota fiscal</p>
                    </div>
                  </button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-[700px] max-h-[85vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle>Pedidos aguardando NF-e</DialogTitle>
                    <DialogDescription>
                      Pedidos pagos prontos para emissão de nota fiscal.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="mt-4">
                    <div className="flex flex-col gap-2">
                      {pedidosNfePendente.slice(0, 15).map(pedido => (
                        <div key={pedido.id} className="flex items-center justify-between p-3 rounded-xl border border-white/10 hover:bg-white/5 transition-colors">
                          <div className="flex flex-col">
                            <span className="text-sm font-medium text-white">{pedido.cliente?.nome || 'Cliente não identificado'}</span>
                            <span className="text-xs text-slate-400">Pedido #{pedido.numero} • R$ {Number(pedido.total).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            className="ml-auto text-[#BF406A] border-[#BF406A]/30 hover:bg-[#BF406A]/10"
                            onClick={() => handleEmitNfe(pedido.id || '', pedido.bling_id || '')}
                          >
                            Emitir NF-e
                          </Button>
                        </div>
                      ))}
                      {pedidosNfePendente.length === 0 && (
                        <div className="py-8 text-center text-slate-400 text-sm">
                          Nenhum pedido aguardando NF-e.
                        </div>
                      )}
                    </div>
                  </div>
                </DialogContent>
              </Dialog>

              {/* Card 4: Novos Pedidos */}
              <Dialog>
                <DialogTrigger asChild>
                  <button aria-label="Ver detalhes de Novos Pedidos" className="text-left w-full glass-card glass-card-hover p-5 rounded-3xl border border-white/10 relative overflow-hidden group">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Novos Pedidos</span>
                      <div className="h-10 w-10 rounded-2xl glass-panel flex items-center justify-center text-[#0A84FF] border border-[#0A84FF]/40 glow-blue">
                        <Package className="h-5 w-5" />
                      </div>
                    </div>
                    <div className="mt-4">
                      <h3 className="text-2xl font-black text-[#0A84FF] tracking-tight">
                        {data?.pedidos?.filter(p => p.status === 'Novo').length || 0} pedidos
                      </h3>
                      <p className="mt-2 text-xs text-slate-400">Na esteira inicial de preparação</p>
                    </div>
                  </button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-[700px] max-h-[85vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle>Acompanhamento de Pedidos</DialogTitle>
                    <DialogDescription>
                      Selecione o status na esteira para ver os pedidos correspondentes.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="flex flex-wrap gap-2 my-4 border-b border-white/10 pb-4">
                    {['Novo', 'Aberto', 'Em Processamento', 'Despachado', 'Enviado'].map(status => (
                      <Button
                        key={status}
                        variant={novosPedidosTab === status ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setNovosPedidosTab(status as "Novo" | "Aberto" | "Em Processamento" | "Despachado" | "Enviado")}
                        className="text-xs rounded-xl"
                      >
                        {status}
                      </Button>
                    ))}
                  </div>
                  <div className="mt-2">
                    <div className="flex flex-col gap-2">
                      {novosPedidosFluxo.slice(0, 15).map(pedido => (
                        <div key={pedido.id} className="flex items-center justify-between p-3 rounded-xl border border-white/10 hover:bg-white/5 transition-colors">
                          <div className="flex flex-col">
                            <span className="text-sm font-medium text-white">{pedido.cliente?.nome || 'Cliente não identificado'}</span>
                            <span className="text-xs text-slate-400">
                              Pedido #{pedido.numero} • {format(parseISO(pedido.data), "dd/MM/yyyy")}
                            </span>
                          </div>
                          <span className="text-sm font-bold text-slate-200 ml-auto">
                            R$ {Number(pedido.total).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                          </span>
                        </div>
                      ))}
                      {novosPedidosFluxo.length === 0 && (
                        <div className="py-8 text-center text-slate-400 text-sm">
                          Nenhum pedido com status &quot;{novosPedidosTab}&quot;.
                        </div>
                      )}
                    </div>
                  </div>
                </DialogContent>
              </Dialog>

            </div>

            {/* CHARTS SECTION (FULL WIDTH) */}
            <div className="w-full">
              <BudgetCard
                title="Valor total de pedidos por dia"
                totalAmount={totalVendidoMesAtual}
                costAmount={totalVendidoMesAtual * 0.58}
                data={getWeeklySalesData()}
              />
            </div>

            {/* RECENT ORDERS OVERVIEW */}
            <div className="glass-panel p-6 rounded-3xl border border-white/10 space-y-4 shadow-xl">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-slate-200">
                  <Activity className="h-5 w-5 text-[#0A84FF]" />
                  <h3 className="text-sm font-bold uppercase tracking-wider">Últimos Pedidos Recebidos</h3>
                </div>
                <button
                  onClick={() => setActiveTab('sales')}
                  className="text-xs text-[#0A84FF] hover:text-blue-300 font-semibold flex items-center gap-1 cursor-pointer"
                >
                  <span>Ver todos</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>

              <TransactionList
                pedidos={data?.pedidos ? data.pedidos.slice(0, 5) : []}
                onOpenChatwoot={handleOpenChatwootForPhone}
                onEmitirNfe={(pedido) => handleEmitNfe(pedido.id || '', pedido.bling_id || '')}
                loading={isLoading}
              />
            </div>

          </div>
        )}

        {/* TAB 2: VENDAS & PEDIDOS */}
        {activeTab === 'sales' && (
          <div className="space-y-6">

            {/* Filter Controls Bar with GradientMenu */}
            <div className="glass-panel p-4 rounded-3xl border border-white/10 flex flex-col lg:flex-row items-center justify-between gap-4 shadow-xl">

              {/* Gradient Menu Filter for Period */}
              <GradientMenu
                activeId={filterDays}
                onChange={(id) => setFilterDays(id)}
                items={[
                  { id: 'all', label: 'Todo o período' },
                  { id: '7', label: 'Últimos 7 dias' },
                  { id: '30', label: 'Últimos 30 dias' },
                  { id: '90', label: 'Últimos 90 dias' },
                ]}
              />

              <div className="flex items-center gap-3 w-full lg:w-auto justify-end">
                {/* Sort By Dropdown */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="w-full lg:w-auto justify-between font-normal px-3 py-2 h-[36px] text-xs rounded-xl glass-input outline-none border-white/10 hover:bg-white/5 hover:text-white">
                      {sortBy === 'recent' ? 'Mais recentes' : sortBy === 'old' ? 'Mais antigos' : 'Maior valor'}
                      <ChevronRight className="h-4 w-4 opacity-50 rotate-90 flex-shrink-0 ml-2" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-48">
                    <DropdownMenuRadioGroup value={sortBy} onValueChange={setSortBy}>
                      <DropdownMenuRadioItem value="recent">Mais recentes</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="old">Mais antigos</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="highest">Maior valor</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Search Box */}
                <SearchQueryInput
                  containerClassName="relative w-full sm:w-64"
                  iconClassName="absolute left-3.5 top-2.5 h-4 w-4 text-slate-400"
                  inputClassName="w-full pl-10 pr-4 py-2 rounded-xl glass-input text-xs outline-none"
                  placeholder="Buscar pedido, cliente..."
                  value={searchQuery}
                  onChange={setSearchQuery}
                />

                {/* Botão Incluir Pedido Manual */}
                <Button
                  onClick={() => setIsManualOrderOpen(true)}
                  className="bg-gradient-to-r from-[#FF9F0A] to-[#FF6B00] text-zinc-900 text-xs font-bold px-4 py-2 h-[36px] rounded-xl hover:opacity-90 transition-all flex items-center gap-1.5 shrink-0 shadow-lg cursor-pointer"
                >
                  <Plus className="h-4 w-4" />
                  Incluir Pedido Manual
                </Button>
              </div>

            </div>

            {/* Transaction List Component */}
            <div className="space-y-4">
              <div className="flex items-center justify-between px-1">
                <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider">
                  Listagem de Pedidos Bling ({filteredPedidosList.length})
                </h3>
              </div>

              <TransactionList
                pedidos={filteredPedidosList}
                onOpenChatwoot={handleOpenChatwootForPhone}
                onEmitirNfe={(pedido) => handleEmitNfe(pedido.id || '', pedido.bling_id || '')}
                loading={isLoading}
              />
            </div>

          </div>
        )}

        {/* TAB 3: ESTOQUE & PRODUTOS */}
        {activeTab === 'inventory' && (
          <div className="space-y-6">

            {/* Filtros Avançados */}
            <div className="glass-panel p-5 rounded-3xl border border-white/10 space-y-4 shadow-xl">
              <h3 className="text-sm font-bold text-white uppercase tracking-wider">Filtros de Catálogo & Inventário</h3>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* Busca */}
                <div className="relative w-full">
                  <Search className="absolute left-3.5 top-2.5 h-4 w-4 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Buscar nome ou SKU..."
                    value={inventorySearch}
                    onChange={(e) => setInventorySearch(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 rounded-xl glass-input text-xs outline-none"
                  />
                </div>

                {/* Status (Ativos/Inativos) */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="w-full justify-between font-normal px-3 py-2 h-[36px] text-xs rounded-xl glass-input outline-none border-white/10 hover:bg-white/5 hover:text-white">
                      {inventoryStatus === 'all' ? 'Todos os Produtos' : inventoryStatus === 'active' ? 'Ativos (Em Estoque)' : 'Inativos (Sem Estoque)'}
                      <ChevronRight className="h-4 w-4 opacity-50 rotate-90" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-56">
                    <DropdownMenuRadioGroup value={inventoryStatus} onValueChange={(val) => setInventoryStatus(val as 'all' | 'active' | 'inactive')}>
                      <DropdownMenuRadioItem value="all">Todos os Produtos</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="active">Ativos (Em Estoque)</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="inactive">Inativos (Sem Estoque)</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Categorias */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="w-full justify-between font-normal px-3 py-2 h-[36px] text-xs rounded-xl glass-input outline-none border-white/10 hover:bg-white/5 hover:text-white overflow-hidden text-ellipsis whitespace-nowrap">
                      {inventoryCategory === 'all' ? 'Todas as Categorias' : data?.categorias?.find(c => c.id === inventoryCategory)?.descricao || 'Categoria'}
                      <ChevronRight className="h-4 w-4 opacity-50 rotate-90 flex-shrink-0 ml-2" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-56 max-h-[300px] overflow-y-auto">
                    <DropdownMenuRadioGroup value={inventoryCategory} onValueChange={setInventoryCategory}>
                      <DropdownMenuRadioItem value="all">Todas as Categorias</DropdownMenuRadioItem>
                      {data?.categorias?.map(cat => (
                        <DropdownMenuRadioItem key={cat.id || cat.bling_id} value={cat.id || String(cat.bling_id)}>
                          {cat.descricao}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Faixa de Preço */}
                <div className="flex items-center gap-2">
                  <div className="relative w-full">
                    <DollarSign className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
                    <input
                      type="number"
                      placeholder="Min"
                      value={inventoryMinPrice}
                      onChange={(e) => setInventoryMinPrice(e.target.value)}
                      className="w-full pl-8 pr-2 py-2 rounded-xl glass-input text-xs outline-none"
                    />
                  </div>
                  <span className="text-slate-400">-</span>
                  <div className="relative w-full">
                    <DollarSign className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
                    <input
                      type="number"
                      placeholder="Max"
                      value={inventoryMaxPrice}
                      onChange={(e) => setInventoryMaxPrice(e.target.value)}
                      className="w-full pl-8 pr-2 py-2 rounded-xl glass-input text-xs outline-none"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Inventory List (List2 Component - No Cards!) */}
            <div className="glass-panel p-6 rounded-3xl border border-white/10 space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-3">
                  <h3 className="text-sm font-bold text-white uppercase tracking-wider">Catálogo Sincronizado do Bling</h3>
                  <span className="text-xs text-slate-400 font-mono">Bling Cache Supabase</span>
                </div>
                <button
                  onClick={() => {
                    setSelectedProdutoModal(null);
                    setIsProductModalOpen(true);
                  }}
                  className="px-4 py-2 rounded-xl glass-button-primary text-xs font-bold transition flex items-center gap-2 cursor-pointer shadow-lg hover:scale-105"
                >
                  <Package className="w-4 h-4" />
                  <span>+ Cadastrar Novo Produto</span>
                </button>
              </div>

              {(!data?.produtos || data.produtos.length === 0) ? (
                <div className="p-8 text-center glass-panel rounded-2xl border border-white/10 space-y-3">
                  <Package className="h-8 w-8 text-purple-400 mx-auto opacity-60" />
                  <p className="text-sm font-semibold text-slate-300">Nenhum produto sincronizado do Bling ainda.</p>
                  <p className="text-xs text-slate-400">Clique no botão <span className="text-purple-300 font-bold">&quot;Sincronizar Bling&quot;</span> no topo do painel para importar o seu catálogo real.</p>
                </div>
              ) : (
                <>
                  {/* ── PRODUTOS SINCRONIZADOS (bling_id numérico) ── */}
                  {(() => {
                    const filteredProducts = (data.produtos || []).filter(p => {
                      // Filtro de Busca
                      const q = inventorySearch.toLowerCase();
                      const matchSearch = q
                        ? p.nome.toLowerCase().includes(q) || (p.codigo && p.codigo.toLowerCase().includes(q))
                        : true;

                      // Filtro de Status
                      const matchStatus = inventoryStatus === 'all'
                        ? true
                        : inventoryStatus === 'active'
                          ? p.estoque > 0
                          : p.estoque <= 0;

                      // Filtro de Categoria
                      const matchCategory = inventoryCategory === 'all'
                        ? true
                        : p.categoria_id === inventoryCategory;

                      // Filtro de Preço
                      const price = Number(p.preco);
                      const min = inventoryMinPrice ? Number(inventoryMinPrice) : 0;
                      const max = inventoryMaxPrice ? Number(inventoryMaxPrice) : Infinity;
                      const matchPrice = price >= min && price <= max;

                      return matchSearch && matchStatus && matchCategory && matchPrice;
                    });

                    const syncedProducts = filteredProducts.filter(p => isProdutoSynced(p.bling_id));
                    const unsyncedProducts = filteredProducts.filter(p => !isProdutoSynced(p.bling_id));

                    return (
                      <>
                        {syncedProducts.length > 0 && (
                          <List2
                            heading=""
                            items={syncedProducts.map((produto) => {
                              const imageUrl = getProductImage(produto);
                              return {
                                icon: (
                                  <ProductThumbnail produto={produto} imageUrl={imageUrl} variant="synced" />
                                ),
                                title: produto.nome,
                                category: `SKU: ${produto.codigo || `BLING-${produto.bling_id}`} • Saldo: ${produto.estoque} un.`,
                                description: `R$ ${Number(produto.preco).toFixed(2)}`,
                                onClick: () => handleOpenProductModal(produto),
                                action: (
                                  <div className="flex items-center gap-2">
                                    <span className="text-[10px] font-bold px-2 py-1 rounded-full border bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
                                      ✓ Bling
                                    </span>
                                    <span
                                      className={`text-xs font-bold px-3 py-1.5 rounded-full border ${
                                        produto.estoque <= 0
                                          ? 'bg-rose-500/20 text-rose-300 border-rose-500/30'
                                          : produto.estoque < 5
                                          ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                                          : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                                      }`}
                                    >
                                      {produto.estoque <= 0 ? 'Sem Estoque' : produto.estoque < 5 ? 'Estoque Baixo' : 'Em Estoque'}
                                    </span>
                                    <button
                                      onClick={() => handleOpenProductModal(produto)}
                                      className="px-3 py-1.5 rounded-xl glass-button-primary text-xs font-bold transition flex items-center gap-1.5 cursor-pointer shadow-md hover:scale-105"
                                    >
                                      <span>Ver Detalhes</span>
                                    </button>
                                  </div>
                                ),
                              };
                            })}
                          />
                        )}

                        {/* ── PRODUTOS NÃO SINCRONIZADOS (bling_id local/teste) ── */}
                        {unsyncedProducts.length > 0 && (
                          <div className="mt-6 space-y-3">
                            <div className="flex items-center gap-3 px-2">
                              <div className="flex items-center gap-2">
                                <AlertTriangle className="h-4 w-4 text-amber-400" />
                                <h4 className="text-sm font-bold text-amber-300 uppercase tracking-wider">
                                  Não Sincronizados ({unsyncedProducts.length})
                                </h4>
                              </div>
                              <p className="text-[11px] text-slate-500">
                                Estes produtos existem apenas no cache local. Clique em &quot;Sincronizar Bling&quot; para enviá-los ao Bling ERP.
                              </p>
                            </div>
                            <div className="glass-panel rounded-2xl border border-amber-500/20 overflow-hidden">
                              <List2
                                heading=""
                                items={unsyncedProducts.map((produto) => {
                                  const imageUrl = getProductImage(produto);
                                  const validation = validateProdutoForBling(produto);

                                  return {
                                    icon: (
                                      <ProductThumbnail produto={produto} imageUrl={imageUrl} variant="unsynced" />
                                    ),
                                    title: produto.nome || 'Produto sem nome',
                                    category: `ID Local: ${produto.bling_id} • Saldo: ${produto.estoque} un.`,
                                    description: (
                                      <div className="flex flex-col gap-1 mt-1">
                                        <span className="text-slate-300">R$ {Number(produto.preco).toFixed(2)}</span>
                                        {!validation.valid && (
                                          <div className="text-[10px] text-rose-400 bg-rose-500/10 px-2 py-1 rounded border border-rose-500/20">
                                            <strong>Faltam dados:</strong> {validation.errors.join(' • ')}
                                          </div>
                                        )}
                                      </div>
                                    ),
                                    onClick: () => handleOpenProductModal(produto),
                                    action: (
                                      <div className="flex items-center gap-2">
                                        <span className="text-[10px] font-bold px-2.5 py-1 rounded-full border bg-amber-500/15 text-amber-400 border-amber-500/30 animate-pulse">
                                          ⚠ Não Sincronizado
                                        </span>
                                        <button
                                          onClick={() => handleOpenProductModal(produto)}
                                          className="px-3 py-1.5 rounded-xl glass-button-primary text-xs font-bold transition flex items-center gap-1.5 cursor-pointer shadow-md hover:scale-105"
                                        >
                                          <span>Corrigir</span>
                                        </button>
                                      </div>
                                    ),
                                  };
                                })}
                              />
                            </div>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </>
              )}
            </div>

          </div>
        )}

        {/* TAB 4: CLIENTES & CONTATOS (TableWithDialog Component) */}
        {activeTab === 'contacts' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between px-1">
              <div>
                <h2 className="text-xl font-bold text-white">Base de Clientes & Contatos</h2>
                <p className="text-slate-400 text-xs mt-0.5">Gestão de contatos sincronizada com Bling & Supabase</p>
              </div>
              <Button
                onClick={() => {
                  setSelectedClienteToEdit(null);
                  setIsClienteEditOpen(true);
                }}
                className="bg-gradient-to-r from-blue-600 to-blue-500 text-white text-xs font-bold px-4 py-2 h-[36px] rounded-xl hover:opacity-90 transition-all flex items-center gap-1.5 shadow-lg cursor-pointer"
              >
                <Plus className="h-4 w-4" />
                Novo Contato
              </Button>
            </div>

            <TableWithDialog
              title="Clientes Cadastrados"

              users={
                ((data?.clientes && data.clientes.length > 0)
                  ? data.clientes
                  : (data?.pedidos?.map((p) => p.cliente).filter((c, index, self) => c && self.findIndex((t) => t?.id === c.id) === index) || [])
                ).map((cliente, idx) => ({
                  id: String(cliente?.id || idx + 1),
                  name: cliente?.nome || 'Cliente Sem Nome',
                  email: cliente?.email || 'Sem e-mail',
                  location: 'Brasil',
                  status: 'Ativo',
                  balance: 'R$ 0,00',
                  phone: cliente?.telefone,
                  cpf_cnpj: cliente?.cpf_cnpj,
                  originalCliente: cliente // to pass the full client object
                }))
              }
              onViewDetails={(user: { originalCliente?: Cliente; id: string; name: string; email: string; phone?: string; cpf_cnpj?: string }) => {
                if (user.originalCliente) {
                  setSelectedClienteModal(user.originalCliente);
                  setIsClienteModalOpen(true);
                } else {
                  // Fallback para mock users se aplicável
                  const fallbackUser: Cliente = {
                    id: user.id,
                    nome: user.name,
                    email: user.email,
                    telefone: user.phone,
                    cpf_cnpj: user.cpf_cnpj,
                    bling_id: '',
                    user_id: '',
                    created_at: new Date().toISOString()
                  };
                  setSelectedClienteModal(fallbackUser);
                  setIsClienteModalOpen(true);
                }
              }}
            />
          </div>
        )}

        {/* TAB 5: SAC OMNICHANNEL (CHATWOOT RECREATED) */}
        {(activeTab === 'sac' || activeTab === 'chats') && (
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
          if (data?.produtos) {
            const newProdutos = data.produtos.map(p => (p.id === updated.id || p.bling_id === updated.bling_id) ? updated : p);
            setData(prev => prev ? { ...prev, produtos: newProdutos } : null);
          }
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
      />

      {/* Modal de Configuração de APIs Reais */}
      <SetupWizard
        isOpen={isWizardOpen}
        onClose={() => setIsWizardOpen(false)}
        onConfigSaved={loadDashboardData}
      />

      {/* Modal de Incluir Pedido Manual */}
      <ManualOrderModal
        open={isManualOrderOpen}
        onOpenChange={setIsManualOrderOpen}
        onSuccess={loadDashboardData}
      />

      {/* Modal de Cadastrar / Editar Contato */}
      <ClienteEditModal
        isOpen={isClienteEditOpen}
        onClose={() => setIsClienteEditOpen(false)}
        cliente={selectedClienteToEdit}
        onSave={() => loadDashboardData()}
      />

    </div>
  );
}
