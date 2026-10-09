/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { OperacoesPendentes } from './OperacoesPendentes';
import type { BuscaAutenticada } from './useLeituraFinanceira';

const REF = '55555555-5555-4555-8555-555555555555';
const pendente = {
  ref: REF, criacao: 'indeterminada', baixa: null, valor: 1200, dataVencimento: '2026-10-20',
  blingContaId: null, ultimaReconciliacao: null,
};

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor(reconciliacao: unknown, listaDepois: unknown[] = []) {
  const chamadas: Array<{ url: string; method: string }> = [];
  let listas = 0;
  const busca: BuscaAutenticada = async (url, options) => {
    chamadas.push({ url, method: options?.method ?? 'GET' });
    if (url === '/api/financeiro/operacoes') {
      listas++;
      return json({ success: true, operacoes: listas === 1 ? [pendente] : listaDepois });
    }
    return json(reconciliacao);
  };
  return { busca, chamadas };
}

const confirmada = { success: true, resultado: 'confirmada', motivo: null, operacao: { ...pendente, criacao: 'confirmada', blingContaId: '88123' } };

describe('operações pendentes', () => {
  it('a única ação é conferir no Bling — nunca tentar criar de novo', async () => {
    render(<OperacoesPendentes fetchWithAuth={servidor(confirmada).busca} ativo versao={0} onConfirmada={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Conferir no Bling' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /tentar|lançar|criar/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Não lance de novo/u)).toBeInTheDocument();
  });

  it('conferência confirmada: mostra, recarrega o financeiro e a lista', async () => {
    const onConfirmada = vi.fn();
    const { busca, chamadas } = servidor(confirmada);
    render(<OperacoesPendentes fetchWithAuth={busca} ativo versao={0} onConfirmada={onConfirmada} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Conferir no Bling' }));

    expect(await screen.findByText('Confirmada no Bling.')).toBeInTheDocument();
    expect(onConfirmada).toHaveBeenCalledTimes(1);
    expect(chamadas.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([`/api/financeiro/operacoes/${REF}/reconciliar`]);
  });

  it('revisão manual: explica o motivo sem prometer que a conta não existe', async () => {
    const onConfirmada = vi.fn();
    render(
      <OperacoesPendentes
        fetchWithAuth={servidor({ success: true, resultado: 'revisao_manual', motivo: 'nenhum_candidato', operacao: pendente }, [pendente]).busca}
        ativo
        versao={0}
        onConfirmada={onConfirmada}
      />,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Conferir no Bling' }));

    expect(await screen.findByText(/Revisão manual necessária: .*não prova que ela não exista/u)).toBeInTheDocument();
    expect(onConfirmada).not.toHaveBeenCalled();
  });

  it('Bling sem resposta completa: ainda pendente', async () => {
    render(
      <OperacoesPendentes
        fetchWithAuth={servidor({ success: true, resultado: 'revisao_manual', motivo: 'consulta_incompleta', operacao: pendente }, [pendente]).busca}
        ativo
        versao={0}
        onConfirmada={vi.fn()}
      />,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Conferir no Bling' }));

    await waitFor(() => expect(screen.getByText(/Ainda pendente/u)).toBeInTheDocument());
  });

  it('sem pendências, nada é mostrado', async () => {
    const busca: BuscaAutenticada = async () => json({ success: true, operacoes: [] });
    const { container } = render(<OperacoesPendentes fetchWithAuth={busca} ativo versao={0} onConfirmada={vi.fn()} />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
