/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { blingCredentialsPayloadSchema } from '@/lib/config/blingCredentialsContract';
import { IntegrationsPanel } from './IntegrationsPanel';
import type { SelecaoDeOrganizacao } from '@/components/organizacao/usePapelNaOrganizacaoAtiva';
import { PRAZO_DA_INTEGRACAO_MS } from './comPrazo';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const CALLBACK_URL = 'https://orbita.mkautobots.site/api/bling/callback';
const ORG_A: SelecaoDeOrganizacao = { id: 'org-a', versao: 1 };
const ORG_B: SelecaoDeOrganizacao = { id: 'org-b', versao: 2 };

/** Uma conexão como `/api/integracoes/saude` a devolve. */
function conexao(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1', provedor: 'bling', nome: 'Principal', status: 'pendente',
    health_status: 'healthy', last_health_check_at: null, last_health_error: null,
    credenciais_configuradas: true,
    ...overrides,
  };
}

function saude(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    bling_callback_url: CALLBACK_URL,
    chatwoot_webhook_url: null,
    conexoes: [conexao()],
    ...overrides,
  };
}

/** Renderiza o painel numa organização, com a saúde que o teste descrever. */
function renderPainel(
  fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response>,
  props: Partial<React.ComponentProps<typeof IntegrationsPanel>> = {},
) {
  return render(
    <IntegrationsPanel fetchWithAuth={fetchWithAuth} selecao={ORG_A} nomeDaOrganizacao="Empresa A" {...props} />,
  );
}

