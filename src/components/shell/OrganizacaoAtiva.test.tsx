/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { OrganizacaoAtiva } from './OrganizacaoAtiva';
import { useOrganizationsList } from '@/components/organizacao/useOrganizationsList';
import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';

const ORG_A = { id: '10000000-0000-4000-8000-000000000001', nome: 'Loja A', slug: 'loja-a' };
const ORG_B = { id: '10000000-0000-4000-8000-000000000002', nome: 'Loja B', slug: 'loja-b' };

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/**
 * Fronteira de rede: responde `/api/organizacoes` com A ativa e devolve B como
 * ativa depois do switch, como o servidor faz.
 */
function construirFetch() {
  return vi.fn(async (url: string, options: RequestInit = {}) => {
    const method = options.method ?? 'GET';
    if (method === 'GET' && url === '/api/organizacoes') {
      return jsonResponse({
        organizacoes: [ORG_A, ORG_B],
        activeOrg: { organizacao: ORG_A, papel: 'owner' },
        selectionVersion: 3,
      });
    }
    if (method === 'POST' && url === '/api/organizacoes/switch') {
      return jsonResponse({ activeOrg: { organizacao: ORG_B, papel: 'member' }, selectionVersion: 4 });
    }
    throw new Error(`Requisição não prevista no teste: ${method} ${url}`);
  });
}

/** Monta o indicador com o mesmo estado que o topo da aplicação cria. */
function IndicadorComEstadoDoTopo({ fetchWithAuth }: { fetchWithAuth: AuthenticatedFetch }) {
  const lista = useOrganizationsList(fetchWithAuth);
  return (
    <OrganizacaoAtiva
      organizacoes={lista.organizacoes}
      ativa={lista.activeOrg}
      carregando={lista.isLoading}
      trocandoParaId={lista.switchingOrgId}
      onTrocar={lista.handleSwitchOrganization}
    />
  );
}

describe('OrganizacaoAtiva (indicador do shell)', () => {
  it('mostra a organização ativa sem que seja preciso abrir a aba Organização', async () => {
    render(<IndicadorComEstadoDoTopo fetchWithAuth={construirFetch()} />);

    expect(await screen.findByText('Loja A')).toBeInTheDocument();
  });

  it('troca de organização pelo mesmo contrato CAS do fluxo de organizações, e passa a anunciar a nova', async () => {
    const fetchWithAuth = construirFetch();
    render(<IndicadorComEstadoDoTopo fetchWithAuth={fetchWithAuth} />);
    await screen.findByText('Loja A');

    await userEvent.click(screen.getByRole('button', { name: /Trocar de organização/i }));
    await userEvent.click(screen.getByRole('button', { name: /Loja B/ }));

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith(
        '/api/organizacoes/switch',
        expect.objectContaining({
          method: 'POST',
          // O shell não inventa caminho próprio: é a mesma rota, com o mesmo
          // contrato de comparação-e-troca do painel de organização.
          body: JSON.stringify({ organizacao_id: ORG_B.id, expected_version: 3 }),
        }),
      );
    });

    expect(await screen.findByText('Loja B')).toBeInTheDocument();
  });

  it('não oferece seletor quando existe uma organização só', async () => {
    const fetchWithAuth = vi.fn(async () =>
      jsonResponse({
        organizacoes: [ORG_A],
        activeOrg: { organizacao: ORG_A, papel: 'owner' },
        selectionVersion: 1,
      }),
    );
    render(<IndicadorComEstadoDoTopo fetchWithAuth={fetchWithAuth as unknown as AuthenticatedFetch} />);

    expect(await screen.findByText('Loja A')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Trocar de organização/i })).not.toBeInTheDocument();
  });
});
