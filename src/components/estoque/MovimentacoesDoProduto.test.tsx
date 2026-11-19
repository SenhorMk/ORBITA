/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { mockFetchWithAuth } = vi.hoisted(() => ({ mockFetchWithAuth: vi.fn() }));
vi.mock('@/lib/fetchWithAuth', () => ({ fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args) }));

import { MovimentacoesDoProduto } from './MovimentacoesDoProduto';

const PRODUTO_ID = '20000000-0000-4000-8000-000000000003';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe('MovimentacoesDoProduto', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mostra a baixa por venda com quantidade negativa e pede o produto certo', async () => {
    mockFetchWithAuth.mockResolvedValue(
      jsonResponse({
        success: true,
        movimentacoes: [
          { id: 'm1', tipo: 'SAIDA', origem: 'BAIXA_ORGANIZACAO_VERIFICADA', quantidade: 2, created_at: '2026-11-19T20:00:00Z' },
          { id: 'm2', tipo: 'ENTRADA', origem: 'ALINHAMENTO_SITUACAO_BLING', quantidade: 5, created_at: '2026-11-18T10:00:00Z' },
        ],
      }),
    );

    render(<MovimentacoesDoProduto produtoId={PRODUTO_ID} />);

    const lista = await screen.findByRole('list', { name: 'Movimentações de estoque' });
    expect(lista).toHaveTextContent('Baixa por venda');
    expect(lista).toHaveTextContent('−2 un');
    expect(lista).toHaveTextContent('Alinhamento com o Bling');
    expect(lista).toHaveTextContent('+5 un');
    expect(mockFetchWithAuth).toHaveBeenCalledWith(`/api/produtos/movimentacoes?produto=${PRODUTO_ID}`);
  });

  it('sem movimentações diz isso, em vez de uma lista vazia', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ success: true, movimentacoes: [] }));

    render(<MovimentacoesDoProduto produtoId={PRODUTO_ID} />);

    expect(await screen.findByText('Nenhuma movimentação registrada no ORBITA para este produto.')).toBeInTheDocument();
  });

  it('falha de leitura aparece como aviso, distinta de "nenhuma movimentação"', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ success: false, error: 'x' }, 500));

    render(<MovimentacoesDoProduto produtoId={PRODUTO_ID} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível ler as movimentações');
  });
});
