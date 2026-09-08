/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useLeituraFinanceira } from './useLeituraFinanceira';

/**
 * Numa tela que mostra dinheiro, **falha de leitura não pode virar R$ 0,00**.
 *
 * O hook começava em `{ receitas: 0, despesas: 0, saldo: 0 }` e o `catch` só
 * escrevia no console: os zeros de partida continuavam na tela e o lojista lia
 * "não há movimento" onde a verdade era "não consegui carregar". Estes dois
 * casos são o comportamento observável que separa as duas coisas — e são os
 * únicos testes novos desta fatia, porque o resto dela é reskin.
 */

const RESUMO = { receitas: 1500, despesas: 400, saldo: 1100 };

function resposta(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function leituraBoa() {
  return resposta({
    success: true,
    data: { resumo: RESUMO, titulos: [], categorias: [] },
  });
}

/** A tela reduzida ao que importa aqui: há resumo? está carregando? falhou? */
function Sonda({ fetchWithAuth }: { fetchWithAuth: (url: string) => Promise<Response> }) {
  const financeiro = useLeituraFinanceira(fetchWithAuth, true);
  return (
    <div>
      <span data-testid="resumo">
        {financeiro.resumo === null ? '(sem leitura)' : String(financeiro.resumo.saldo)}
      </span>
      <span data-testid="erro">{financeiro.erroDeLeitura ?? '(sem erro)'}</span>
      <span data-testid="carregando">{financeiro.carregando ? 'sim' : 'nao'}</span>
      <span data-testid="nunca">{financeiro.nuncaCarregou ? 'sim' : 'nao'}</span>
      <button type="button" onClick={() => { void financeiro.fetchFinanceiro(); }}>
        recarregar
      </button>
    </div>
  );
}

describe('useLeituraFinanceira — erro não vira zero', () => {
  it('a primeira leitura que falha não apresenta totais zerados como dado válido', async () => {
    const fetchWithAuth = vi.fn(async () =>
      resposta({ success: false, error: 'Não foi possível concluir a operação.' }, 500),
    );

    render(<Sonda fetchWithAuth={fetchWithAuth} />);

    await waitFor(() => {
      expect(screen.getByTestId('erro')).toHaveTextContent('Não foi possível concluir a operação.');
    });

    // O que a tela usa para decidir entre ErrorState e números: não há resumo,
    // não há leitura, e não está mais "carregando".
    expect(screen.getByTestId('resumo')).toHaveTextContent('(sem leitura)');
    expect(screen.getByTestId('nunca')).toHaveTextContent('sim');
    expect(screen.getByTestId('carregando')).toHaveTextContent('nao');
  });

  it('uma atualização que falha depois de uma leitura boa preserva os números e avisa', async () => {
    const fetchWithAuth = vi
      .fn<(url: string) => Promise<Response>>()
      .mockResolvedValueOnce(leituraBoa())
      .mockRejectedValueOnce(new Error('Falha de rede'));

    render(<Sonda fetchWithAuth={fetchWithAuth} />);

    await waitFor(() => {
      expect(screen.getByTestId('resumo')).toHaveTextContent('1100');
    });

    await userEvent.click(screen.getByRole('button', { name: 'recarregar' }));

    await waitFor(() => {
      expect(screen.getByTestId('erro')).toHaveTextContent('Falha de rede');
    });

    // A última leitura boa continua na tela — apagá-la trocaria informação
    // verdadeira por nenhuma. O aviso é que diz que ela envelheceu.
    expect(screen.getByTestId('resumo')).toHaveTextContent('1100');
    expect(screen.getByTestId('nunca')).toHaveTextContent('nao');
  });
});
