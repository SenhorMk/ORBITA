/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { blingCredentialsPayloadSchema } from '@/lib/config/blingCredentialsContract';
import { IntegrationsPanel } from './IntegrationsPanel';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const CALLBACK_URL = 'https://orbita.mkautobots.site/api/bling/callback';

/** Resposta de `/api/integracoes/saude` com o Bling já no passo 1 concluído. */
function saudeComCredenciaisBling(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    bling_callback_url: CALLBACK_URL,
    conexoes: [{
      id: '1', provedor: 'bling', nome: 'Principal', status: 'pendente',
      health_status: 'disconnected', last_health_check_at: null, last_health_error: null,
      credenciais_configuradas: true,
    }],
    ...overrides,
  };
}

describe('IntegrationsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the real connection status returned by /api/integracoes/saude for Bling and Chatwoot', async () => {
    const fetchWithAuth = vi.fn(async (url: string) => {
      if (url === '/api/integracoes/saude') {
        return jsonResponse({
          success: true,
          conexoes: [
            { id: '1', provedor: 'bling', nome: 'Bling', status: 'conectado', health_status: 'healthy', last_health_check_at: null, last_health_error: null },
            { id: '2', provedor: 'chatwoot', nome: 'Chatwoot', status: 'erro', health_status: 'error', last_health_check_at: null, last_health_error: 'token invalido' },
          ],
        });
      }
      throw new Error(`Unhandled request: ${url}`);
    });

    render(<IntegrationsPanel fetchWithAuth={fetchWithAuth} />);

    expect(await screen.findByText(/healthy/i)).toBeInTheDocument();
    expect(screen.getByText(/token invalido/i)).toBeInTheDocument();
  });

  it('shows "não conectado" when the backend reports no connection, never inventing a connected state', async () => {
    const fetchWithAuth = vi.fn(async () => jsonResponse({ success: true, conexoes: [] }));

    render(<IntegrationsPanel fetchWithAuth={fetchWithAuth} />);

    expect(await screen.findAllByText(/não conectado/i)).not.toHaveLength(0);
  });

  it('starts the real Bling OAuth flow by calling /api/bling/authorize and redirecting to the returned URL', async () => {
    const user = userEvent.setup();
    const redirect = vi.fn();
    const fetchWithAuth = vi.fn(async (url: string) => {
      if (url === '/api/integracoes/saude') return jsonResponse(saudeComCredenciaisBling());
      if (url === '/api/bling/authorize') {
        return jsonResponse({ success: true, authorizeUrl: 'https://www.bling.com.br/Api/v3/oauth/authorize?state=abc' });
      }
      throw new Error(`Unhandled request: ${url}`);
    });

    render(<IntegrationsPanel fetchWithAuth={fetchWithAuth} onRedirect={redirect} />);
    await screen.findByText(/salvo/i);

    await user.click(screen.getByRole('button', { name: /conectar bling/i }));

    await waitFor(() => expect(redirect).toHaveBeenCalledWith('https://www.bling.com.br/Api/v3/oauth/authorize?state=abc'));
  });

  it('surfaces the server error instead of pretending the Bling connection started', async () => {
    const user = userEvent.setup();
    const redirect = vi.fn();
    const fetchWithAuth = vi.fn(async (url: string) => {
      if (url === '/api/integracoes/saude') return jsonResponse(saudeComCredenciaisBling());
      if (url === '/api/bling/authorize') {
        return jsonResponse({ success: false, error: 'Nenhum Client ID configurado para esta conta.' }, 409);
      }
      throw new Error(`Unhandled request: ${url}`);
    });

    render(<IntegrationsPanel fetchWithAuth={fetchWithAuth} onRedirect={redirect} />);
    await screen.findByText(/salvo/i);

    await user.click(screen.getByRole('button', { name: /conectar bling/i }));

    expect(await screen.findByText(/nenhum client id configurado/i)).toBeInTheDocument();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('saves the Bling app credentials through /api/bling/connect with a body the server schema accepts', async () => {
    // Lição dos tickets 26/27: a asserção não é "o cliente mandou algum corpo",
    // é "o corpo que a UI produz passa pelo validador que a rota realmente
    // usa". O schema importado aqui é o mesmo módulo que `POST
    // /api/bling/connect` executa.
    const user = userEvent.setup();
    const postConnect = vi.fn(async (url: string, options?: RequestInit) => {
      expect(url).toBe('/api/bling/connect');
      const parsed = blingCredentialsPayloadSchema.safeParse(JSON.parse(String(options?.body)));
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toEqual({ clientId: 'bling-client-id', clientSecret: 'bling-client-secret' });
      }
      return jsonResponse({ success: true, conexaoId: 'conn-bling', status: 'pendente' });
    });
    const fetchWithAuth = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/integracoes/saude') return jsonResponse({ success: true, conexoes: [] });
      if (url === '/api/bling/connect') return postConnect(url, options);
      throw new Error(`Unhandled request: ${url}`);
    });

    render(<IntegrationsPanel fetchWithAuth={fetchWithAuth} />);
    await screen.findAllByText(/não conectado/i);

    await user.type(screen.getByLabelText(/client id do bling/i), '  bling-client-id  ');
    await user.type(screen.getByLabelText(/client secret do bling/i), '  bling-client-secret  ');
    await user.click(screen.getByRole('button', { name: /salvar credenciais do bling/i }));

    await waitFor(() => expect(postConnect).toHaveBeenCalledTimes(1));
  });

  it('clears the Bling client secret from the form once it has been stored server-side', async () => {
    const user = userEvent.setup();
    const fetchWithAuth = vi.fn(async (url: string) => {
      if (url === '/api/integracoes/saude') return jsonResponse({ success: true, conexoes: [] });
      if (url === '/api/bling/connect') return jsonResponse({ success: true, conexaoId: 'conn-bling', status: 'pendente' });
      throw new Error(`Unhandled request: ${url}`);
    });

    render(<IntegrationsPanel fetchWithAuth={fetchWithAuth} />);
    await screen.findAllByText(/não conectado/i);

    await user.type(screen.getByLabelText(/client id do bling/i), 'bling-client-id');
    const secretField = screen.getByLabelText(/client secret do bling/i);
    await user.type(secretField, 'bling-client-secret');
    await user.click(screen.getByRole('button', { name: /salvar credenciais do bling/i }));

    await waitFor(() => expect(secretField).toHaveValue(''));
  });

  it('surfaces the server refusal instead of claiming the Bling credentials were saved', async () => {
    const user = userEvent.setup();
    const fetchWithAuth = vi.fn(async (url: string) => {
      if (url === '/api/integracoes/saude') return jsonResponse({ success: true, conexoes: [] });
      if (url === '/api/bling/connect') {
        return jsonResponse({ success: false, error: 'Capacidade insuficiente para gerenciar integrações' }, 403);
      }
      throw new Error(`Unhandled request: ${url}`);
    });

    render(<IntegrationsPanel fetchWithAuth={fetchWithAuth} />);
    await screen.findAllByText(/não conectado/i);

    await user.type(screen.getByLabelText(/client id do bling/i), 'bling-client-id');
    await user.type(screen.getByLabelText(/client secret do bling/i), 'bling-client-secret');
    await user.click(screen.getByRole('button', { name: /salvar credenciais do bling/i }));

    expect(await screen.findByText(/capacidade insuficiente/i)).toBeInTheDocument();
    expect(screen.queryByText(/credenciais do bling salvas/i)).not.toBeInTheDocument();
  });

  it('shows the Bling OAuth callback URL with a copy button, because it must be pasted into the Bling app', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    const fetchWithAuth = vi.fn(async () => jsonResponse({
      success: true,
      conexoes: [],
      bling_callback_url: CALLBACK_URL,
    }));

    render(<IntegrationsPanel fetchWithAuth={fetchWithAuth} />);
    await screen.findAllByText(/não conectado/i);

    // A URL exibida é a do servidor, não `window.location.origin` — que num
    // deploy de preview é um host efêmero.
    expect(screen.getByText(CALLBACK_URL)).toBeInTheDocument();
    expect(screen.queryByText(`${window.location.origin}/api/bling/callback`)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /copiar url de callback/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CALLBACK_URL));
  });

  it('mostra o passo 1 como salvo a partir do servidor, sobrevivendo ao reload', async () => {
    // Antes o "salvo" era estado local do React: recarregar a página apagava a
    // única pista de que o passo 1 tinha funcionado.
    const fetchWithAuth = vi.fn(async () => jsonResponse(saudeComCredenciaisBling()));

    render(<IntegrationsPanel fetchWithAuth={fetchWithAuth} />);

    expect(await screen.findByText(/salvo/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /conectar bling/i })).toBeEnabled();
  });

  it('bloqueia o passo 2 enquanto o passo 1 não estiver gravado, dizendo o motivo', async () => {
    const fetchWithAuth = vi.fn(async () => jsonResponse({
      success: true,
      conexoes: [],
      bling_callback_url: CALLBACK_URL,
    }));

    render(<IntegrationsPanel fetchWithAuth={fetchWithAuth} />);
    await screen.findAllByText(/não conectado/i);

    expect(screen.getByRole('button', { name: /conectar bling/i })).toBeDisabled();
    expect(screen.getByText(/depois que o passo 1 for salvo/i)).toBeInTheDocument();
  });

  it('mostra o status HTTP junto da mensagem, para 401, 403 e 500 não ficarem indistinguíveis', async () => {
    const user = userEvent.setup();
    const fetchWithAuth = vi.fn(async (url: string) => {
      if (url === '/api/integracoes/saude') return jsonResponse({ success: true, conexoes: [], bling_callback_url: CALLBACK_URL });
      if (url === '/api/bling/connect') {
        return jsonResponse({ success: false, error: 'Capacidade insuficiente para gerenciar integrações' }, 403);
      }
      throw new Error(`Unhandled request: ${url}`);
    });

    render(<IntegrationsPanel fetchWithAuth={fetchWithAuth} />);
    await screen.findAllByText(/não conectado/i);

    await user.type(screen.getByLabelText(/client id do bling/i), 'bling-client-id');
    await user.type(screen.getByLabelText(/client secret do bling/i), 'bling-client-secret');
    await user.click(screen.getByRole('button', { name: /salvar credenciais do bling/i }));

    expect(await screen.findByText(/HTTP 403/)).toBeInTheDocument();
    expect(screen.getByText(/capacidade insuficiente/i)).toBeInTheDocument();
  });

  it('o erro do passo 2 não apaga o erro do passo 1', async () => {
    // Este era o defeito que impedia diagnosticar: os dois passos dividiam um
    // único `setError`, então clicar em "Conectar" destruía a mensagem que
    // dizia por que o "Salvar" tinha falhado.
    const user = userEvent.setup();
    const fetchWithAuth = vi.fn(async (url: string) => {
      if (url === '/api/integracoes/saude') return jsonResponse(saudeComCredenciaisBling());
      if (url === '/api/bling/connect') return jsonResponse({ success: false, error: 'Falha ao salvar credenciais do Bling' }, 500);
      if (url === '/api/bling/authorize') return jsonResponse({ success: false, error: 'Nenhum Client ID configurado para esta conta.' }, 409);
      throw new Error(`Unhandled request: ${url}`);
    });

    render(<IntegrationsPanel fetchWithAuth={fetchWithAuth} />);
    await screen.findByText(/salvo/i);

    await user.type(screen.getByLabelText(/client id do bling/i), 'bling-client-id');
    await user.type(screen.getByLabelText(/client secret do bling/i), 'bling-client-secret');
    await user.click(screen.getByRole('button', { name: /salvar credenciais do bling/i }));
    expect(await screen.findByText(/HTTP 500/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /conectar bling/i }));

    expect(await screen.findByText(/HTTP 409/)).toBeInTheDocument();
    // A mensagem do passo 1 continua na tela.
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
  });

  it('diz que falta configurar a origem estável em vez de exibir uma URL que vai quebrar', async () => {
    const fetchWithAuth = vi.fn(async () => jsonResponse({
      success: true,
      conexoes: [],
      bling_callback_url: null,
    }));

    render(<IntegrationsPanel fetchWithAuth={fetchWithAuth} />);
    await screen.findAllByText(/não conectado/i);

    expect(screen.getByText(/origem pública do ORBITA ainda não está configurada/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /copiar url de callback/i })).not.toBeInTheDocument();
  });

  it('reporta falha de rede sem status, em vez de silenciar o clique', async () => {
    const user = userEvent.setup();
    const fetchWithAuth = vi.fn(async (url: string) => {
      if (url === '/api/integracoes/saude') return jsonResponse({ success: true, conexoes: [], bling_callback_url: CALLBACK_URL });
      throw new Error('Failed to fetch');
    });

    render(<IntegrationsPanel fetchWithAuth={fetchWithAuth} />);
    await screen.findAllByText(/não conectado/i);

    await user.type(screen.getByLabelText(/client id do bling/i), 'bling-client-id');
    await user.type(screen.getByLabelText(/client secret do bling/i), 'bling-client-secret');
    await user.click(screen.getByRole('button', { name: /salvar credenciais do bling/i }));

    expect(await screen.findByText(/Failed to fetch/i)).toBeInTheDocument();
  });

  it('connects Chatwoot through the real API with only the credential fields the server requires', async () => {
    const user = userEvent.setup();
    const postConnect = vi.fn(async (url: string, options?: RequestInit) => {
      expect(url).toBe('/api/chatwoot/connect');
      const body = JSON.parse(String(options?.body));
      expect(body).toEqual({ api_url: 'https://chatwoot.example.com', api_token: 'tok-123', account_id: '42', webhook_secret: 'whsec-abc' });
      return jsonResponse({ success: true, conexaoId: 'conn-1', webhookUrl: '/api/chatwoot/webhook/conn-1' });
    });
    const fetchWithAuth = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/integracoes/saude') return jsonResponse({ success: true, conexoes: [] });
      if (url === '/api/chatwoot/connect') return postConnect(url, options);
      throw new Error(`Unhandled request: ${url}`);
    });

    render(<IntegrationsPanel fetchWithAuth={fetchWithAuth} />);
    await screen.findAllByText(/não conectado/i);

    await user.type(screen.getByLabelText(/url da instância chatwoot/i), 'https://chatwoot.example.com');
    await user.type(screen.getByLabelText(/token da api/i), 'tok-123');
    await user.type(screen.getByLabelText(/id da conta/i), '42');
    await user.type(screen.getByLabelText(/segredo do webhook/i), 'whsec-abc');
    await user.click(screen.getByRole('button', { name: /conectar chatwoot/i }));

    await waitFor(() => expect(postConnect).toHaveBeenCalledTimes(1));
  });
});
