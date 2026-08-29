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
  /** Se o passo 1 (credenciais do aplicativo) já está gravado no servidor. */
  credenciais_configuradas: boolean;
}

/**
 * Falha de uma ação do painel, com o status HTTP junto da mensagem.
 *
 * Sem o status, `401`, `403` e `500` chegam indistinguíveis a quem está
 * configurando — foi exatamente o que impediu diagnosticar por que as
 * credenciais do Bling não salvavam.
 */
interface StepFailure {
  readonly status: number;
  readonly message: string;
}

/** Extrai a falha da resposta sem depender de o corpo ser JSON. */
async function readFailure(response: Response): Promise<StepFailure> {
  try {
    const body = await response.json();
    const message = typeof body?.error === 'string' ? body.error : 'A requisição falhou.';
    return { status: response.status, message };
  } catch {
    return { status: response.status, message: 'O servidor respondeu em um formato inesperado.' };
  }
}

/** Mensagem única exibida ao usuário, sempre carregando o status HTTP. */
function StepError({ failure }: { readonly failure: StepFailure | null }) {
  if (!failure) return null;
  return (
    <p role="alert" className="text-xs text-red-300">
      <span className="font-semibold">HTTP {failure.status}</span> — {failure.message}
    </p>
  );
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

/**
 * Bloco da URL de retorno OAuth, que o lojista cola no cadastro do app no Bling.
 *
 * A URL vem do **servidor** (`/api/integracoes/saude`), nunca de
 * `window.location.origin`: num deploy de preview a origem do navegador é um
 * host efêmero, e o cookie da transação OAuth é gravado no host onde o fluxo
 * começa — iniciar numa origem e receber o retorno em outra nunca funciona.
 */
function BlingCallbackUrlField({ callbackUrl }: { readonly callbackUrl: string | null }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  async function handleCopy() {
    if (!callbackUrl) return;
    await navigator.clipboard.writeText(callbackUrl);
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 2000);
  }

  if (!callbackUrl) {
    return (
      <div className="space-y-1 pt-1">
        <p role="alert" className="text-xs text-amber-300">
          A origem pública do ORBITA ainda não está configurada no servidor, então a URL de retorno não pode
          ser informada com segurança. Defina <code className="text-amber-200">APP_BASE_URL</code> com o
          domínio estável (por exemplo <code className="text-amber-200">https://orbita.mkautobots.site</code>)
          e recarregue. Cadastrar uma URL de preview no Bling faz a conexão quebrar no próximo deploy.
        </p>
      </div>
    );
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
          variant="outline"
          size="sm"
          aria-label="Copiar URL de callback"
          onClick={handleCopy}
        >
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          {copied ? 'Copiado' : 'Copiar'}
        </Button>
      </div>
      <p className="text-[11px] text-slate-500">
        Conecte o Bling a partir deste mesmo endereço. Iniciar a autorização em outra origem (uma URL de
        preview, por exemplo) faz o retorno chegar sem o cookie da transação e a conexão falha.
      </p>
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
  callbackUrl,
}: ProviderCardProps & {
  readonly onRedirect: (url: string) => void;
  readonly callbackUrl: string | null;
}) {
  // Um estado de falha por passo. Antes os dois compartilhavam `setError`, e o
  // clique no passo 2 apagava a mensagem do passo 1 — a causa real do problema
  // desaparecia da tela antes de alguém conseguir lê-la.
  const [saveFailure, setSaveFailure] = useState<StepFailure | null>(null);
  const [authorizeFailure, setAuthorizeFailure] = useState<StepFailure | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);

  // A autoridade sobre o passo 1 é o servidor, não estado local do React: o
  // booleano sobrevive ao reload e diz a verdade sobre o que está gravado.
  const credenciaisConfiguradas = conexao?.credenciais_configuradas ?? false;

  async function handleSaveCredentials(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaveFailure(null);
    setAuthorizeFailure(null);
    try {
      const response = await fetchWithAuth('/api/bling/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildBlingCredentialsPayload(clientId, clientSecret)),
      });
      if (!response.ok) {
        setSaveFailure(await readFailure(response));
        return;
      }
      const body = await response.json();
      if (!body.success) {
        setSaveFailure({ status: response.status, message: body.error ?? 'Falha ao salvar as credenciais do Bling' });
        return;
      }
      setClientSecret('');
      await onConnectionChanged();
    } catch (error: unknown) {
      // Falha de rede não tem status HTTP; `0` marca "a requisição nem chegou".
      setSaveFailure({ status: 0, message: error instanceof Error ? error.message : 'Falha de rede ao salvar as credenciais.' });
    } finally {
      setSaving(false);
    }
  }

  async function handleAuthorize() {
    setConnecting(true);
    setAuthorizeFailure(null);
    try {
      const response = await fetchWithAuth('/api/bling/authorize');
      if (!response.ok) {
        setAuthorizeFailure(await readFailure(response));
        return;
      }
      const body = await response.json();
      if (!body.success || typeof body.authorizeUrl !== 'string') {
        setAuthorizeFailure({ status: response.status, message: body.error ?? 'Falha ao iniciar conexão com o Bling' });
        return;
      }
      onRedirect(body.authorizeUrl);
    } catch (error: unknown) {
      setAuthorizeFailure({ status: 0, message: error instanceof Error ? error.message : 'Falha de rede ao iniciar a autorização.' });
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

      <form onSubmit={handleSaveCredentials} className="space-y-2 pt-1">
        <div className="flex items-center gap-2">
          <p className="text-xs font-semibold text-slate-300">Passo 1 — credenciais do seu aplicativo no Bling</p>
          {credenciaisConfiguradas ? (
            <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-[#30D158]/15 text-[#30D158] border border-[#30D158]/30 flex items-center gap-1">
              <CheckCircle className="w-2.5 h-2.5" /> Salvo
            </span>
          ) : (
            <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-white/10 text-slate-300 border border-white/15">
              Pendente
            </span>
          )}
        </div>
        {credenciaisConfiguradas && (
          <p className="text-[11px] text-slate-500">
            Já existem credenciais gravadas para esta organização. Preencher de novo substitui as anteriores.
          </p>
        )}

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

        <BlingCallbackUrlField callbackUrl={callbackUrl} />

        <Button type="submit" size="sm" disabled={saving}>
          {saving ? 'Salvando…' : 'Salvar credenciais do Bling'}
        </Button>
        <StepError failure={saveFailure} />
      </form>

      <div className="space-y-2 pt-2 border-t border-white/10">
        <p className="text-xs font-semibold text-slate-300">Passo 2 — autorizar o acesso (OAuth)</p>
        {!credenciaisConfiguradas && (
          <p className="text-[11px] text-slate-500">
            Disponível depois que o Passo 1 for salvo — a autorização precisa do Client ID gravado no servidor.
          </p>
        )}
        <Button
          type="button"
          size="sm"
          disabled={connecting || !credenciaisConfiguradas}
          onClick={handleAuthorize}
        >
          {connecting ? 'Conectando…' : 'Conectar Bling'}
        </Button>
        <StepError failure={authorizeFailure} />
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
  const [callbackUrl, setCallbackUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadHealth = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/api/integracoes/saude');
      const body = await response.json();
      if (response.ok) {
        setConexoes(body.conexoes ?? []);
        // A URL de retorno é decidida no servidor; o cliente só a exibe.
        setCallbackUrl(typeof body.bling_callback_url === 'string' ? body.bling_callback_url : null);
      }
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
            callbackUrl={callbackUrl}
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
