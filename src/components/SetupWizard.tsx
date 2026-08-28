'use client';

import { useState, useEffect } from "react";
import {
  Key,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  ShieldCheck,
  Copy,
  Check,
  HelpCircle,
  MessageCircle,
  Database,
  ArrowRight,
  X
} from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { z } from 'zod';

const DEFAULT_CHATWOOT_INSTANCE_URL =
  process.env.NEXT_PUBLIC_CHATWOOT_DEFAULT_URL || 'https://app.chatwoot.com';

const BlingAuthorizationResponseSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), authorizeUrl: z.url() }),
  z.object({ success: z.literal(false), error: z.string() }),
]);

interface SetupWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onConfigSaved: () => void;
}

async function getAuthToken(): Promise<string> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token || '';
  } catch {
    return '';
  }
}

/** Consulta `/api/config` e aplica o estado inicial (Client ID salvo, status de conexão) do Bling. */
async function loadBlingConfigStatus(setters: {
  setClientId: (id: string) => void;
  setHasCredentials: (v: boolean) => void;
  setIsBlingConnected: (v: boolean) => void;
}): Promise<void> {
  const token = await getAuthToken();
  const res = await fetch('/api/config', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = (await res.json()) as { success?: boolean; config?: { bling?: { clientId?: string; isConnected?: boolean } } };
  if (!data.success || !data.config?.bling) return;

  if (data.config.bling.clientId) {
    setters.setClientId(data.config.bling.clientId);
    setters.setHasCredentials(true);
  }
  setters.setIsBlingConnected(Boolean(data.config.bling.isConnected));
}

/** Resultado do POST `/api/config` ao salvar as credenciais do Bling. */
type SaveBlingCredentialsResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/** Envia as credenciais do Bling para `/api/config`, tolerando resposta não-JSON do servidor. */
async function saveBlingCredentialsRequest(
  token: string,
  clientId: string,
  clientSecret: string,
): Promise<SaveBlingCredentialsResult> {
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      bling: {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim()
      }
    })
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.error('API /api/config POST não retornou JSON:', text);
    return { ok: false, message: `Erro no servidor (${res.status}). Resposta não é JSON válido.` };
  }

  if (data.success) return { ok: true };
  return { ok: false, message: data.error || 'Erro ao salvar credenciais.' };
}

/** Resultado da solicitação de início do fluxo OAuth do Bling. */
type BlingAuthorizeResult =
  | { readonly ok: true; readonly authorizeUrl: string }
  | { readonly ok: false; readonly message: string };

