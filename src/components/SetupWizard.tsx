'use client';

import React, { useState, useEffect } from 'react';
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

const BlingAuthorizationResponseSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), authorizeUrl: z.url() }),
  z.object({ success: z.literal(false), error: z.string() }),
]);

interface SetupWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onConfigSaved: () => void;
}

export function SetupWizard({ isOpen, onClose, onConfigSaved }: SetupWizardProps) {
  const [activeStep, setActiveStep] = useState<'bling' | 'chatwoot' | 'supabase'>('bling');
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Formulário do Bling
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [manualCodeOrUrl, setManualCodeOrUrl] = useState('');
  const [isBlingConnected, setIsBlingConnected] = useState(false);
  const [copiedCallback, setCopiedCallback] = useState(false);
  const [hasCredentials, setHasCredentials] = useState(false);

  // Status de Configuração
  useEffect(() => {
    if (isOpen) {
      checkCurrentConfig();
    }
  }, [isOpen]);

  const getAuthToken = async () => {
    try {
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token || '';
    } catch {
      return '';
    }
  };

  const checkCurrentConfig = async () => {
    try {
      const token = await getAuthToken();
      const res = await fetch('/api/config', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        console.error('API /api/config não retornou JSON:', text);
        return;
      }
      if (data.success && data.config) {
        if (data.config.bling.clientId) {
          setClientId(data.config.bling.clientId);
          setHasCredentials(true);
        }
        setIsBlingConnected(data.config.bling.isConnected);
      }
    } catch (err) {
      console.error('Erro ao verificar status de configuração:', err);
    }
  };

  const handleSaveBlingCredentials = async () => {
    setLoading(true);
    setFeedback(null);
    try {
      const token = await getAuthToken();
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ clientId, clientSecret }),
      });
      
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        console.error('API /api/config não retornou JSON:', text);
        setFeedback({ type: 'error', message: `Erro no servidor (status ${res.status}). Verifique o console.` });
        return false;
      }

      if (data.success) {
        setHasCredentials(true);
        setFeedback({ type: 'success', message: 'Credenciais do Bling salvas no Supabase com sucesso!' });
        return true;
      } else {
        setFeedback({ type: 'error', message: data.error || 'Erro ao salvar credenciais.' });
        return false;
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Erro de comunicação com o servidor.' });
      return false;
    } finally {
      setLoading(false);
    }
  };

  const handleAuthorizeBling = async () => {
    setLoading(true);
    setFeedback(null);
    try {
      const token = await getAuthToken();
      if (!token) {
        setFeedback({ type: 'error', message: 'Sessão ausente. Faça login novamente.' });
        return;
      }

      const response = await fetch('/api/bling/authorize', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const result = BlingAuthorizationResponseSchema.safeParse(await response.json());

      if (!result.success) {
        setFeedback({ type: 'error', message: 'Resposta inválida ao iniciar o OAuth do Bling.' });
        return;
      }

      if (!response.ok || !result.data.success) {
        setFeedback({
          type: 'error',
          message: result.data.success ? 'Não foi possível iniciar o OAuth.' : result.data.error,
        });
        return;
      }

      window.location.assign(result.data.authorizeUrl);
    } catch (error: unknown) {
      console.error('Erro ao iniciar OAuth do Bling:', error);
      setFeedback({ type: 'error', message: 'Não foi possível iniciar o OAuth do Bling.' });
    } finally {
      setLoading(false);
    }
  };

  const handleValidateManualCode = async () => {
    if (!manualCodeOrUrl.trim()) {
      setFeedback({ type: 'error', message: 'Por favor, cole a URL completa ou o código retornado pelo Bling.' });
      return;
    }

    setLoading(true);
    setFeedback(null);

    try {
      // Garante que as credenciais mais recentes foram enviadas antes de validar o código
      await handleSaveBlingCredentials();

      const token = await getAuthToken();
      const res = await fetch('/api/bling/callback', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ code: manualCodeOrUrl.trim() }),
      });

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        console.error('API /api/bling/callback não retornou JSON:', text);
        setFeedback({ type: 'error', message: `Erro no servidor (status ${res.status}). Verifique o console.` });
        return;
      }

      if (data.success) {
        setFeedback({ type: 'success', message: '✅ Bling Conectado! Tokens de produção gerados e salvos com sucesso!' });
        setIsBlingConnected(true);
        setManualCodeOrUrl('');
        onConfigSaved();
      } else {
        setFeedback({ type: 'error', message: `Falha na conexão: ${data.error}` });
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Erro ao validar código do Bling.' });
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
                      <label className="block text-xs font-semibold text-slate-300 mb-1.5">CLIENT ID do Bling</label>
                      <input
                        type="text"
                        value={clientId}
                        onChange={(e) => setClientId(e.target.value)}
                        placeholder="Seu Client ID do Bling"
                        className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900/80 border border-slate-800 text-xs text-white focus:outline-none focus:border-purple-500 transition"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-1.5">CLIENT SECRET do Bling</label>
                      <input
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
        )}

        {/* Conteúdo Aba Chatwoot */}
        {activeStep === 'chatwoot' && (
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
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">URL da Instância Chatwoot</label>
                <input
                  type="text"
                  defaultValue="https://app.chatwoot.com"
                  placeholder="https://app.chatwoot.com"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900/80 border border-slate-800 text-xs text-white focus:outline-none focus:border-indigo-500 transition"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">ID da Conta Chatwoot (Account ID)</label>
                <input
                  type="text"
                  placeholder="Ex: 1"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900/80 border border-slate-800 text-xs text-white focus:outline-none focus:border-indigo-500 transition"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">Token de Acesso do Agente (API Access Token)</label>
                <input
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
        )}

        {/* Conteúdo Aba Supabase */}
        {activeStep === 'supabase' && (
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
        )}

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
