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
  ultimaReconciliacao: {
    alvo: 'criacao', metodo: 'sem_metodo_seguro', resultado: 'revisao_manual', motivo: 'sem_referencia', em: '2026-10-09T12:00:00Z',
  },
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
      const operacoes = listas === 1 ? [primeira] : listaDepois;
      return json({ success: true, operacoes, total: operacoes.length, incompleta: false, proximoCursor: null });
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
    expect(posts()).toEqual([{
      url: `/api/financeiro/operacoes/${REF}/confirmacao-manual`, method: 'POST', body: '{"blingContaId":"88123","declaracaoDoOperador":false}',
    }]);
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
    const busca: BuscaAutenticada = async () => json({ success: true, operacoes: [], total: 0, incompleta: false, proximoCursor: null });
    const { container } = render(<OperacoesPendentes fetchWithAuth={busca} ativo versao={0} onConfirmada={vi.fn()} />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('sem referência na conta: pede a declaração; com ela marcada, vincula e diz que foi por declaração', async () => {
    const semEvidencia = { success: true, resultado: 'revisao_manual', motivo: 'sem_evidencia_positiva', projecaoLocal: 'consistente', operacao: emRevisao };
    const declarada = {
      ...confirmada,
      operacao: { ...operacaoConfirmada, ultimaReconciliacao: { ...emRevisao.ultimaReconciliacao, metodo: 'declaracao_do_operador', resultado: 'confirmada', motivo: null } },
    };
    const respostas = [semEvidencia, declarada];
    const corpos: unknown[] = [];
    const busca: BuscaAutenticada = async (url, options) => {
      if (url === '/api/financeiro/operacoes') return json({ success: true, operacoes: [emRevisao], total: 1, incompleta: false, proximoCursor: null });
      corpos.push(JSON.parse(String(options?.body)));
      return json(respostas.shift());
    };
    render(<OperacoesPendentes fetchWithAuth={busca} ativo versao={0} onConfirmada={vi.fn()} />);

    await userEvent.type(await screen.findByRole('textbox', { name: 'Número da conta no Bling' }), '88123');
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar esta conta' }));
    expect(await screen.findByText(/campos iguais não provam/u)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: /Declaro que conferi no Bling/u }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar esta conta' }));

    expect(await screen.findByText(/Vinculada pela sua declaração/u)).toBeInTheDocument();
    expect(corpos).toEqual([
      { blingContaId: '88123', declaracaoDoOperador: false },
      { blingContaId: '88123', declaracaoDoOperador: true },
    ]);
  });

  it('quitação recusada: aparece, e a ação é conferir — nunca quitar de novo sozinho', async () => {
    const recusada = { ...quitacaoPedida, baixa: 'recusada', pendencia: 'quitacao_recusada' };
    render(<OperacoesPendentes fetchWithAuth={servidor(confirmada, [recusada], recusada).busca} ativo versao={0} onConfirmada={vi.fn()} />);

    expect(await screen.findByText(/quitação recusada pelo Bling/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Conferir no Bling' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Quitar no Bling' })).not.toBeInTheDocument();
  });

  it('registro local inconsistente: visível, sem ação automática', async () => {
    const inconsistente = { ...operacaoConfirmada, pendencia: 'titulo_inconsistente' };
    render(<OperacoesPendentes fetchWithAuth={servidor(confirmada, [inconsistente], inconsistente).busca} ativo versao={0} onConfirmada={vi.fn()} />);

    expect(await screen.findByText(/requer correção administrativa/u)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('mais de uma página: diz quantas há e alcança as demais pelo cursor', async () => {
    const segunda = { ...pendente, ref: '66666666-6666-4666-8666-666666666666', valor: 900 };
    const urls: string[] = [];
    const busca: BuscaAutenticada = async (url) => {
      urls.push(url);
      return url.includes('cursor=')
        ? json({ success: true, operacoes: [segunda], total: 2, incompleta: false, proximoCursor: null })
        : json({ success: true, operacoes: [pendente], total: 2, incompleta: true, proximoCursor: 'abc' });
    };
    render(<OperacoesPendentes fetchWithAuth={busca} ativo versao={0} onConfirmada={vi.fn()} />);

    expect(await screen.findByText('Mostrando 1 de 2 pendências.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));

    expect(await screen.findByText(/R\$\s?900,00/u)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Conferir no Bling' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).not.toBeInTheDocument();
    expect(urls).toContain('/api/financeiro/operacoes?cursor=abc');
  });

  it('falha ao carregar a lista: a tela diz, em vez de sumir', async () => {
    const busca: BuscaAutenticada = async () => json({ success: false, error: 'indisponível' }, 503);
    render(<OperacoesPendentes fetchWithAuth={busca} ativo versao={0} onConfirmada={vi.fn()} />);

    expect(await screen.findByText(/Não foi possível carregar as pendências agora/u)).toBeInTheDocument();
  });

  it('Bling "Pago" sem saldo comprovado: aparece como divergência, com conferência', async () => {
    const divergente = { ...operacaoConfirmada, pendencia: 'pagamento_nao_comprovado' };
    render(<OperacoesPendentes fetchWithAuth={servidor(confirmada, [divergente], divergente).busca} ativo versao={0} onConfirmada={vi.fn()} />);

    expect(await screen.findByText(/o Bling indica pago, sem saldo zerado/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Conferir no Bling' })).toBeInTheDocument();
  });
});
