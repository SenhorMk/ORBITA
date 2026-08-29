'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ShoppingBag, MessageCircle, CheckCircle, XCircle, AlertTriangle, Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { buildBlingCredentialsPayload } from '@/lib/config/blingCredentialsContract';

interface ConexaoIntegracao {
  id: string;
  provedor: string;
  nome: string;
  status: string;
  health_status: 'healthy' | 'degraded' | 'disconnected' | 'error';
  last_health_check_at: string | null;
  last_health_error: string | null;
}

/** Boundary de rede autenticada compartilhada pelos cartões de integração. */
type FetchWithAuth = (url: string, options?: RequestInit) => Promise<Response>;

export interface IntegrationsPanelProps {
  /** Authenticated fetch boundary (Supabase bearer token attached by the caller). */
  fetchWithAuth: FetchWithAuth;
  /** Navigation seam so tests never trigger a real browser redirect. Defaults to `window.location.href`. */
  onRedirect?: (url: string) => void;
}

const FIELD_CLASS =
  'w-full rounded-lg bg-black/30 border border-white/10 px-2 py-1.5 text-sm text-white transition-colors duration-150 focus:border-[#0A84FF] focus:outline-none';

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

/** Bloco da URL de retorno OAuth, que o lojista precisa colar no cadastro do app no Bling. */
function BlingCallbackUrlField() {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  // A URL depende da origem real do navegador; no render do servidor o bloco
  // fica vazio em vez de exibir um endereço inventado.
  const callbackUrl = typeof window !== 'undefined' ? `${window.location.origin}/api/bling/callback` : '';

  async function handleCopy() {
    if (!callbackUrl) return;
    await navigator.clipboard.writeText(callbackUrl);
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-1 pt-1">
      <p className="text-xs text-slate-400">Cole esta URL de retorno no cadastro do aplicativo dentro do Bling:</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 truncate rounded-lg bg-black/40 border border-white/10 px-2 py-1.5 text-[11px] text-[#0A84FF] select-all">
          {callbackUrl}
        </code>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={handleCopy}
          aria-label="Copiar URL de callback do Bling"
        >
          {copied ? <Check className="w-3 h-3 text-[#30D158]" /> : <Copy className="w-3 h-3" />}
          <span className="ml-1">{copied ? 'Copiado' : 'Copiar'}</span>
        </Button>
      </div>
      <span aria-live="polite" className="sr-only">
        {copied ? 'URL de callback copiada' : ''}
      </span>
    </div>
  );
}

interface ProviderCardProps {
  readonly fetchWithAuth: FetchWithAuth;
  readonly conexao: ConexaoIntegracao | undefined;
  readonly onConnectionChanged: () => Promise<void>;
}

/**
 * Cartão do Bling: passo 1 registra as credenciais do aplicativo da
 * organização em `POST /api/bling/connect`; passo 2 inicia o OAuth real. O
 * `client_secret` sai do formulário assim que o servidor confirma que o
 * guardou cifrado, e nenhum estado de conexão é decidido no cliente.
 */
function BlingIntegrationCard({
  fetchWithAuth,
  conexao,
  onConnectionChanged,
  onRedirect,
}: ProviderCardProps & { readonly onRedirect: (url: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [credentialsSaved, setCredentialsSaved] = useState(false);

  async function handleSaveCredentials(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setCredentialsSaved(false);
    try {
      const response = await fetchWithAuth('/api/bling/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildBlingCredentialsPayload(clientId, clientSecret)),
      });
      const body = await response.json();
      if (!response.ok || !body.success) {
        setError(body.error ?? 'Falha ao salvar as credenciais do Bling');
        return;
      }
      setClientSecret('');
      setCredentialsSaved(true);
      await onConnectionChanged();
    } finally {
      setSaving(false);
    }
  }

  async function handleAuthorize() {
    setConnecting(true);
    setError(null);
    try {
      const response = await fetchWithAuth('/api/bling/authorize');
      const body = await response.json();
      if (!response.ok || !body.success) {
        setError(body.error ?? 'Falha ao iniciar conexão com o Bling');
        return;
      }
      onRedirect(body.authorizeUrl);
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="space-y-2 rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white flex items-center gap-1.5">
          <ShoppingBag className="w-4 h-4 text-[#0A84FF]" /> Bling ERP
        </h3>
        {statusBadge(conexao)}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      )}

      <form onSubmit={handleSaveCredentials} className="space-y-2 pt-1">
        <p className="text-xs font-semibold text-slate-300">Passo 1 — credenciais do seu aplicativo no Bling</p>
        <label className="block text-xs text-slate-400" htmlFor="bling-client-id">
          Client ID do Bling
        </label>
        <input
          id="bling-client-id"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          autoComplete="off"
          className={FIELD_CLASS}
          required
        />
        <label className="block text-xs text-slate-400" htmlFor="bling-client-secret">
          Client Secret do Bling
        </label>
        <input
          id="bling-client-secret"
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          autoComplete="off"
          className={FIELD_CLASS}
          required
        />

        <BlingCallbackUrlField />

        <Button type="submit" size="sm" disabled={saving}>
          {saving ? 'Salvando…' : 'Salvar credenciais do Bling'}
        </Button>
        {credentialsSaved && (
          <p className="text-xs text-[#30D158]">Credenciais do Bling salvas. Agora autorize o acesso no passo 2.</p>
        )}
      </form>

      <div className="space-y-2 pt-2 border-t border-white/10">
        <p className="text-xs font-semibold text-slate-300">Passo 2 — autorizar o acesso (OAuth)</p>
        <Button type="button" size="sm" disabled={connecting} onClick={handleAuthorize}>
          {connecting ? 'Conectando…' : 'Conectar Bling'}
        </Button>
      </div>
    </div>
  );
}

/** Cartão do Chatwoot: salva as credenciais da instância em `POST /api/chatwoot/connect`. */
function ChatwootIntegrationCard({ fetchWithAuth, conexao, onConnectionChanged }: ProviderCardProps) {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [accountId, setAccountId] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setConnecting(true);
    setError(null);
    try {
      const response = await fetchWithAuth('/api/chatwoot/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_url: url || undefined,
          api_token: token,
          account_id: accountId,
          webhook_secret: webhookSecret,
        }),
      });
      const body = await response.json();
      if (!response.ok || !body.success) {
        setError(body.error ?? 'Falha ao conectar Chatwoot');
        return;
      }
      setToken('');
      setWebhookSecret('');
      await onConnectionChanged();
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="space-y-2 rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white flex items-center gap-1.5">
          <MessageCircle className="w-4 h-4 text-green-400" /> Chatwoot
        </h3>
        {statusBadge(conexao)}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      )}
      <form onSubmit={handleSubmit} className="space-y-2">
        <label className="block text-xs text-slate-400" htmlFor="chatwoot-url">
          URL da instância Chatwoot
        </label>
        <input id="chatwoot-url" value={url} onChange={(e) => setUrl(e.target.value)} className={FIELD_CLASS} />
        <label className="block text-xs text-slate-400" htmlFor="chatwoot-token">
          Token da API
        </label>
        <input
          id="chatwoot-token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className={FIELD_CLASS}
          required
        />
        <label className="block text-xs text-slate-400" htmlFor="chatwoot-account">
          ID da conta
        </label>
        <input
          id="chatwoot-account"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className={FIELD_CLASS}
          required
        />
        <label className="block text-xs text-slate-400" htmlFor="chatwoot-webhook-secret">
          Segredo do webhook
        </label>
        <input
          id="chatwoot-webhook-secret"
          value={webhookSecret}
          onChange={(e) => setWebhookSecret(e.target.value)}
          className={FIELD_CLASS}
          required
        />
        <Button type="submit" size="sm" disabled={connecting}>
          {connecting ? 'Conectando…' : 'Conectar Chatwoot'}
        </Button>
      </form>
    </div>
  );
}

