'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  FileText,
  Sparkles,
  RefreshCw,
  X,
  Plus,
} from "lucide-react";
import type { Produto, Cliente, ItemPedido } from '@/types';
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
import { AreaDeConteudo } from '@/components/shell/AreaDeConteudo';
import responsive from '@/components/ui/Responsive.module.css';
import { Rail } from '@/components/shell/Rail';
import { OrganizacaoAtiva } from '@/components/shell/OrganizacaoAtiva';
import { SeletorDeFundo, useFundo } from '@/components/shell/SeletorDeFundo';
import { VendasEPedidos } from '@/components/vendas/VendasEPedidos';
import { EstoqueEProdutos } from '@/components/estoque/EstoqueEProdutos';
import { AssistenteDeEstoque } from '@/components/estoque/AssistenteDeEstoque';
import { ClientesEContatos } from '@/components/clientes/ClientesEContatos';
import { ClienteDetailModal } from '@/components/ClienteDetailModal';
import { ProductDetailModal } from '@/components/ProductDetailModal';
import { useProdutoNoModal } from '@/components/produtos/useProdutoNoModal';
import { escopoDaLeitura as comporEscopoDaLeitura, useSessaoComGeracao } from '@/components/sessao/geracaoDaSessao';
import { ClienteEditModal } from '@/components/ClienteEditModal';
import { ManualOrderModal } from '@/components/ManualOrderModal';
import { StartupLoader } from '@/components/StartupLoader';
import { FinanceiroTab } from '@/components/financeiro/FinanceiroTab';
import { TelaDeEntrada } from '@/components/auth/TelaDeEntrada';
import { OrganizationPanel } from '@/components/organizacao/OrganizationPanel';
import { IntegrationsPanel } from '@/components/integracoes/IntegrationsPanel';
import { MensageriaDesktop } from '@/components/mensageria/MensageriaDesktop';
import { BillingPanel } from '@/components/billing/BillingPanel';
import { fetchWithAuth } from '@/lib/fetchWithAuth';
import { excluirContato } from '@/lib/correcaoOperacionalCliente';
import {
  usePapelNaOrganizacaoAtiva,
  type SelecaoDeOrganizacao,
} from '@/components/organizacao/usePapelNaOrganizacaoAtiva';
import { useStartupPorOrganizacao } from '@/components/organizacao/useStartupPorOrganizacao';
import { useOrganizationsList } from '@/components/organizacao/useOrganizationsList';
import { useLeituraDoPainel } from '@/components/painel/useLeituraDoPainel';
import { VisaoGeral } from '@/components/painel/VisaoGeral';
import { descreverErro } from '@/lib/erroLegivel';
import { mensagemDeFalhaDeLogin } from '@/lib/auth/mensagemDeFalhaDeLogin';
import { HelpContext } from '@/components/help/HelpContext';

