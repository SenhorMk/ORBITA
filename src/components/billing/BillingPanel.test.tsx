/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BillingPanel } from './BillingPanel';

const ORG_ID = '10000000-0000-4000-8000-000000000001';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const ENTITLEMENTS = {
  organizacao_id: ORG_ID,
  plano_id: '40000000-0000-4000-8000-000000000001',
  plano_nome: 'Pro',
  plano_slug: 'pro',
  status: 'active',
  limite_membros: 10,
  limite_conexoes_bling: 2,
  limite_conexoes_chatwoot: 2,
  recursos: {},
  periodo_inicio: '2026-08-01T00:00:00Z',
  periodo_fim: null,
};

describe('BillingPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('displays the real plan, status and limits returned by the server', async () => {
    const fetchWithAuth = vi.fn(async () => jsonResponse({ entitlements: ENTITLEMENTS }));

    render(<BillingPanel fetchWithAuth={fetchWithAuth} organizacaoId={ORG_ID} />);

    expect(await screen.findByText('Pro')).toBeInTheDocument();
    expect(screen.getByText(/active/i)).toBeInTheDocument();
    expect(screen.getByText(/10/)).toBeInTheDocument();
  });

  it('never invents a subscription state while the entitlements request is pending', async () => {
    const fetchWithAuth = vi.fn(() => new Promise<Response>(() => {}));

    render(<BillingPanel fetchWithAuth={fetchWithAuth} organizacaoId={ORG_ID} />);

    expect(screen.getByText(/carregando plano/i)).toBeInTheDocument();
    expect(screen.queryByText(/active/i)).not.toBeInTheDocument();
  });

  it('starts a real Stripe checkout session and redirects to the URL the server returned', async () => {
    const user = userEvent.setup();
    const redirect = vi.fn();
    const postCheckout = vi.fn(async (_url: string, options?: RequestInit) => {
      const body = JSON.parse(String(options?.body));
      expect(body).toEqual({ plano_slug: 'enterprise', intervalo: 'monthly' });
      return jsonResponse({ url: 'https://checkout.stripe.com/session-123', session_id: 'sess-123' });
    });
    const fetchWithAuth = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === `/api/organizacoes/${ORG_ID}/entitlements`) return jsonResponse({ entitlements: ENTITLEMENTS });
      if (url === '/api/stripe/checkout') return postCheckout(url, options);
      throw new Error(`Unhandled: ${url}`);
    });

    render(<BillingPanel fetchWithAuth={fetchWithAuth} organizacaoId={ORG_ID} onRedirect={redirect} />);
    await screen.findByText('Pro');

    await user.click(screen.getByRole('button', { name: /assinar enterprise/i }));

    await waitFor(() => expect(redirect).toHaveBeenCalledWith('https://checkout.stripe.com/session-123'));
  });

  it('opens the real Stripe billing portal and redirects to the URL the server returned', async () => {
    const user = userEvent.setup();
    const redirect = vi.fn();
    const postPortal = vi.fn(async () => jsonResponse({ url: 'https://billing.stripe.com/portal-123' }));
    const fetchWithAuth = vi.fn(async (url: string) => {
      if (url === `/api/organizacoes/${ORG_ID}/entitlements`) return jsonResponse({ entitlements: ENTITLEMENTS });
      if (url === '/api/stripe/portal') return postPortal();
      throw new Error(`Unhandled: ${url}`);
    });

    render(<BillingPanel fetchWithAuth={fetchWithAuth} organizacaoId={ORG_ID} onRedirect={redirect} />);
    await screen.findByText('Pro');

    await user.click(screen.getByRole('button', { name: /abrir portal de faturamento/i }));

    await waitFor(() => expect(redirect).toHaveBeenCalledWith('https://billing.stripe.com/portal-123'));
  });

  it('surfaces a billing failure from the server instead of pretending checkout started', async () => {
    const user = userEvent.setup();
    const redirect = vi.fn();
    const fetchWithAuth = vi.fn(async (url: string) => {
      if (url === `/api/organizacoes/${ORG_ID}/entitlements`) return jsonResponse({ entitlements: ENTITLEMENTS });
      if (url === '/api/stripe/checkout') {
        return jsonResponse({ error: 'Faturamento Stripe não configurado neste ambiente' }, 503);
      }
      throw new Error(`Unhandled: ${url}`);
    });

    render(<BillingPanel fetchWithAuth={fetchWithAuth} organizacaoId={ORG_ID} onRedirect={redirect} />);
    await screen.findByText('Pro');

    await user.click(screen.getByRole('button', { name: /assinar enterprise/i }));

    expect(await screen.findByText(/faturamento stripe não configurado/i)).toBeInTheDocument();
    expect(redirect).not.toHaveBeenCalled();
  });
});