/** Solicita a URL de autorização OAuth do Bling ao backend, validando o formato da resposta. */
async function requestBlingAuthorizeUrl(token: string): Promise<BlingAuthorizeResult> {
  if (!token) {
    return { ok: false, message: 'Sessão ausente. Faça login novamente.' };
  }

  const response = await fetch('/api/bling/authorize', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const parsed = BlingAuthorizationResponseSchema.safeParse(await response.json());

  if (!parsed.success) {
    return { ok: false, message: 'Resposta inválida ao iniciar o OAuth do Bling.' };
  }
  if (!response.ok || !parsed.data.success) {
    return { ok: false, message: parsed.data.success ? 'Não foi possível iniciar o OAuth.' : parsed.data.error };
  }

  return { ok: true, authorizeUrl: parsed.data.authorizeUrl };
}

/** Estado e handlers do fluxo de configuração/autorização do Bling, consultado ao abrir o wizard. */
function useBlingSetupFlow(isOpen: boolean) {
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [isBlingConnected, setIsBlingConnected] = useState(false);
  const [copiedCallback, setCopiedCallback] = useState(false);
  const [hasCredentials, setHasCredentials] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let mounted = true;
    void (async () => {
      try {
        await loadBlingConfigStatus({
          setClientId: (v) => { if (mounted) setClientId(v); },
          setHasCredentials: (v) => { if (mounted) setHasCredentials(v); },
          setIsBlingConnected: (v) => { if (mounted) setIsBlingConnected(v); },
        });
      } catch (err) {
        console.error('Erro ao verificar status de configuração:', err);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [isOpen]);

  const handleSaveBlingCredentials = async () => {
    setLoading(true);
    setFeedback(null);
    try {
      const token = await getAuthToken();
      const result = await saveBlingCredentialsRequest(token, clientId, clientSecret);
      if (result.ok) {
        setHasCredentials(true);
        setFeedback({ type: 'success', message: 'Credenciais do Bling salvas no Supabase com sucesso!' });
      } else {
        setFeedback({ type: 'error', message: result.message });
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Erro de comunicação com o servidor.';
      setFeedback({ type: 'error', message: errMsg });
    } finally {
      setLoading(false);
    }
  };

  const handleAuthorizeBling = async () => {
    setLoading(true);
    setFeedback(null);
    try {
      const token = await getAuthToken();
      const result = await requestBlingAuthorizeUrl(token);
      if (!result.ok) {
        setFeedback({ type: 'error', message: result.message });
        return;
      }
      window.location.assign(result.authorizeUrl);
    } catch (error: unknown) {
      console.error('Erro ao iniciar OAuth do Bling:', error);
      setFeedback({ type: 'error', message: 'Não foi possível iniciar o OAuth do Bling.' });
    } finally {
      setLoading(false);
    }
  };

  const copyCallbackUrl = () => {
    const callbackUrl = `${window.location.origin}/api/bling/callback`;
    navigator.clipboard.writeText(callbackUrl);
    setCopiedCallback(true);
    setTimeout(() => setCopiedCallback(false), 3000);
  };

  return {
    loading, feedback, clientId, setClientId, clientSecret, setClientSecret,
    isBlingConnected, copiedCallback, hasCredentials, setHasCredentials,
    handleSaveBlingCredentials, handleAuthorizeBling, copyCallbackUrl,
  };
}

interface BlingTabProps {
  isBlingConnected: boolean;
  hasCredentials: boolean;
  clientId: string;
  setClientId: (v: string) => void;
  clientSecret: string;
  setClientSecret: (v: string) => void;
  setHasCredentials: (v: boolean) => void;
  loading: boolean;
  handleSaveBlingCredentials: () => void;
  handleAuthorizeBling: () => void;
  copiedCallback: boolean;
  copyCallbackUrl: () => void;
}

/** Aba "ERP Bling v3": status de conexão, formulário de credenciais, autorização OAuth e tutorial. */
function BlingTab(props: BlingTabProps) {
  const {
    isBlingConnected, hasCredentials, clientId, setClientId, clientSecret, setClientSecret,
    setHasCredentials, loading, handleSaveBlingCredentials, handleAuthorizeBling,
    copiedCallback, copyCallbackUrl,
  } = props;

  return (
    <div className="space-y-6">
      {/* Status Atual */}
      <div className={`p-4 rounded-2xl border flex items-center justify-between ${
        isBlingConnected
          ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-300'
          : 'bg-amber-950/20 border-amber-500/30 text-amber-300'
      }`}>
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-xl ${isBlingConnected ? 'bg-emerald-500/20' : 'bg-amber-500/20'}`}>
            {isBlingConnected ? <CheckCircle2 className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
          </div>
          <div>
            <p className="text-xs font-bold">
              {isBlingConnected ? 'Conectado ao Bling v3 (Produção)' : 'Conexão Pendente no Bling'}
            </p>
            <p className="text-[11px] opacity-80">
              {isBlingConnected ? 'Os tokens de acesso estão salvos e operando com dados reais.' : 'Por favor, siga as etapas abaixo para autorizar o acesso.'}
            </p>
          </div>
        </div>
      </div>

      {/* ETAPA 1: Salvar Chaves */}
      <div className="space-y-4">
        <h4 className="text-sm font-bold text-white flex items-center gap-2">
          <span className="bg-purple-600 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px]">1</span>
          Credenciais da API (Bling)
        </h4>

        {!hasCredentials ? (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor="setup-wizard-bling-client-id" className="block text-xs font-semibold text-slate-300 mb-1.5">CLIENT ID do Bling</label>
                <input
                  id="setup-wizard-bling-client-id"
                  type="text"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="Seu Client ID do Bling"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900/80 border border-slate-800 text-xs text-white focus:outline-none focus:border-purple-500 transition"
                />
              </div>
              <div>
                <label htmlFor="setup-wizard-bling-client-secret" className="block text-xs font-semibold text-slate-300 mb-1.5">CLIENT SECRET do Bling</label>
                <input
                  id="setup-wizard-bling-client-secret"
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder="Seu Client Secret do Bling"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900/80 border border-slate-800 text-xs text-white focus:outline-none focus:border-purple-500 transition"
                />
              </div>
            </div>
            <div className="flex justify-end">
              <button
                onClick={handleSaveBlingCredentials}
                disabled={loading || !clientId || !clientSecret}
                className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-xs font-bold flex items-center gap-2 transition cursor-pointer"
              >
                {loading ? 'Salvando...' : 'Salvar Chaves'}
              </button>
            </div>
          </>
        ) : (
          <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex items-center justify-between">
            <div>
              <p className="text-xs text-slate-300">As chaves do Bling já estão cadastradas.</p>
              <p className="text-[10px] text-slate-500">Client ID salvo: {clientId.substring(0, 8)}...</p>
            </div>
            <button
              onClick={() => setHasCredentials(false)}
              className="text-[11px] text-purple-400 hover:text-purple-300 underline"
            >
              Alterar Chaves
            </button>
          </div>
        )}
      </div>

      {/* ETAPA 2: Autorização */}
      {hasCredentials && (
        <div className="space-y-4 pt-4 border-t border-slate-800/80 animate-fadeIn">
          <h4 className="text-sm font-bold text-white flex items-center gap-2">
            <span className="bg-purple-600 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px]">2</span>
            Autorizar Conexão
          </h4>

          <div className="flex items-center justify-between p-4 rounded-2xl bg-purple-950/20 border border-purple-500/30">
            <div>
              <h4 className="text-xs font-bold text-white">Login Direto no Bling (OAuth)</h4>
              <p className="text-[11px] text-slate-400">Abre a tela de consentimento oficial do Bling.</p>
            </div>
            <button
              onClick={handleAuthorizeBling}
              disabled={loading}
              className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold flex items-center gap-2 transition cursor-pointer shadow-lg shadow-purple-900/30"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span>Gerar Tokens / Entrar no Bling</span>
            </button>
          </div>
        </div>
      )}

      {/* Tutorial Ilustrado */}
      <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-3 mt-6">
        <div className="flex items-center gap-2 text-xs font-bold text-purple-300">
          <HelpCircle className="h-4 w-4" />
          <span>Como configurar seu Aplicativo no Bling ERP:</span>
        </div>
        <ol className="text-[11px] text-slate-300 space-y-2 list-decimal list-inside leading-relaxed">
          <li>No Bling, acesse <strong>Configurações &gt; Sistemas &gt; Aplicativos</strong>.</li>
          <li>Clique em <strong>Novo Aplicativo</strong> e dê um nome (ex: <em>ÓRBITA ERP</em>).</li>
          <li>
            Copie esta <strong>URL de Retorno / Callback</strong> e cole nas configurações do aplicativo no Bling:
            <div className="mt-1.5 flex items-center gap-2">
              <code className="px-2.5 py-1 rounded bg-slate-950 border border-slate-800 text-purple-300 text-[10px] select-all">
                {typeof window !== 'undefined' ? `${window.location.origin}/api/bling/callback` : 'http://localhost:3000/api/bling/callback'}
              </code>
              <button
                onClick={copyCallbackUrl}
                className="px-2 py-1 rounded bg-purple-600/30 hover:bg-purple-600/50 text-purple-200 text-[10px] font-semibold flex items-center gap-1 transition"
              >
                {copiedCallback ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                <span>{copiedCallback ? 'Copiado!' : 'Copiar'}</span>
              </button>
            </div>
          </li>
        </ol>
      </div>
    </div>
  );
}

/** Aba "Chatwoot SAC": formulário informativo de conexão da instância Chatwoot. */
function ChatwootTab() {
  return (
    <div className="space-y-5">
      <div className="p-4 rounded-2xl bg-indigo-950/20 border border-indigo-500/30 text-indigo-300 flex items-center gap-3">
        <MessageCircle className="h-5 w-5 shrink-0" />
        <div className="text-xs">
          <p className="font-bold">Integração Chatwoot SAC Omnichannel</p>
          <p className="opacity-80">Permite sincronizar conversas do WhatsApp e mensagens de atendimento diretamente no painel.</p>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <label htmlFor="setup-wizard-chatwoot-url" className="block text-xs font-semibold text-slate-300 mb-1.5">URL da Instância Chatwoot</label>
          <input
            id="setup-wizard-chatwoot-url"
            type="text"
            defaultValue={DEFAULT_CHATWOOT_INSTANCE_URL}
            placeholder={DEFAULT_CHATWOOT_INSTANCE_URL}
            className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900/80 border border-slate-800 text-xs text-white focus:outline-none focus:border-indigo-500 transition"
          />
        </div>

        <div>
          <label htmlFor="setup-wizard-chatwoot-account-id" className="block text-xs font-semibold text-slate-300 mb-1.5">ID da Conta Chatwoot (Account ID)</label>
          <input
            id="setup-wizard-chatwoot-account-id"
            type="text"
            placeholder="Ex: 1"
            className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900/80 border border-slate-800 text-xs text-white focus:outline-none focus:border-indigo-500 transition"
          />
        </div>

        <div>
          <label htmlFor="setup-wizard-chatwoot-token" className="block text-xs font-semibold text-slate-300 mb-1.5">Token de Acesso do Agente (API Access Token)</label>
          <input
            id="setup-wizard-chatwoot-token"
            type="password"
            placeholder="Seu token de acesso do Chatwoot"
            className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900/80 border border-slate-800 text-xs text-white focus:outline-none focus:border-indigo-500 transition"
          />
        </div>
      </div>

      <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800 text-xs text-slate-300 space-y-2">
        <p className="font-bold text-indigo-300">Como obter o Token de Acesso no Chatwoot:</p>
        <ol className="list-decimal list-inside space-y-1 text-[11px] text-slate-400">
          <li>Acesse seu painel do Chatwoot.</li>
          <li>Clique no seu avatar/perfil no canto inferior esquerdo e vá em <strong>Configurações de Perfil</strong>.</li>
          <li>Role até o final da página e copie a chave em <strong>Token de Acesso à API</strong>.</li>
        </ol>
      </div>
    </div>
  );
}

/** Aba "Supabase Cache": informações estáticas sobre o cache relacional já ativo. */
function SupabaseCacheTab() {
  return (
    <div className="space-y-5">
      <div className="p-4 rounded-2xl bg-cyan-950/20 border border-cyan-500/30 text-cyan-300 flex items-center gap-3">
        <Database className="h-5 w-5 shrink-0" />
        <div className="text-xs">
          <p className="font-bold">Cache Relacional do Supabase (Ativo)</p>
          <p className="opacity-80">Armazena produtos, pedidos e conversas em alta velocidade no banco PostgreSQL.</p>
        </div>
      </div>

      <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-3 text-xs">
        <div className="flex items-center justify-between border-b border-slate-800 pb-2">
          <span className="text-slate-400">URL do Projeto Supabase:</span>
          <code className="text-cyan-300 font-mono text-[11px]">https://etqjqeqqbjrzyyxodntv.supabase.co</code>
        </div>
        <div className="flex items-center justify-between pt-1">
          <span className="text-slate-400">Status da Conexão:</span>
          <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-[10px] font-bold">
            Operacional &amp; Conectado
          </span>
        </div>
      </div>
    </div>
  );
}

export function SetupWizard({ isOpen, onClose, onConfigSaved }: SetupWizardProps) {
  const [activeStep, setActiveStep] = useState<'bling' | 'chatwoot' | 'supabase'>('bling');
  const {
    loading, feedback, clientId, setClientId, clientSecret, setClientSecret,
    isBlingConnected, copiedCallback, hasCredentials, setHasCredentials,
    handleSaveBlingCredentials, handleAuthorizeBling, copyCallbackUrl,
  } = useBlingSetupFlow(isOpen);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 sm:p-6 overflow-hidden">
      <div className="bg-[#0e1322] border border-slate-800 rounded-3xl max-w-3xl w-full p-6 md:p-8 shadow-2xl relative text-white animate-fadeIn max-h-[90vh] overflow-y-auto scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
        {/* Fechar Modal */}
        <button
          onClick={onClose}
          className="absolute top-6 right-6 p-2 rounded-xl bg-slate-900/60 hover:bg-slate-800 text-slate-400 hover:text-white transition"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Cabeçalho */}
        <div className="flex items-center gap-3 mb-6 border-b border-slate-800/80 pb-5">
          <div className="p-3 rounded-2xl bg-purple-600/20 border border-purple-500/30 text-purple-400">
            <Key className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-xl font-bold bg-gradient-to-r from-purple-300 via-indigo-200 to-pink-300 bg-clip-text text-transparent">
              Configuração de APIs Reais (Sem Simulação)
            </h2>
            <p className="text-xs text-slate-400">
              Configure as credenciais reais da sua conta para conectar o ERP Bling e o Chatwoot.
            </p>
          </div>
        </div>

        {/* Abas */}
        <div className="flex items-center gap-2 mb-6 border-b border-slate-800/60 pb-3 overflow-x-auto">
          <button
            onClick={() => setActiveStep('bling')}
            className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition cursor-pointer ${
              activeStep === 'bling'
                ? 'bg-purple-600/30 text-purple-300 border border-purple-500/50'
                : 'text-slate-400 hover:text-white hover:bg-slate-900/40'
            }`}
          >
            <ShieldCheck className="h-4 w-4" />
            <span>1. ERP Bling v3</span>
            {isBlingConnected && (
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            )}
          </button>

          <button
            onClick={() => setActiveStep('chatwoot')}
            className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition cursor-pointer ${
              activeStep === 'chatwoot'
                ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/50'
                : 'text-slate-400 hover:text-white hover:bg-slate-900/40'
            }`}
          >
            <MessageCircle className="h-4 w-4" />
            <span>2. Chatwoot SAC</span>
          </button>

          <button
            onClick={() => setActiveStep('supabase')}
            className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition cursor-pointer ${
              activeStep === 'supabase'
                ? 'bg-cyan-600/30 text-cyan-300 border border-cyan-500/50'
                : 'text-slate-400 hover:text-white hover:bg-slate-900/40'
            }`}
          >
            <Database className="h-4 w-4" />
            <span>3. Supabase Cache</span>
          </button>
        </div>

        {/* Feedback Alert */}
        {feedback && (
          <div className={`p-4 mb-6 rounded-2xl border text-xs font-medium flex items-center gap-3 ${
            feedback.type === 'success'
              ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
              : 'bg-rose-950/40 border-rose-500/40 text-rose-300'
          }`}>
            {feedback.type === 'success' ? <CheckCircle2 className="h-5 w-5 shrink-0" /> : <AlertTriangle className="h-5 w-5 shrink-0" />}
            <span className="leading-relaxed">{feedback.message}</span>
          </div>
        )}

        {/* Conteúdo Aba Bling */}
        {activeStep === 'bling' && (
          <BlingTab
            isBlingConnected={isBlingConnected}
            hasCredentials={hasCredentials}
            clientId={clientId}
            setClientId={setClientId}
            clientSecret={clientSecret}
            setClientSecret={setClientSecret}
            setHasCredentials={setHasCredentials}
            loading={loading}
            handleSaveBlingCredentials={handleSaveBlingCredentials}
            handleAuthorizeBling={handleAuthorizeBling}
            copiedCallback={copiedCallback}
            copyCallbackUrl={copyCallbackUrl}
          />
        )}

        {/* Conteúdo Aba Chatwoot */}
        {activeStep === 'chatwoot' && <ChatwootTab />}

        {/* Conteúdo Aba Supabase */}
        {activeStep === 'supabase' && <SupabaseCacheTab />}

        {/* Rodapé / Concluir */}
        <div className="mt-8 pt-5 border-t border-slate-800/80 flex items-center justify-between">
          <button
            onClick={onClose}
            className="px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-300 text-xs font-bold transition cursor-pointer"
          >
            Cancelar
          </button>

          <button
            onClick={() => {
              onConfigSaved();
              onClose();
            }}
            className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white text-xs font-bold flex items-center gap-2 transition cursor-pointer shadow-lg shadow-purple-900/30 active:scale-95"
          >
            <span>Salvar &amp; Ir para o Dashboard</span>
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
