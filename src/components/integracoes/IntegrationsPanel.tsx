'use client';

import { useCallback, useEffect, useState } from 'react';
import { ShoppingBag, MessageCircle, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ConexaoIntegracao {
  id: string;
  provedor: string;
  nome: string;
  status: string;
  health_status: 'healthy' | 'degraded' | 'disconnected' | 'error';
  last_health_check_at: string | null;
  last_health_error: string | null;
}

export interface IntegrationsPanelProps {
  /** Authenticated fetch boundary (Supabase bearer token attached by the caller). */
  fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response>;
  /** Navigation seam so tests never trigger a real browser redirect. Defaults to `window.location.href`. */
  onRedirect?: (url: string) => void;
}

function statusBadge(conexao: ConexaoIntegracao | undefined) {
  if (!conexao) {
    return (
      <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-white/10 text-slate-300 border border-white/15 flex items-center gap-1">
        <XCircle className="w-2.5 h-2.5" /> Não conectado
      </span>
    );
  }
  const isHealthy = conexao.health_status === 'healthy';
  return (
    <span
      className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border flex items-center gap-1 ${
        isHealthy
          ? 'bg-[#30D158]/15 text-[#30D158] border-[#30D158]/30'
          : 'bg-red-500/15 text-red-300 border-red-500/30'
      }`}
    >
      {isHealthy ? <CheckCircle className="w-2.5 h-2.5" /> : <AlertTriangle className="w-2.5 h-2.5" />}
      {conexao.health_status}
      {conexao.last_health_error ? ` — ${conexao.last_health_error}` : ''}
    </span>
  );
}

/**
 * Conectar Bling/Chatwoot (Ticket 24b): a tela nunca decide se a conexão está
 * ativa — apenas exibe o resultado de `/api/integracoes/saude`. Iniciar o
 * OAuth Bling ou salvar credenciais Chatwoot chama a rota real já verificada
 * no servidor; nenhum estado de conexão é inventado no cliente.
 */
export function IntegrationsPanel({ fetchWithAuth, onRedirect }: IntegrationsPanelProps) {
  const redirect = onRedirect ?? ((url: string) => { window.location.href = url; });

  const [conexoes, setConexoes] = useState<ConexaoIntegracao[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [blingError, setBlingError] = useState<string | null>(null);
  const [connectingBling, setConnectingBling] = useState(false);

  const [chatwootUrl, setChatwootUrl] = useState('');
  const [chatwootToken, setChatwootToken] = useState('');
  const [chatwootAccountId, setChatwootAccountId] = useState('');
  const [chatwootWebhookSecret, setChatwootWebhookSecret] = useState('');
  const [chatwootError, setChatwootError] = useState<string | null>(null);
  const [connectingChatwoot, setConnectingChatwoot] = useState(false);

  const loadHealth = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/api/integracoes/saude');
      const body = await response.json();
      if (response.ok) setConexoes(body.conexoes ?? []);
    } finally {
      setIsLoading(false);
    }
  }, [fetchWithAuth]);

  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  const blingConexao = conexoes.find((c) => c.provedor === 'bling');
  const chatwootConexao = conexoes.find((c) => c.provedor === 'chatwoot');

  async function handleConnectBling() {
    setConnectingBling(true);
    setBlingError(null);
    try {
      const response = await fetchWithAuth('/api/bling/authorize');
      const body = await response.json();
      if (!response.ok || !body.success) {
        setBlingError(body.error ?? 'Falha ao iniciar conexão com o Bling');
        return;
      }
      redirect(body.authorizeUrl);
    } finally {
      setConnectingBling(false);
    }
  }

  async function handleConnectChatwoot(event: React.FormEvent) {
    event.preventDefault();
    setConnectingChatwoot(true);
    setChatwootError(null);
    try {
      const response = await fetchWithAuth('/api/chatwoot/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_url: chatwootUrl || undefined,
          api_token: chatwootToken,
          account_id: chatwootAccountId,
          webhook_secret: chatwootWebhookSecret,
        }),
      });
      const body = await response.json();
      if (!response.ok || !body.success) {
        setChatwootError(body.error ?? 'Falha ao conectar Chatwoot');
        return;
      }
      setChatwootToken('');
      setChatwootWebhookSecret('');
      await loadHealth();
    } finally {
      setConnectingChatwoot(false);
    }
  }

  return (
    <div className="space-y-6 text-slate-200">
      <h2 className="text-lg font-semibold text-white">Integrações</h2>

      {isLoading ? (
        <div className="text-sm text-slate-400">Carregando status das integrações…</div>
      ) : (
        <>
          <div className="space-y-2 rounded-xl border border-white/10 bg-white/5 p-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white flex items-center gap-1.5">
                <ShoppingBag className="w-4 h-4 text-[#0A84FF]" /> Bling ERP
              </h3>
              {statusBadge(blingConexao)}
            </div>
            {blingError && (
              <p role="alert" className="text-xs text-red-300">
                {blingError}
              </p>
            )}
            <Button type="button" size="sm" disabled={connectingBling} onClick={handleConnectBling}>
              {connectingBling ? 'Conectando…' : 'Conectar Bling'}
            </Button>
          </div>

          <div className="space-y-2 rounded-xl border border-white/10 bg-white/5 p-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white flex items-center gap-1.5">
                <MessageCircle className="w-4 h-4 text-green-400" /> Chatwoot
              </h3>
              {statusBadge(chatwootConexao)}
            </div>
            {chatwootError && (
              <p role="alert" className="text-xs text-red-300">
                {chatwootError}
              </p>
            )}
            <form onSubmit={handleConnectChatwoot} className="space-y-2">
              <label className="block text-xs text-slate-400" htmlFor="chatwoot-url">
                URL da instância Chatwoot
              </label>
              <input
                id="chatwoot-url"
                value={chatwootUrl}
                onChange={(e) => setChatwootUrl(e.target.value)}
                className="w-full rounded-lg bg-black/30 border border-white/10 px-2 py-1.5 text-sm text-white"
              />
              <label className="block text-xs text-slate-400" htmlFor="chatwoot-token">
                Token da API
              </label>
              <input
                id="chatwoot-token"
                value={chatwootToken}
                onChange={(e) => setChatwootToken(e.target.value)}
                className="w-full rounded-lg bg-black/30 border border-white/10 px-2 py-1.5 text-sm text-white"
                required
              />
              <label className="block text-xs text-slate-400" htmlFor="chatwoot-account">
                ID da conta
              </label>
              <input
                id="chatwoot-account"
                value={chatwootAccountId}
                onChange={(e) => setChatwootAccountId(e.target.value)}
                className="w-full rounded-lg bg-black/30 border border-white/10 px-2 py-1.5 text-sm text-white"
                required
              />
              <label className="block text-xs text-slate-400" htmlFor="chatwoot-webhook-secret">
                Segredo do webhook
              </label>
              <input
                id="chatwoot-webhook-secret"
                value={chatwootWebhookSecret}
                onChange={(e) => setChatwootWebhookSecret(e.target.value)}
                className="w-full rounded-lg bg-black/30 border border-white/10 px-2 py-1.5 text-sm text-white"
                required
              />
              <Button type="submit" size="sm" disabled={connectingChatwoot}>
                {connectingChatwoot ? 'Conectando…' : 'Conectar Chatwoot'}
              </Button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
