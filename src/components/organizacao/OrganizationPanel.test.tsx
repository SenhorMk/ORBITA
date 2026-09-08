/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrganizationPanel } from './OrganizationPanel';
import { useOrganizationsList } from './useOrganizationsList';
import type { AuthenticatedFetch } from './useOrganizationPanel';

/**
 * O painel recebe o estado de organizações de fora desde o Ticket 01 — o topo
 * da aplicação cria uma instância só, para o painel e para o indicador do
 * shell. Este arranjo monta o painel do mesmo jeito que a produção monta.
 */
function PainelComEstadoDoTopo({ fetchWithAuth }: { fetchWithAuth: AuthenticatedFetch }) {
  const lista = useOrganizationsList(fetchWithAuth);
  return <OrganizationPanel fetchWithAuth={fetchWithAuth} lista={lista} />;
}

const ORG_A = {
  id: '10000000-0000-4000-8000-000000000001',
  nome: 'Loja A',
  slug: 'loja-a',
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};
const ORG_B = {
  id: '10000000-0000-4000-8000-000000000002',
  nome: 'Loja B',
  slug: 'loja-b',
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** Fetch boundary mock: routes by URL+method, matching the component's real request shape. */
function buildFetchWithAuth(overrides: Record<string, (url: string, options?: RequestInit) => Promise<Response>> = {}) {
  return vi.fn(async (url: string, options: RequestInit = {}) => {
    const method = options.method ?? 'GET';
    const key = `${method} ${url.replace(/\/[0-9a-f-]{36}\//g, '/:id/')}`;
    if (overrides[key]) return overrides[key](url, options);

    if (method === 'GET' && url === '/api/organizacoes') {
      return jsonResponse({
        organizacoes: [ORG_A, ORG_B],
        activeOrg: { organizacao: ORG_A, papel: 'owner' },
        selectionVersion: 3,
      });
    }
    if (method === 'GET' && /\/api\/organizacoes\/.+\/convites$/.test(url)) {
      return jsonResponse({ convites: [] });
    }
    if (method === 'GET' && /\/api\/organizacoes\/.+\/membros$/.test(url)) {
      return jsonResponse({ membros: [{ user_id: 'u1', papel: 'member', created_at: '2026-08-01T00:00:00Z' }] });
    }
    throw new Error(`Unhandled request in test: ${method} ${url}`);
  });
}

describe('OrganizationPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads and displays the user organizations and the active one', async () => {
    const fetchWithAuth = buildFetchWithAuth();
    render(<PainelComEstadoDoTopo fetchWithAuth={fetchWithAuth} />);

    expect(await screen.findAllByText('Loja A')).not.toHaveLength(0);
    expect(screen.getByText('Loja B')).toBeInTheDocument();
    expect(screen.getByText(/organização ativa/i)).toBeInTheDocument();
  });

  it('creates a new organization through the real API and refreshes the list', async () => {
    const user = userEvent.setup();
    const postOrganizacoes = vi.fn(async (_url: string, options?: RequestInit) => {
      const body = JSON.parse(String(options?.body));
      expect(body).toEqual({ nome: 'Loja Nova', slug: 'loja-nova' });
      return jsonResponse({ organizacao: { id: 'new-id', nome: 'Loja Nova', slug: 'loja-nova' } }, 201);
    });
    const fetchWithAuth = buildFetchWithAuth({ 'POST /api/organizacoes': postOrganizacoes });
    render(<PainelComEstadoDoTopo fetchWithAuth={fetchWithAuth} />);
    await screen.findByText('Loja B');

    await user.type(screen.getByLabelText(/nome da organização/i), 'Loja Nova');
    await user.type(screen.getByLabelText(/slug/i), 'loja-nova');
    await user.click(screen.getByRole('button', { name: /criar organização/i }));

    await waitFor(() => expect(postOrganizacoes).toHaveBeenCalledTimes(1));
  });

  it('switches the active organization using the CAS contract (organizacao_id + expected_version)', async () => {
    const user = userEvent.setup();
    const postSwitch = vi.fn(async (_url: string, options?: RequestInit) => {
      const body = JSON.parse(String(options?.body));
      expect(body).toEqual({ organizacao_id: ORG_B.id, expected_version: 3 });
      return jsonResponse({ success: true, activeOrg: { organizacao: ORG_B, papel: 'admin' }, selectionVersion: 4 });
    });
    const fetchWithAuth = buildFetchWithAuth({ 'POST /api/organizacoes/switch': postSwitch });
    render(<PainelComEstadoDoTopo fetchWithAuth={fetchWithAuth} />);
    await screen.findByText('Loja B');

    await user.click(screen.getByRole('button', { name: /trocar para loja b/i }));

    await waitFor(() => expect(postSwitch).toHaveBeenCalledTimes(1));
  });

  it('invites a member through the API and never sends a client-chosen capability, only email/papel', async () => {
    const user = userEvent.setup();
    const postConvite = vi.fn(async (url: string, options?: RequestInit) => {
      expect(url).toBe(`/api/organizacoes/${ORG_A.id}/convites`);
      const body = JSON.parse(String(options?.body));
      expect(body).toEqual({ email: 'novo@empresa.com', papel: 'member' });
      return jsonResponse({ convite: { id: 'conv-1', token: 'tok' } }, 201);
    });
    const fetchWithAuth = buildFetchWithAuth({ 'POST /api/organizacoes/:id/convites': postConvite });
    render(<PainelComEstadoDoTopo fetchWithAuth={fetchWithAuth} />);
    await screen.findByText('Loja B');

    await user.type(screen.getByLabelText(/e-mail do convidado/i), 'novo@empresa.com');
    await user.click(screen.getByRole('button', { name: /enviar convite/i }));

    await waitFor(() => expect(postConvite).toHaveBeenCalledTimes(1));
  });

  it('accepts an invite by token through the real API', async () => {
    const user = userEvent.setup();
    const postAceitar = vi.fn(async (url: string, options?: RequestInit) => {
      expect(url).toBe('/api/convites/aceitar');
      const body = JSON.parse(String(options?.body));
      expect(body).toEqual({ token: 'a'.repeat(32) });
      return jsonResponse({ success: true, organizacaoId: ORG_B.id });
    });
    const fetchWithAuth = buildFetchWithAuth({ 'POST /api/convites/aceitar': postAceitar });
    render(<PainelComEstadoDoTopo fetchWithAuth={fetchWithAuth} />);
    await screen.findByText('Loja B');

    await user.type(screen.getByLabelText(/token do convite/i), 'a'.repeat(32));
    await user.click(screen.getByRole('button', { name: /aceitar convite/i }));

    await waitFor(() => expect(postAceitar).toHaveBeenCalledTimes(1));
  });

  it('lists members of the active organization and removes one via the server-authorized endpoint', async () => {
    const user = userEvent.setup();
    const deleteMembro = vi.fn(async (url: string) => {
      expect(url).toBe(`/api/organizacoes/${ORG_A.id}/membros/u1`);
      return jsonResponse({ success: true });
    });
    const fetchWithAuth = buildFetchWithAuth({ 'DELETE /api/organizacoes/:id/membros/u1': deleteMembro });
    render(<PainelComEstadoDoTopo fetchWithAuth={fetchWithAuth} />);
    await screen.findByText('Loja B');

    const membersSection = await screen.findByTestId('members-list');
    expect(within(membersSection).getByText('u1')).toBeInTheDocument();
    await user.click(within(membersSection).getByRole('button', { name: /remover/i }));

    await waitFor(() => expect(deleteMembro).toHaveBeenCalledTimes(1));
  });

  it('never renders an action the server has not authorized: switching disabled while a request is in flight', async () => {
    let resolveSwitch: (value: Response) => void = () => {};
    const postSwitch = vi.fn(
      () => new Promise<Response>((resolve) => { resolveSwitch = resolve; }),
    );
    const fetchWithAuth = buildFetchWithAuth({ 'POST /api/organizacoes/switch': postSwitch });
    const user = userEvent.setup();
    render(<PainelComEstadoDoTopo fetchWithAuth={fetchWithAuth} />);
    await screen.findByText('Loja B');

    const switchButton = screen.getByRole('button', { name: /trocar para loja b/i });
    await user.click(switchButton);
    expect(switchButton).toBeDisabled();

    resolveSwitch(jsonResponse({ success: true, activeOrg: { organizacao: ORG_B, papel: 'admin' }, selectionVersion: 4 }));
  });
});
