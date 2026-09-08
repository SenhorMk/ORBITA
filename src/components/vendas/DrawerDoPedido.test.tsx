/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import type { PedidoEnriquecido } from '@/repositories/pedidoRepository';
import { DrawerDoPedido } from './DrawerDoPedido';
import { fetchWithAuth } from '@/lib/fetchWithAuth';

/**
 * O drawer do pedido.
 *
 * O que estes testes guardam é a correção que já custou uma rodada: um pedido
 * apagado no Bling continua existindo no Orbita, e abrir o histórico dele NÃO
 * pode voltar a dizer só "Pedido não encontrado". A casca virou drawer; esta
 * regra não mudou.
 */

vi.mock('@/lib/fetchWithAuth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));

const PEDIDO_LOCAL = {
  id: 'id-20',
  bling_id: 'bling-20',
  numero: '20',
  data: '2026-09-01T12:00:00.000Z',
  total: 40,
  frete: 7.5,
  status: 'Entregue',
  cliente_id: 'cli-1',
  cliente: { bling_id: 'c1', nome: 'Mateus Kahuan', cpf_cnpj: '116.446.734-44' },
} as unknown as PedidoEnriquecido;

function resposta(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => vi.clearAllMocks());

function montar(pedidoLocal: PedidoEnriquecido, onEmitirNfe = vi.fn()) {
  return render(
    <DrawerDoPedido
      aberto
      onAbertoChange={vi.fn()}
      pedidoBlingId={pedidoLocal.bling_id}
      pedidoLocal={pedidoLocal}
      onEmitirNfe={onEmitirNfe}
    />,
  );
}

describe('quando o pedido não existe mais no Bling', () => {
  it('cai no registro histórico local, e não em "não encontrado"', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(resposta({ error: 'not found' }, 404));

    montar(PEDIDO_LOCAL);

    await waitFor(() => expect(screen.getByText(/Registro histórico local/i)).toBeInTheDocument());
    expect(screen.getByText(/mantém o registro para histórico/i)).toBeInTheDocument();
    // O snapshot local continua legível.
    expect(screen.getByText('#20')).toBeInTheDocument();
    expect(screen.getAllByText('Mateus Kahuan').length).toBeGreaterThan(0);
    expect(screen.getByText('116.446.734-44')).toBeInTheDocument();
    expect(screen.queryByText(/não encontrado/i)).not.toBeInTheDocument();
  });

  it('desabilita apagar, porque não há o que apagar lá', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(resposta({ error: 'not found' }, 404));

    montar(PEDIDO_LOCAL);

    await waitFor(() => expect(screen.getByText(/Registro histórico local/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Apagar/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Editar/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Emitir NF-e/i })).toBeDisabled();
  });
});

describe('quando a leitura falha de verdade', () => {
  it('mostra erro — que é diferente de o pedido ter sumido do ERP', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(resposta({ error: 'Falha no Bling' }, 500));

    montar(PEDIDO_LOCAL);

    await waitFor(() =>
      expect(screen.getByText(/Não foi possível ler este pedido no Bling/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Registro histórico local/i)).not.toBeInTheDocument();
  });
});

describe('pedido cancelado', () => {
  it('continua abrindo, e as ações que escrevem no ERP ficam indisponíveis', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(
      resposta({
        data: {
          numero: '18',
          data: '2026-09-01T12:00:00.000Z',
          total: 25,
          situacao: { valor: 'Cancelado' },
          contato: { nome: 'Rafael Nogueira' },
          itens: [],
        },
      }),
    );

    montar({ ...PEDIDO_LOCAL, numero: '18', status: 'Cancelado' } as PedidoEnriquecido);

    await waitFor(() => expect(screen.getByText(/Pedido cancelado\./i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Editar/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Emitir NF-e/i })).toBeDisabled();
  });
});

describe('pedido normal', () => {
  it('mostra itens, quantidade, valor unitário, frete e total', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(
      resposta({
        data: {
          numero: '20',
          data: '2026-09-01T12:00:00.000Z',
          total: 47.5,
          situacao: { valor: 'Entregue' },
          contato: { nome: 'Mateus Kahuan', numeroDocumento: '116.446.734-44' },
          transporte: { frete: 7.5, etiqueta: { endereco: 'Rua A', numero: '10', bairro: 'Centro', municipio: 'Recife', uf: 'PE', cep: '50000-000' } },
          itens: [{ codigo: 'SKU-1', descricao: 'Cafeteira', quantidade: 2, valor: 20 }],
        },
      }),
    );

    montar(PEDIDO_LOCAL);

    await waitFor(() => expect(screen.getByText('Cafeteira')).toBeInTheDocument());
    expect(screen.getByText(/SKU-1 · 2 un/)).toBeInTheDocument();
    expect(screen.getByText(/R\$\s*40,00/)).toBeInTheDocument();   // total do item
    expect(screen.getByText(/R\$\s*20,00 un/)).toBeInTheDocument(); // valor unitário
    expect(screen.getByText(/R\$\s*7,50/)).toBeInTheDocument();     // frete
    expect(screen.getByText(/R\$\s*47,50/)).toBeInTheDocument();    // total do pedido
  });
});