/**
 * Aba Integrações (Ticket 24b, ampliada no Ticket 28): a tela nunca decide se
 * a conexão está ativa — apenas exibe o resultado de `/api/integracoes/saude`.
 * Registrar credenciais e iniciar o OAuth chamam as rotas reais já verificadas
 * no servidor; nenhum estado de conexão é inventado no cliente. É a única UI
 * de configuração de integrações do produto desde a remoção do `SetupWizard`.
 */
export function IntegrationsPanel({ fetchWithAuth, onRedirect }: IntegrationsPanelProps) {
  const redirect = onRedirect ?? ((url: string) => { window.location.href = url; });

  const [conexoes, setConexoes] = useState<ConexaoIntegracao[]>([]);
  const [isLoading, setIsLoading] = useState(true);

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

  return (
    <div className="space-y-6 text-slate-200">
      <h2 className="text-lg font-semibold text-white">Integrações</h2>

      {isLoading ? (
        <div className="text-sm text-slate-400">Carregando status das integrações…</div>
      ) : (
        <>
          <BlingIntegrationCard
            fetchWithAuth={fetchWithAuth}
            conexao={conexoes.find((c) => c.provedor === 'bling')}
            onConnectionChanged={loadHealth}
            onRedirect={redirect}
          />
          <ChatwootIntegrationCard
            fetchWithAuth={fetchWithAuth}
            conexao={conexoes.find((c) => c.provedor === 'chatwoot')}
            onConnectionChanged={loadHealth}
          />
        </>
      )}
    </div>
  );
}
