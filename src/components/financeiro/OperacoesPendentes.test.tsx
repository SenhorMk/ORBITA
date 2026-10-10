/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { OperacoesPendentes } from './OperacoesPendentes';
import type { BuscaAutenticada } from './useLeituraFinanceira';

const REF = '55555555-5555-4555-8555-555555555555';
const pendente = {
  ref: REF, criacao: 'indeterminada', baixa: null, valor: 1200, dataVencimento: '2026-10-20',
  blingContaId: null, quitacaoSolicitada: false, pendencia: 'conferir_criacao', ultimaReconciliacao: null,
};
const emRevisao = {
  ...pendente,
  ultimaReconciliacao: { alvo: 'criacao', resultado: 'revisao_manual', motivo: 'sem_referencia', em: '2026-10-09T12:00:00Z' },
};
const quitacaoPedida = { ...pendente, criacao: 'confirmada', blingContaId: '88123', quitacaoSolicitada: true, pendencia: 'quitacao_solicitada' };

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor(resposta: unknown, listaDepois: unknown[] = [], primeira: unknown = pendente) {
  const chamadas: Array<{ url: string; method: string; body: unknown }> = [];
  let listas = 0;
  const busca: BuscaAutenticada = async (url, options) => {
    chamadas.push({ url, method: options?.method ?? 'GET', body: options?.body ?? null });
    if (url === '/api/financeiro/operacoes') {
      listas++;
      return json({ success: true, operacoes: listas === 1 ? [primeira] : listaDepois });
    }
    return json(resposta);
  };
  const posts = () => chamadas.filter((c) => c.method === 'POST');
  return { busca, posts };
}

const operacaoConfirmada = { ...pendente, criacao: 'confirmada', blingContaId: '88123', pendencia: null };
const confirmada = { success: true, resultado: 'confirmada', motivo: null, projecaoLocal: 'consistente', operacao: operacaoConfirmada };

describe('operações pendentes', () => {
  it('a criação pendente só pode ser conferida — nunca criada de novo', async () => {
    render(<OperacoesPendentes fetchWithAuth={servidor(confirmada).busca} ativo versao={0} onConfirmada={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Conferir no Bling' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /tentar|lançar|criar|quitar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Número da conta no Bling' })).not.toBeInTheDocument();
    expect(screen.getByText(/Não lance de novo/u)).toBeInTheDocument();
  });

  it('conferência confirmada e registrada: mostra, recarrega o financeiro e a lista', async () => {
    const onConfirmada = vi.fn();
    const { busca, posts } = servidor(confirmada);
    render(<OperacoesPendentes fetchWithAuth={busca} ativo versao={0} onConfirmada={onConfirmada} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Conferir no Bling' }));

    expect(await screen.findByText('Confirmada no Bling e registrada no ORBITA.')).toBeInTheDocument();
    expect(onConfirmada).toHaveBeenCalledTimes(1);
    expect(posts().map((c) => c.url)).toEqual([`/api/financeiro/operacoes/${REF}/reconciliar`]);
  });

  it('confirmada no Bling com o registro local pendente: não é apresentada como concluída', async () => {
    const onConfirmada = vi.fn();
    const reparo = { ...operacaoConfirmada, pendencia: 'reparo_titulo' };
    render(
      <OperacoesPendentes
        fetchWithAuth={servidor({ ...confirmada, projecaoLocal: 'pendente', operacao: reparo }, [reparo]).busca}
        ativo
        versao={0}
        onConfirmada={onConfirmada}
      />,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Conferir no Bling' }));

    expect(await screen.findByText(/registro no ORBITA ainda não foi concluído/u)).toBeInTheDocument();
    expect(onConfirmada).not.toHaveBeenCalled();
    expect(screen.getByText(/registro no ORBITA pendente/u)).toBeInTheDocument();
  });

  it('revisão manual: explica o motivo sem prometer que a conta não existe', async () => {
    const onConfirmada = vi.fn();
    render(
      <OperacoesPendentes
        fetchWithAuth={servidor({ success: true, resultado: 'revisao_manual', motivo: 'nenhum_candidato', projecaoLocal: 'consistente', operacao: emRevisao }, [emRevisao]).busca}
        ativo
        versao={0}
        onConfirmada={onConfirmada}
      />,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Conferir no Bling' }));

    expect(await screen.findByText(/Revisão manual necessária: .*não prova que ela não exista/u)).toBeInTheDocument();
    expect(onConfirmada).not.toHaveBeenCalled();
  });

  it('depois da revisão manual, o operador aponta a conta e o servidor decide', async () => {
    const { busca, posts } = servidor(confirmada, [], emRevisao);
    render(<OperacoesPendentes fetchWithAuth={busca} ativo versao={0} onConfirmada={vi.fn()} />);

    await userEvent.type(await screen.findByRole('textbox', { name: 'Número da conta no Bling' }), '88a123');
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar esta conta' }));

    expect(await screen.findByText('Confirmada no Bling e registrada no ORBITA.')).toBeInTheDocument();
    expect(posts()).toEqual([{ url: `/api/financeiro/operacoes/${REF}/confirmacao-manual`, method: 'POST', body: '{"blingContaId":"88123"}' }]);
  });

  it('quitação pedida no lançamento: a ação é quitar, explícita, e o desfecho é mostrado', async () => {
    const onConfirmada = vi.fn();
    const { busca, posts } = servidor({ success: true, resultado: 'quitada', projecaoLocal: 'consistente', operacao: { ...quitacaoPedida, pendencia: null } }, [], quitacaoPedida);
    render(<OperacoesPendentes fetchWithAuth={busca} ativo versao={0} onConfirmada={onConfirmada} />);

    expect(screen.queryByRole('button', { name: 'Conferir no Bling' })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Quitar no Bling' }));

    expect(await screen.findByText('Quitada no Bling.')).toBeInTheDocument();
    expect(onConfirmada).toHaveBeenCalledTimes(1);
    expect(posts().map((c) => c.url)).toEqual([`/api/financeiro/operacoes/${REF}/quitacao`]);
  });

  it('Bling sem resposta completa: ainda pendente', async () => {
    render(
      <OperacoesPendentes
        fetchWithAuth={servidor({ success: true, resultado: 'revisao_manual', motivo: 'consulta_incompleta', projecaoLocal: 'consistente', operacao: pendente }, [pendente]).busca}
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
