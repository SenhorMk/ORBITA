/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useLeituraDoPainel } from './useLeituraDoPainel';
import { fetchWithAuth } from '@/lib/fetchWithAuth';

/**
 * A leitura operacional pertence a um tenant.
 *
 * Estes testes existem para o defeito mais caro de um SaaS multi-tenant: os
 * números de uma organização aparecendo sob o nome de outra. Ele tem duas
 * formas, e as duas estão aqui — a janela da troca e a resposta fora de ordem.
 */

vi.mock('@/lib/fetchWithAuth', () => ({ fetchWithAuth: vi.fn() }));

const ESCOPO_A = 'ana@exemplo.com|org-a:1';
const ESCOPO_B = 'ana@exemplo.com|org-b:2';

function dadosCom(numero: string) {
  return {
    success: true,
    data: {
      pedidos: [{ id: numero, numero, total: 40, status: 'Entregue' }],
      produtos: [],
      clientes: [],
      estatisticas: {
        faturamento30Dias: 40,
        faturamento30DiasAnterior: 0,
        totalPedidos: 1,
        pendentes: 0,
        cancelados: 0,
        atendidos: 1,
      },
    },
  };
}

function resposta(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** Uma resposta que o teste solta quando quiser — para segurar uma leitura em voo. */
function respostaControlada() {
  let soltar: (corpo: unknown) => void = () => {};
  const promessa = new Promise<Response>((resolver) => {
    soltar = (corpo) => resolver(resposta(corpo));
  });
  return { promessa, soltar: (corpo: unknown) => soltar(corpo) };
}

function Sonda({ escopo }: { escopo: string | null }) {
  const painel = useLeituraDoPainel(escopo);
  return (
    <div>
      <span data-testid="pedido">{painel.dados?.pedidos[0]?.numero ?? '(nenhum)'}</span>
      <span data-testid="faturamento">{painel.dados?.estatisticas.faturamento30Dias ?? '(nenhum)'}</span>
      <span data-testid="erro">{painel.erro ?? '(sem erro)'}</span>
      <span data-testid="carregando">{String(painel.carregando)}</span>
      <button type="button" onClick={() => { void painel.recarregar(); }}>recarregar</button>
    </div>
  );
}

function conferirQueNadaEstaVisivel() {
  expect(screen.getByTestId('pedido')).toHaveTextContent('(nenhum)');
  expect(screen.getByTestId('faturamento')).toHaveTextContent('(nenhum)');
}

beforeEach(() => vi.clearAllMocks());

describe('a leitura do painel pertence ao escopo que a produziu', () => {
  it('A) trocar de organização torna os dados da anterior inelegíveis na hora', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(resposta(dadosCom('20')));
    const { rerender } = render(<Sonda escopo={ESCOPO_A} />);

    await waitFor(() => expect(screen.getByTestId('pedido')).toHaveTextContent('20'));

    // A leitura de B ainda não voltou.
    vi.mocked(fetchWithAuth).mockImplementation(() => new Promise(() => {}));
    rerender(<Sonda escopo={ESCOPO_B} />);

    conferirQueNadaEstaVisivel();
    expect(screen.getByTestId('carregando')).toHaveTextContent('true');
  });

  it('B) a resposta atrasada da organização anterior não sobrescreve a atual', async () => {
    const leituraDeA = respostaControlada();
    vi.mocked(fetchWithAuth)
      .mockImplementationOnce(() => leituraDeA.promessa)
      .mockImplementation(async () => resposta(dadosCom('99')));

    const { rerender } = render(<Sonda escopo={ESCOPO_A} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));

    rerender(<Sonda escopo={ESCOPO_B} />);
    await waitFor(() => expect(screen.getByTestId('pedido')).toHaveTextContent('99'));

    // Só agora A responde, com a organização de quem já saiu de cena.
    await act(async () => {
      leituraDeA.soltar(dadosCom('20'));
      await leituraDeA.promessa;
    });

    expect(screen.getByTestId('pedido')).toHaveTextContent('99');
    expect(screen.getByTestId('faturamento')).toHaveTextContent('40');
  });

  it('C) falhar a ATUALIZAÇÃO dentro da mesma organização preserva a leitura boa dela', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValueOnce(resposta(dadosCom('20')));
    render(<Sonda escopo={ESCOPO_B} />);
    await waitFor(() => expect(screen.getByTestId('pedido')).toHaveTextContent('20'));

    // A releitura da MESMA organização falha.
    vi.mocked(fetchWithAuth).mockResolvedValue(resposta({ error: 'Falha de rede' }, 500));
    await userEvent.click(screen.getByRole('button', { name: 'recarregar' }));

    await waitFor(() => expect(screen.getByTestId('erro')).toHaveTextContent('Falha de rede'));
    // O dado bom daquela mesma organização continua na tela, com o erro ao lado.
    expect(screen.getByTestId('pedido')).toHaveTextContent('20');
    expect(screen.getByTestId('faturamento')).toHaveTextContent('40');
  });

  it('D) se a leitura da nova organização falhar, a anterior não reaparece sob o nome dela', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValueOnce(resposta(dadosCom('20')));
    const { rerender } = render(<Sonda escopo={ESCOPO_A} />);
    await waitFor(() => expect(screen.getByTestId('pedido')).toHaveTextContent('20'));

    vi.mocked(fetchWithAuth).mockResolvedValue(resposta({ error: 'Não autorizado' }, 403));
    rerender(<Sonda escopo={ESCOPO_B} />);

    await waitFor(() => expect(screen.getByTestId('erro')).toHaveTextContent('Não autorizado'));
    // O ponto do teste: o erro de B não faz os números de A voltarem.
    conferirQueNadaEstaVisivel();
  });

  it('sem sessão não pergunta nada e não mostra nada', () => {
    render(<Sonda escopo={null} />);

    expect(fetchWithAuth).not.toHaveBeenCalled();
    conferirQueNadaEstaVisivel();
    expect(screen.getByTestId('carregando')).toHaveTextContent('false');
  });
});