/**
 * Identidade do usuário logado — **e nada além disso**.
 *
 * O tipo não carrega papel de propósito: nada do lado do cliente — metadados do
 * provedor de identidade, e-mail, `localStorage` — é autoridade sobre o que a
 * pessoa pode fazer. O papel vem do vínculo persistido na organização ativa,
 * por `usePapelNaOrganizacaoAtiva`.
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
const TELAS_QUE_OCUPAM_A_JANELA = new Set(['dashboard', 'sales', 'inventory', 'contacts', 'finance', 'organization', 'sac']);

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
  // A geração distingue esta instância da sessão das anteriores, mesmo com a
  // mesma conta: sair e entrar de novo não revive o que foi aberto antes.
  const { sessao: session, geracao: geracaoDaSessao, definirSessao: setSession } = useSessaoComGeracao<UserSession>(() => {
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
   * O estado de organizações, **uma vez só**.
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
  const [selectedClienteModal, setSelectedClienteModal] = useState<Cliente | null>(null);
  const [isClienteModalOpen, setIsClienteModalOpen] = useState(false);
  // A inicialização é **por organização confirmada**, e só de quem administra.
  // Era um booleano global ao lado de um papel que só conhecia a sessão: quem
  // iniciava em A e trocava para B nunca via a inicialização de B, porque o
  // estado de A continuava valendo (revisão do #66).
  const { mostrarCarregador: showStartupLoader, encerrar: encerrarStartup } =
    useStartupPorOrganizacao(podeGerir, organizacaoConfirmada);



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
   * atrasada da organização de antes não tem onde ser aplicada. A geração da
   * sessão entra junto: logout e login com a mesma conta, mesma organização e
   * mesma versão ainda produzem um escopo novo.
   */
  const escopoDaLeitura = comporEscopoDaLeitura(
    { geracao: geracaoDaSessao, identidade: identidadeDaSessao },
    selecaoDeOrganizacao,
  );

  const painel = useLeituraDoPainel(escopoDaLeitura);
  const data = painel.dados;
  const erroDaLeitura = painel.erro;
  const isLoading = painel.carregando;
  const loadDashboardData = painel.recarregar;

  /**
   * O produto do modal, carimbado pelo mesmo escopo da leitura. Trocar de
   * organização ou de sessão o torna inelegível no mesmo render — o modal de A
   * (e a URL assinada da foto de A) não aparece sob B.
   */
  const produtoNoModal = useProdutoNoModal(escopoDaLeitura);

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

  /**
   * O contato que a aba de Clientes pediu para abrir na Mensageria.
   *
   * É a única coisa que a página ainda precisa saber sobre atendimento: a
   * superfície inteira — conversas, histórico, envio, subscriptions — vive em
   * `MensageriaDesktop`, escopada na organização ativa.
   */
  const [telefoneParaAtender, setTelefoneParaAtender] = useState<string | null>(null);

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
    // `setSession` é o `useCallback` estável de `useSessaoComGeracao`: o efeito
    // continua rodando uma vez só.
  }, [setSession]);

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
      // A mensagem do provedor vem em inglês e no vocabulário dele.
      // `mensagemDeFalhaDeLogin` traduz os casos conhecidos sem juntar causas
      // que pedem ações diferentes, e deixa passar inteiro o que não reconhece.
      setAuthError(mensagemDeFalhaDeLogin(error));
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
   * `POST /api/sync` responde `202` com `{ jobId, status }` — ele **enfileira**,
   * não conclui. Por isso a resposta não traz estatísticas: o progresso e o
   * resultado final são lidos em `GET /api/sync/status`.
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
    setTelefoneParaAtender(phone ?? null);
  };
  if (!session) {
    return (
      <TelaDeEntrada
        modo={authMode}
        onTrocarModo={() => {
          setAuthError(null);
          setAuthMode((mode) => (mode === 'signin' ? 'signup' : 'signin'));
        }}
        email={loginEmail}
        onEmailChange={setLoginEmail}
        senha={loginPassword}
        onSenhaChange={setLoginPassword}
        onSubmit={handleLogin}
        erro={authError}
        carregando={authLoading}
        logo={<OrbitaLogo className="h-7 w-7" />}
      />
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
        <div className={`orbita-acoes ${responsive.topbar}`}>
          <HelpContext ajudaId="shell.org">
          <OrganizacaoAtiva
            organizacoes={listaDeOrganizacoes.organizacoes}
            ativa={listaDeOrganizacoes.activeOrg}
            carregando={listaDeOrganizacoes.isLoading}
            trocandoParaId={listaDeOrganizacoes.switchingOrgId}
            onTrocar={listaDeOrganizacoes.handleSwitchOrganization}
          />
          </HelpContext>

          <SeletorDeFundo fundo={fundo} onEscolher={escolherFundo} />

          {/*
            Uma ação de sincronização na barra, e uma só.

            Havia duas, lado a lado: "Sincronizar Bling" e "Completa". Elas não
            são alternativas — a primeira traz o que mudou, a segunda relê o
            catálogo inteiro ignorando o marcador de "última alteração" —, mas
            postas juntas leem como duas ações concorrentes, e "Completa" não
            diz o que completa. Numa barra onde toda ação é de uma palavra, o
            botão que ninguém entende é o que a pessoa aperta por via das
            dúvidas; e o que ele faz é a releitura mais cara que o produto tem.

            A releitura completa **continua existindo inteira**:
            `handleSync(true)`, a rota, o contrato e o comportamento do
            provedor estão intocados — o que saiu foi o atalho para ela nesta
            superfície. Ela volta depois da banca como ação avançada, de
            recuperação, no lugar em que ações de recuperação moram; não num
            botão colado na ação do dia a dia.
          */}
          {isOwner && (
            <HelpContext ajudaId="integracoes.estado-job">
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
            </HelpContext>
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
      <AreaDeConteudo aba={activeTab} ocupaJanela={TELAS_QUE_OCUPAM_A_JANELA.has(activeTab)}>

        {/* TAB FINANCEIRO */}
        <div className={activeTab === 'finance' ? 'flex flex-col flex-1 min-h-0' : 'hidden'}>
          <FinanceiroTab fetchWithAuth={fetchWithAuth} ativo={activeTab === 'finance'} pedidos={data?.pedidos ?? null} organizacaoId={activeOrganizacaoId} />
        </div>

        {/* TAB ORGANIZAÇÃO & MEMBROS */}
        <div className={activeTab === 'organization' ? 'flex flex-col flex-1 min-h-0' : 'hidden'}>
          <OrganizationPanel fetchWithAuth={fetchWithAuth} lista={listaDeOrganizacoes} />
        </div>

        {/* TAB INTEGRAÇÕES: Bling / Chatwoot */}
        <div className={activeTab === 'integrations' ? 'flex flex-col flex-1 min-h-0' : 'hidden'}>
          <IntegrationsPanel
            fetchWithAuth={fetchWithAuth}
            selecao={selecaoDeOrganizacao}
            nomeDaOrganizacao={listaDeOrganizacoes.activeOrg?.organizacao.nome ?? null}
            podeGerir={podeGerir}
          />
        </div>

        {/* TAB PLANO & FATURAMENTO */}
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
            onAbrirProduto={produtoNoModal.abrir}
            onCadastrarProduto={produtoNoModal.abrirCadastro}
            assistente={organizacaoAtivaId && <AssistenteDeEstoque key={organizacaoAtivaId} />}
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

        {/* TAB MENSAGERIA */}
        {activeTab === 'sac' && (
          <MensageriaDesktop
            fetchWithAuth={fetchWithAuth}
            selecao={selecaoDeOrganizacao}
            telefoneParaAbrir={telefoneParaAtender}
          />
        )}

      </AreaDeConteudo>
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
                          <td className="py-2.5 px-3 font-semibold text-white">{item.produto_nome || item.produto?.nome || 'Item do Pedido'}</td>
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
        isOpen={produtoNoModal.aberto}
        onClose={produtoNoModal.fechar}
        produto={produtoNoModal.produto}
        cliente={
          data?.clientes?.[0] ||
          data?.pedidos?.find(p => p.itens?.some(i => i.produto_id === produtoNoModal.produto?.id))?.cliente ||
          null
        }
        // Releitura autoritativa, e não remendo local: o produto volta do
        // repositório na forma canônica de `Produto`, com `bling_id`,
        // `categoria_id` e `unidade` no lugar. Sem reload de página.
        onSaved={() => { void loadDashboardData(); }}
        // Excluído (confirmado pelo servidor): a linha some porque o catálogo
        // foi relido, não por um filtro otimista na tela.
        onArquivado={() => { void loadDashboardData(); }}
        // A miniatura da tabela vem da mesma releitura, com o carimbo da
        // organização preservado por `useLeituraDoPainel`.
        onImagemAlterada={() => { void loadDashboardData(); }}
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
          setIsClienteModalOpen(false);
          setSelectedClienteToEdit(cliente);
          setIsClienteEditOpen(true);
        }}
        // A exclusão manda só o id local; quem decide se o contato pode sair é
        // o servidor. A lista só é relida depois da confirmação dele.
        onExcluir={(clienteId) => excluirContato(fetchWithAuth, clienteId)}
        onExcluido={() => {
          setIsClienteModalOpen(false);
          setSelectedClienteModal(null);
          void loadDashboardData();
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