describe('IntegrationsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('estado sustentado por evidência', () => {
    it('não trata o default healthy da coluna como saúde: sem verificação, diz "não verificado"', async () => {
      const fetchWithAuth = vi.fn(async () => jsonResponse(saude({
        conexoes: [conexao({ status: 'conectado', health_status: 'healthy', last_health_check_at: null })],
      })));

      renderPainel(fetchWithAuth);

      expect(await screen.findByText(/não verificado/i)).toBeInTheDocument();
      expect(screen.queryByText(/^conectado$/i)).not.toBeInTheDocument();
      // E nada de "healthy" cru, nem de "Sistemas Online".
      expect(screen.queryByText(/healthy/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/sistemas online/i)).not.toBeInTheDocument();
    });

    it('salvar credenciais do Bling não é estar autorizado', async () => {
      const fetchWithAuth = vi.fn(async () => jsonResponse(saude({
        conexoes: [conexao({ status: 'pendente', credenciais_configuradas: true })],
      })));

      renderPainel(fetchWithAuth);

      expect(await screen.findByText(/^configurado$/i)).toBeInTheDocument();
      expect(screen.getByText(/falta autorizar o acesso/i)).toBeInTheDocument();
    });

    it('sem conexão nenhuma, diz "não configurado" em vez de inventar estado', async () => {
      const fetchWithAuth = vi.fn(async () => jsonResponse(saude({ conexoes: [] })));

      renderPainel(fetchWithAuth);

      // Bling e Chatwoot.
      await waitFor(() => expect(screen.getAllByText(/não configurado/i)).toHaveLength(2));
    });

    it('uma verificação antiga aparece como evidência datada, nunca como "Conectado"', async () => {
      const fetchWithAuth = vi.fn(async () => jsonResponse(saude({
        conexoes: [conexao({
          status: 'conectado', health_status: 'healthy',
          last_health_check_at: '2025-01-04T08:30:00Z',
        })],
      })));

      renderPainel(fetchWithAuth);

      expect(await screen.findByText(/^verificado$/i)).toBeInTheDocument();
      expect(screen.queryByText(/^conectado$/i)).not.toBeInTheDocument();
      expect(screen.getByText(/04\/01\/2025 08:30 UTC/)).toBeInTheDocument();
    });

    it('mostra o erro real da última verificação, e só quando houve uma', async () => {
      const fetchWithAuth = vi.fn(async () => jsonResponse(saude({
        conexoes: [conexao({
          status: 'conectado', health_status: 'error',
          last_health_check_at: '2026-09-10T12:00:00Z', last_health_error: 'token expirado',
        })],
      })));

      renderPainel(fetchWithAuth);

      expect(await screen.findByText(/token expirado/i)).toBeInTheDocument();
    });
  });

  describe('Bling', () => {
    it('salva as credenciais pelo contrato compartilhado, carimbando a organização da tela', async () => {
      const user = userEvent.setup();
      let corpo: unknown = null;
      const fetchWithAuth = vi.fn(async (url: string, options?: RequestInit) => {
        if (url === '/api/integracoes/saude') return jsonResponse(saude({ conexoes: [] }));
        if (url === '/api/bling/connect') {
          corpo = JSON.parse(String(options?.body));
          return jsonResponse({ success: true, conexaoId: 'c1', status: 'pendente' });
        }
        throw new Error(`Unhandled request: ${url}`);
      });

      renderPainel(fetchWithAuth);
      await screen.findByLabelText(/client id do bling/i);

      await user.type(screen.getByLabelText(/client id do bling/i), 'client-abc');
      await user.type(screen.getByLabelText(/client secret do bling/i), 'secret-xyz');
      await user.click(screen.getByRole('button', { name: /salvar credenciais do bling/i }));

      await waitFor(() => expect(corpo).not.toBeNull());
      expect(blingCredentialsPayloadSchema.safeParse(corpo).success).toBe(true);
      expect(corpo).toMatchObject({ clientId: 'client-abc', clientSecret: 'secret-xyz', organizacaoEsperada: 'org-a' });
    });

    it('inicia o OAuth real e redireciona para a URL devolvida pelo servidor', async () => {
      const user = userEvent.setup();
      const redirect = vi.fn();
      const fetchWithAuth = vi.fn(async (url: string) => {
        if (url === '/api/integracoes/saude') return jsonResponse(saude());
        if (url.startsWith('/api/bling/authorize')) {
          return jsonResponse({ success: true, authorizeUrl: 'https://www.bling.com.br/Api/v3/oauth/authorize?state=abc' });
        }
        throw new Error(`Unhandled request: ${url}`);
      });

      renderPainel(fetchWithAuth, { onRedirect: redirect });
      await screen.findByRole('button', { name: /conectar bling/i });

      await user.click(screen.getByRole('button', { name: /conectar bling/i }));

      await waitFor(() => expect(redirect).toHaveBeenCalledWith('https://www.bling.com.br/Api/v3/oauth/authorize?state=abc'));
      // A organização da tela viaja junto, para o servidor recusar se ela mudou.
      expect(fetchWithAuth).toHaveBeenCalledWith(
        '/api/bling/authorize?organizacao_esperada=org-a',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('bloqueia o Passo 2 enquanto o Passo 1 não estiver gravado, dizendo o motivo', async () => {
      const fetchWithAuth = vi.fn(async () => jsonResponse(saude({ conexoes: [] })));

      renderPainel(fetchWithAuth);

      expect(await screen.findByRole('button', { name: /conectar bling/i })).toBeDisabled();
      expect(screen.getByText(/precisa do client id gravado no servidor/i)).toBeInTheDocument();
    });

    it('mostra o status HTTP junto da mensagem, para 401, 403 e 500 não ficarem indistinguíveis', async () => {
      const user = userEvent.setup();
      const fetchWithAuth = vi.fn(async (url: string) => {
        if (url === '/api/integracoes/saude') return jsonResponse(saude());
        return jsonResponse({ success: false, error: 'Capacidade insuficiente para gerenciar integrações' }, 403);
      });

      renderPainel(fetchWithAuth);
      await user.click(await screen.findByRole('button', { name: /conectar bling/i }));

      const alerta = await screen.findByRole('alert');
      expect(alerta).toHaveTextContent(/HTTP 403/);
      expect(alerta).toHaveTextContent(/capacidade insuficiente/i);
    });

    it('o erro do Passo 2 não apaga o erro do Passo 1', async () => {
      const user = userEvent.setup();
      const fetchWithAuth = vi.fn(async (url: string) => {
        if (url === '/api/integracoes/saude') return jsonResponse(saude());
        if (url === '/api/bling/connect') return jsonResponse({ success: false, error: 'client id recusado' }, 400);
        return jsonResponse({ success: false, error: 'autorizacao recusada' }, 409);
      });

      renderPainel(fetchWithAuth);
      await screen.findByLabelText(/client id do bling/i);
      await user.type(screen.getByLabelText(/client id do bling/i), 'x');
      await user.type(screen.getByLabelText(/client secret do bling/i), 'y');
      await user.click(screen.getByRole('button', { name: /salvar credenciais do bling/i }));
      await screen.findByText(/client id recusado/i);

      await user.click(screen.getByRole('button', { name: /conectar bling/i }));
      await screen.findByText(/autorizacao recusada/i);

      expect(screen.getByText(/client id recusado/i)).toBeInTheDocument();
    });

    it('reporta falha de rede sem status, em vez de silenciar o clique', async () => {
      const user = userEvent.setup();
      const fetchWithAuth = vi.fn(async (url: string) => {
        if (url === '/api/integracoes/saude') return jsonResponse(saude());
        throw new Error('Failed to fetch');
      });

      renderPainel(fetchWithAuth);
      await user.click(await screen.findByRole('button', { name: /conectar bling/i }));

      const alerta = await screen.findByRole('alert');
      expect(alerta).toHaveTextContent(/sem resposta/i);
      expect(alerta).toHaveTextContent(/failed to fetch/i);
    });

    it('mostra a URL de retorno com ação de copiar, porque ela é colada dentro do Bling', async () => {
      const fetchWithAuth = vi.fn(async () => jsonResponse(saude()));

      renderPainel(fetchWithAuth);

      expect(await screen.findByDisplayValue(CALLBACK_URL)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /copiar url de callback/i })).toBeInTheDocument();
    });

    it('diz que falta configurar a origem estável em vez de exibir uma URL que vai quebrar', async () => {
      const fetchWithAuth = vi.fn(async () => jsonResponse(saude({ bling_callback_url: null })));

      renderPainel(fetchWithAuth);

      expect(await screen.findByText(/origem pública do orbita ainda não está configurada/i)).toBeInTheDocument();
    });
  });

  describe('Chatwoot', () => {
    it('salva apenas os campos que o servidor exige, carimbando a organização', async () => {
      const user = userEvent.setup();
      let corpo: Record<string, unknown> | null = null;
      const fetchWithAuth = vi.fn(async (url: string, options?: RequestInit) => {
        if (url === '/api/integracoes/saude') return jsonResponse(saude({ conexoes: [] }));
        if (url === '/api/chatwoot/connect') {
          corpo = JSON.parse(String(options?.body));
          return jsonResponse({ success: true, conexaoId: 'cw-1', webhookUrl: 'https://orbita.mkautobots.site/api/chatwoot/webhook/cw-1' });
        }
        throw new Error(`Unhandled request: ${url}`);
      });

      renderPainel(fetchWithAuth);
      await screen.findByLabelText(/token da api/i);

      await user.type(screen.getByLabelText(/url da instância chatwoot/i), 'https://chat.exemplo.test');
      await user.type(screen.getByLabelText(/token da api/i), 'tok-123');
      await user.type(screen.getByLabelText(/id da conta/i), '42');
      await user.type(screen.getByLabelText(/segredo do webhook/i), 'wh-secret');
      await user.click(screen.getByRole('button', { name: /salvar credenciais do chatwoot/i }));

      await waitFor(() => expect(corpo).not.toBeNull());
      expect(corpo).toEqual({
        api_url: 'https://chat.exemplo.test',
        api_token: 'tok-123',
        account_id: '42',
        webhook_secret: 'wh-secret',
        organizacao_esperada: 'org-a',
      });
    });

    it('mostra a URL do webhook devolvida pelo servidor, com ação de copiar', async () => {
      const fetchWithAuth = vi.fn(async () => jsonResponse(saude({
        conexoes: [conexao({ id: 'cw-1', provedor: 'chatwoot', credenciais_configuradas: false })],
        chatwoot_webhook_url: 'https://orbita.mkautobots.site/api/chatwoot/webhook/cw-1',
      })));

      renderPainel(fetchWithAuth);

      expect(await screen.findByDisplayValue('https://orbita.mkautobots.site/api/chatwoot/webhook/cw-1')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /copiar url do webhook/i })).toBeInTheDocument();
    });

    it('falha de HTTP é erro recuperável, nunca loading infinito nem sucesso falso', async () => {
      const user = userEvent.setup();
      const fetchWithAuth = vi.fn(async (url: string) => {
        if (url === '/api/integracoes/saude') return jsonResponse(saude({ conexoes: [] }));
        // Um 502 do proxy, que responde HTML: `json()` lança.
        // SAFETY: duplo mínimo de `Response`; o painel só lê `ok`, `status` e `json`.
        return { ok: false, status: 502, json: async () => { throw new Error('not json'); } } as unknown as Response;
      });

      renderPainel(fetchWithAuth);
      await screen.findByLabelText(/token da api/i);
      await user.type(screen.getByLabelText(/token da api/i), 'tok');
      await user.type(screen.getByLabelText(/id da conta/i), '1');
      await user.type(screen.getByLabelText(/segredo do webhook/i), 's');
      await user.click(screen.getByRole('button', { name: /salvar credenciais do chatwoot/i }));

      const alerta = await screen.findByRole('alert');
      expect(alerta).toHaveTextContent(/HTTP 502/);
      // O botão volta a ficar clicável: não há loading preso.
      expect(screen.getByRole('button', { name: /salvar credenciais do chatwoot/i })).toBeEnabled();
      // E o estado do provedor continua sendo o do servidor, não um verde novo.
      expect(screen.getAllByText(/não configurado/i).length).toBeGreaterThan(0);
    });

    it('falha de rede também é honesta', async () => {
      const user = userEvent.setup();
      const fetchWithAuth = vi.fn(async (url: string) => {
        if (url === '/api/integracoes/saude') return jsonResponse(saude({ conexoes: [] }));
        throw new Error('network timeout');
      });

      renderPainel(fetchWithAuth);
      await screen.findByLabelText(/token da api/i);
      await user.type(screen.getByLabelText(/token da api/i), 'tok');
      await user.type(screen.getByLabelText(/id da conta/i), '1');
      await user.type(screen.getByLabelText(/segredo do webhook/i), 's');
      await user.click(screen.getByRole('button', { name: /salvar credenciais do chatwoot/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/network timeout/i);
    });
  });

  describe('prazo', () => {
    it('uma requisição travada não deixa "Salvando…" para sempre', async () => {
      // Relógio falso: o prazo real é de 30 s, e o teste prova o caminho sem
      // gastar 30 s de suíte.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        const fetchWithAuth = vi.fn((url: string, options?: RequestInit) => {
          if (url === '/api/integracoes/saude') return Promise.resolve(jsonResponse(saude({ conexoes: [] })));
          // O servidor nunca responde; só o AbortSignal encerra a espera.
          return new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted.')));
          });
        });

        renderPainel(fetchWithAuth);
        await screen.findByLabelText(/client secret do bling/i);
        await user.type(screen.getByLabelText(/client id do bling/i), 'c');
        await user.type(screen.getByLabelText(/client secret do bling/i), 's');
        await user.click(screen.getByRole('button', { name: /salvar credenciais do bling/i }));

        expect(screen.getByRole('button', { name: /salvando/i })).toBeInTheDocument();

        await vi.advanceTimersByTimeAsync(PRAZO_DA_INTEGRACAO_MS + 1);

        const alerta = await screen.findByRole('alert');
        expect(alerta).toHaveTextContent(/não respondeu a tempo/i);
        // E o botão volta a ser clicável: nada fica preso em "Salvando…".
        expect(screen.getByRole('button', { name: /salvar credenciais do bling/i })).toBeEnabled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('segredos', () => {
    it('todo campo secreto é um campo de senha', async () => {
      const fetchWithAuth = vi.fn(async () => jsonResponse(saude({ conexoes: [] })));

      renderPainel(fetchWithAuth);
      await screen.findByLabelText(/client secret do bling/i);

      for (const rotulo of [/client secret do bling/i, /token da api/i, /segredo do webhook/i]) {
        expect(screen.getByLabelText(rotulo)).toHaveAttribute('type', 'password');
      }
      // E o que não é segredo continua legível.
      expect(screen.getByLabelText(/client id do bling/i)).toHaveAttribute('type', 'text');
    });

    it('o segredo sai do formulário assim que o servidor confirma que o guardou', async () => {
      const user = userEvent.setup();
      const fetchWithAuth = vi.fn(async (url: string) => {
        if (url === '/api/integracoes/saude') return jsonResponse(saude({ conexoes: [] }));
        return jsonResponse({ success: true, conexaoId: 'c1', status: 'pendente' });
      });

      renderPainel(fetchWithAuth);
      await screen.findByLabelText(/client secret do bling/i);
      await user.type(screen.getByLabelText(/client id do bling/i), 'client-abc');
      await user.type(screen.getByLabelText(/client secret do bling/i), 'secret-xyz');
      await user.click(screen.getByRole('button', { name: /salvar credenciais do bling/i }));

      await waitFor(() => expect(screen.getByLabelText(/client secret do bling/i)).toHaveValue(''));
    });

    it('nenhum segredo vai para storage nem para a URL', async () => {
      const user = userEvent.setup();
      const urls: string[] = [];
      const fetchWithAuth = vi.fn(async (url: string) => {
        urls.push(url);
        if (url === '/api/integracoes/saude') return jsonResponse(saude({ conexoes: [] }));
        return jsonResponse({ success: true, conexaoId: 'c1', status: 'pendente' });
      });

      renderPainel(fetchWithAuth);
      await screen.findByLabelText(/client secret do bling/i);
      await user.type(screen.getByLabelText(/client id do bling/i), 'client-abc');
      await user.type(screen.getByLabelText(/client secret do bling/i), 'secret-xyz');
      await user.click(screen.getByRole('button', { name: /salvar credenciais do bling/i }));
      await waitFor(() => expect(screen.getByLabelText(/client secret do bling/i)).toHaveValue(''));

      expect(JSON.stringify(window.localStorage)).not.toContain('secret-xyz');
      expect(JSON.stringify(window.sessionStorage)).not.toContain('secret-xyz');
      expect(urls.join(' ')).not.toContain('secret-xyz');
    });

    it('o segredo gravado nunca é reexibido pela releitura do servidor', async () => {
      const fetchWithAuth = vi.fn(async () => jsonResponse(saude()));

      renderPainel(fetchWithAuth);
      await screen.findByLabelText(/client secret do bling/i);

      // O passo 1 está gravado, e ainda assim o campo volta vazio: a rota de
      // leitura não devolve segredo nenhum, e a tela não tem de onde o tirar.
      expect(screen.getByText(/^configurado$/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/client secret do bling/i)).toHaveValue('');
    });
  });

  describe('tenant', () => {
    it('A → B limpa formulário e segredos em digitação', async () => {
      const user = userEvent.setup();
      const fetchWithAuth = vi.fn(async () => jsonResponse(saude({ conexoes: [] })));

      const { rerender } = render(
        <IntegrationsPanel fetchWithAuth={fetchWithAuth} selecao={ORG_A} nomeDaOrganizacao="Empresa A" />,
      );
      await screen.findByLabelText(/client secret do bling/i);
      await user.type(screen.getByLabelText(/client id do bling/i), 'client-de-a');
      await user.type(screen.getByLabelText(/client secret do bling/i), 'secret-de-a');
      await user.type(screen.getByLabelText(/token da api/i), 'token-de-a');

      rerender(<IntegrationsPanel fetchWithAuth={fetchWithAuth} selecao={ORG_B} nomeDaOrganizacao="Empresa B" />);

      await waitFor(() => expect(screen.getByLabelText(/client id do bling/i)).toHaveValue(''));
      expect(screen.getByLabelText(/client secret do bling/i)).toHaveValue('');
      expect(screen.getByLabelText(/token da api/i)).toHaveValue('');
      expect(screen.getByText('Empresa B')).toBeInTheDocument();
    });

    it('A → B limpa também o erro e o estado lidos em A', async () => {
      const user = userEvent.setup();
      const fetchWithAuth = vi.fn(async (url: string) => {
        if (url === '/api/integracoes/saude') return jsonResponse(saude());
        return jsonResponse({ success: false, error: 'erro que pertence a A' }, 500);
      });

      const { rerender } = render(<IntegrationsPanel fetchWithAuth={fetchWithAuth} selecao={ORG_A} />);
      await user.click(await screen.findByRole('button', { name: /conectar bling/i }));
      await screen.findByText(/erro que pertence a A/i);

      rerender(<IntegrationsPanel fetchWithAuth={fetchWithAuth} selecao={ORG_B} />);

      await waitFor(() => expect(screen.queryByText(/erro que pertence a A/i)).not.toBeInTheDocument());
    });

    it('resposta tardia de A nunca aparece em B', async () => {
      let liberarA: (() => void) | undefined;
      const fetchWithAuth = vi.fn(async () => {
        // A leitura de A fica pendurada; a de B responde na hora.
        if (fetchWithAuth.mock.calls.length === 1) {
          await new Promise<void>((resolve) => { liberarA = resolve; });
          return jsonResponse(saude({
            conexoes: [conexao({ id: 'conn-de-a', status: 'conectado', last_health_check_at: '2026-09-10T12:00:00Z', last_health_error: null })],
          }));
        }
        return jsonResponse(saude({
          conexoes: [conexao({ id: 'conn-de-b', status: 'conectado', health_status: 'error', last_health_check_at: '2026-09-10T12:00:00Z', last_health_error: 'erro de B' })],
        }));
      });

      const { rerender } = render(<IntegrationsPanel fetchWithAuth={fetchWithAuth} selecao={ORG_A} />);
      rerender(<IntegrationsPanel fetchWithAuth={fetchWithAuth} selecao={ORG_B} />);
      await screen.findByText(/erro de B/i);

      // A resposta de A chega DEPOIS da troca.
      liberarA?.();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // A leitura boa de B continua na tela, e a de A não a substitui.
      expect(screen.getByText(/erro de B/i)).toBeInTheDocument();
      expect(screen.queryByText(/^conectado$/i)).not.toBeInTheDocument();
    });

    it('uma escrita começada em A declara A, para o servidor recusá-la se a organização já mudou', async () => {
      const user = userEvent.setup();
      const corpos: unknown[] = [];
      const fetchWithAuth = vi.fn(async (url: string, options?: RequestInit) => {
        if (url === '/api/integracoes/saude') return jsonResponse(saude({ conexoes: [] }));
        corpos.push(JSON.parse(String(options?.body)));
        return jsonResponse({ success: true, conexaoId: 'c1', status: 'pendente' });
      });

      renderPainel(fetchWithAuth);
      await screen.findByLabelText(/client secret do bling/i);
      await user.type(screen.getByLabelText(/client id do bling/i), 'c');
      await user.type(screen.getByLabelText(/client secret do bling/i), 's');
      await user.click(screen.getByRole('button', { name: /salvar credenciais do bling/i }));

      await waitFor(() => expect(corpos).toHaveLength(1));
      // Sem esta declaração, uma troca de organização em voo faria as chaves de
      // A serem gravadas no cofre de B.
      expect(corpos[0]).toMatchObject({ organizacaoEsperada: 'org-a' });
    });

    it('sem organização ativa — logout incluído — não há formulário nem segredo na tela', async () => {
      const user = userEvent.setup();
      const fetchWithAuth = vi.fn(async () => jsonResponse(saude({ conexoes: [] })));

      const { rerender } = render(<IntegrationsPanel fetchWithAuth={fetchWithAuth} selecao={ORG_A} />);
      await screen.findByLabelText(/client secret do bling/i);
      await user.type(screen.getByLabelText(/client secret do bling/i), 'secret-de-a');

      // Logout: a seleção some junto da sessão.
      rerender(<IntegrationsPanel fetchWithAuth={fetchWithAuth} selecao={null} />);

      await waitFor(() => expect(screen.queryByLabelText(/client secret do bling/i)).not.toBeInTheDocument());
      expect(screen.getAllByText(/nenhuma organização ativa/i).length).toBeGreaterThan(0);
      expect(document.body.textContent ?? '').not.toContain('secret-de-a');
    });
  });

  describe('leitura', () => {
    it('uma leitura que falhou não vira "não configurado": ela diz que não foi possível saber', async () => {
      const fetchWithAuth = vi.fn(async () => jsonResponse({ success: false, error: 'boom' }, 500));

      renderPainel(fetchWithAuth);

      expect((await screen.findAllByText(/não foi possível ler o estado das integrações/i)).length).toBeGreaterThan(0);
      expect(screen.queryByText(/não configurado/i)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /tentar de novo/i })).toBeInTheDocument();
    });

    it('quem não administra a organização não recebe os controles de gestão', async () => {
      const fetchWithAuth = vi.fn(async () => jsonResponse(saude()));

      renderPainel(fetchWithAuth, { podeGerir: false });
      await screen.findByLabelText(/client secret do bling/i);

      expect(screen.getByRole('button', { name: /salvar credenciais do bling/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /conectar bling/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /salvar credenciais do chatwoot/i })).toBeDisabled();
    });
  });
});
