/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CancelamentoDePedido } from './CancelamentoDePedido';
import type { PedidoEnriquecido } from '@/repositories/pedidoRepository';

const fetchWithAuthMock = vi.fn();

vi.mock('@/lib/fetchWithAuth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args),
}));

const PEDIDO = {
  id: 'pedido-1',
  numero: '4242',
  bling_id: '9001',
  status: 'Pendente',
  total: 40,
} as unknown as PedidoEnriquecido;

function resposta(corpo: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => corpo } as Response;
}

/** O caminho feliz da rota: situações do Bling e depois a troca de status. */
function redeQueCancela() {
  const chamadas: string[] = [];
  fetchWithAuthMock.mockImplementation(async (url: string, options: RequestInit = {}) => {
    chamadas.push(`${options.method ?? 'GET'} ${url}`);
    if (url === '/api/bling/situacoes') {
      return resposta([{ id: 12, nome: 'Cancelado' }, { id: 6, nome: 'Em aberto' }]);
    }
    if (url === '/api/pedidos/status') return resposta({ success: true });
    throw new Error(`Requisição não prevista: ${url}`);
  });
  return chamadas;
}

describe('CancelamentoDePedido', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    // `window.alert` não existe no jsdom; o componente o usa para confirmar.
    vi.stubGlobal('alert', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('nunca recarrega a página — era isso que reiniciava o produto inteiro', async () => {
    // O defeito: depois do sucesso o componente fazia `window.location.reload()`.
    // Voltavam o shell, a organização ativa, o StartupLoader e todas as
    // leituras — e quem só quis cancelar um pedido terminava em modo offline.
    const recarregar = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      reload: recarregar,
    } as unknown as Location);

    redeQueCancela();
    const usuaria = userEvent.setup();
    render(<CancelamentoDePedido pedido={PEDIDO} onFechar={vi.fn()} onCancelado={vi.fn()} />);

    await usuaria.click(screen.getByRole('button', { name: 'Cancelar pedido' }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
    expect(recarregar).not.toHaveBeenCalled();
  });

  it('avisa quem chamou para reler a lista, em vez de recarregar', async () => {
    const onCancelado = vi.fn();
    redeQueCancela();
    const usuaria = userEvent.setup();
    render(<CancelamentoDePedido pedido={PEDIDO} onFechar={vi.fn()} onCancelado={onCancelado} />);

    await usuaria.click(screen.getByRole('button', { name: 'Cancelar pedido' }));

    await waitFor(() => expect(onCancelado).toHaveBeenCalledTimes(1));
  });

  it('fecha o diálogo ao terminar', async () => {
    const onFechar = vi.fn();
    redeQueCancela();
    const usuaria = userEvent.setup();
    render(<CancelamentoDePedido pedido={PEDIDO} onFechar={onFechar} onCancelado={vi.fn()} />);

    await usuaria.click(screen.getByRole('button', { name: 'Cancelar pedido' }));

    await waitFor(() => expect(onFechar).toHaveBeenCalled());
  });

  it('manda a situação de cancelamento que o Bling publicou, e não um id fixo', async () => {
    const chamadas = redeQueCancela();
    const usuaria = userEvent.setup();
    render(<CancelamentoDePedido pedido={PEDIDO} onFechar={vi.fn()} onCancelado={vi.fn()} />);

    await usuaria.click(screen.getByRole('button', { name: 'Cancelar pedido' }));

    await waitFor(() => expect(chamadas).toEqual(['GET /api/bling/situacoes', 'POST /api/pedidos/status']));
    const corpo = JSON.parse(String(fetchWithAuthMock.mock.calls[1]![1].body)) as Record<string, unknown>;
    expect(corpo).toEqual({ pedidoId: 'pedido-1', novaSituacaoId: 12, novaSituacaoNome: 'Cancelado' });
  });

  it('falha do servidor não avisa releitura: não houve cancelamento a refletir', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url === '/api/bling/situacoes') return resposta([{ id: 12, nome: 'Cancelado' }]);
      return resposta({ error: 'Falha ao cancelar' }, 500);
    });
    const onCancelado = vi.fn();
    const usuaria = userEvent.setup();
    render(<CancelamentoDePedido pedido={PEDIDO} onFechar={vi.fn()} onCancelado={onCancelado} />);

    await usuaria.click(screen.getByRole('button', { name: 'Cancelar pedido' }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
    expect(onCancelado).not.toHaveBeenCalled();
  });

  it('cancelado com pendência de estoque: a pessoa vê a pendência, não "estoque alinhado com sucesso" (PRE-006C)', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url === '/api/bling/situacoes') return resposta([{ id: 12, nome: 'Cancelado' }]);
      return resposta({ success: true, status: 'Cancelado', estoque: 'requer_reconciliacao', warning: 'Situação alterada, mas 1 produto(s) não tiveram o estoque alinhado ao Bling.' });
    });
    const alerta = vi.fn();
    vi.stubGlobal('alert', alerta);
    const onCancelado = vi.fn();
    const usuaria = userEvent.setup();
    render(<CancelamentoDePedido pedido={PEDIDO} onFechar={vi.fn()} onCancelado={onCancelado} />);

    await usuaria.click(screen.getByRole('button', { name: 'Cancelar pedido' }));

    await waitFor(() => expect(onCancelado).toHaveBeenCalled());
    expect(alerta).toHaveBeenCalledWith(expect.stringContaining('com pendência'));
    expect(alerta).not.toHaveBeenCalledWith(expect.stringContaining('alinhado com sucesso'));
  });

  it('resultado desconhecido no Bling: mostra a orientação da rota e não relê como cancelado (PRE-006C)', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url === '/api/bling/situacoes') return resposta([{ id: 12, nome: 'Cancelado' }]);
      return resposta({ error: 'O Bling não confirmou a mudança de situação, e ela pode ter sido aplicada. Sincronize e confira o pedido antes de repetir.', reconciliacao: { motivo: 'bling_sem_confirmacao' } }, 502);
    });
    const alerta = vi.fn();
    vi.stubGlobal('alert', alerta);
    const onCancelado = vi.fn();
    const usuaria = userEvent.setup();
    render(<CancelamentoDePedido pedido={PEDIDO} onFechar={vi.fn()} onCancelado={onCancelado} />);

    await usuaria.click(screen.getByRole('button', { name: 'Cancelar pedido' }));

    await waitFor(() => expect(alerta).toHaveBeenCalledWith(expect.stringContaining('confira o pedido antes de repetir')));
    expect(onCancelado).not.toHaveBeenCalled();
  });
});
