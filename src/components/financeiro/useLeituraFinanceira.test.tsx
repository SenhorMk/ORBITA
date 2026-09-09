/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useLeituraFinanceira, type FiltroDeTipo } from './useLeituraFinanceira';

/**
 * Duas mentiras que a tela do dinheiro não pode contar.
 *
 * 1. **Falha de leitura não é R$ 0,00.** O hook começava em
 *    `{ receitas: 0, despesas: 0, saldo: 0 }` e o `catch` só escrevia no
 *    console: os zeros de partida ficavam na tela e o lojista lia "não há
 *    movimento" onde a verdade era "não consegui carregar".
 * 2. **Dado de um filtro não vale por outro.** Sem carimbo de escopo, a
 *    "última leitura boa" preservada num refresh falhado podia ser a resposta
 *    de OUTRA pergunta — e uma resposta atrasada podia sobrescrever a atual.
 */

const RESUMO_TODOS = { receitas: 1500, despesas: 400, saldo: 1100 };

function resposta(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function leituraBoa(saldo: number, descricao: string) {
  return resposta({
    success: true,
    data: {
      resumo: { receitas: saldo, despesas: 0, saldo },
      titulos: [{ id: descricao, tipo: 'receber', situacao: 'pago', valor: saldo, data_vencimento: '2026-09-01', descricao }],
      categorias: [],
    },
  });
}

/** Uma resposta que o teste solta quando quiser — para segurar uma leitura em voo. */
function respostaControlada() {
  let soltar: (corpo: Response) => void = () => {};
  const promessa = new Promise<Response>((resolver) => { soltar = resolver; });
  return { promessa, soltar: (corpo: Response) => soltar(corpo) };
}

/** A tela reduzida ao que importa aqui. */
function Sonda({ fetchWithAuth }: { fetchWithAuth: (url: string) => Promise<Response> }) {
  const financeiro = useLeituraFinanceira(fetchWithAuth, true);
  return (
    <div>
      <span data-testid="resumo">
        {financeiro.resumo === null ? '(sem leitura)' : String(financeiro.resumo.saldo)}
      </span>
      <span data-testid="titulos">
        {financeiro.titulos.map((t) => t.descricao).join(',') || '(vazio)'}
      </span>
      <span data-testid="erro">{financeiro.erroDeLeitura ?? '(sem erro)'}</span>
      <span data-testid="carregando">{financeiro.carregando ? 'sim' : 'nao'}</span>
      <span data-testid="nunca">{financeiro.nuncaCarregou ? 'sim' : 'nao'}</span>
      <span data-testid="filtro">{financeiro.filtroTipo}</span>
      <button type="button" onClick={() => { void financeiro.fetchFinanceiro(); }}>recarregar</button>
      {(['todos', 'receber', 'pagar'] as FiltroDeTipo[]).map((tipo) => (
        <button key={tipo} type="button" onClick={() => financeiro.setFiltroTipo(tipo)}>{tipo}</button>
      ))}
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

    expect(screen.getByTestId('resumo')).toHaveTextContent('(sem leitura)');
    expect(screen.getByTestId('nunca')).toHaveTextContent('sim');
    expect(screen.getByTestId('carregando')).toHaveTextContent('nao');
  });

  it('uma atualização que falha depois de uma leitura boa preserva os números e avisa', async () => {
    const fetchWithAuth = vi
      .fn<(url: string) => Promise<Response>>()
      .mockResolvedValueOnce(resposta({ success: true, data: { resumo: RESUMO_TODOS, titulos: [] } }))
      .mockRejectedValueOnce(new Error('Falha de rede'));

    render(<Sonda fetchWithAuth={fetchWithAuth} />);

    await waitFor(() => expect(screen.getByTestId('resumo')).toHaveTextContent('1100'));

    await userEvent.click(screen.getByRole('button', { name: 'recarregar' }));

    await waitFor(() => expect(screen.getByTestId('erro')).toHaveTextContent('Falha de rede'));

    // A última leitura boa continua na tela — apagá-la trocaria informação
    // verdadeira por nenhuma. O aviso é que diz que ela envelheceu.
    expect(screen.getByTestId('resumo')).toHaveTextContent('1100');
    expect(screen.getByTestId('nunca')).toHaveTextContent('nao');
  });
});

describe('useLeituraFinanceira — o escopo do filtro', () => {
  it('a leitura boa de Todos não vaza para Entradas quando Entradas falha', async () => {
    const fetchWithAuth = vi.fn(async (url: string) => (
      url.includes('tipo=receber')
        ? resposta({ success: false, error: 'Serviço indisponível' }, 503)
        : leituraBoa(1100, 'de Todos')
    ));

    render(<Sonda fetchWithAuth={fetchWithAuth} />);
    await waitFor(() => expect(screen.getByTestId('titulos')).toHaveTextContent('de Todos'));

    await userEvent.click(screen.getByRole('button', { name: 'receber' }));

    await waitFor(() => expect(screen.getByTestId('erro')).toHaveTextContent('Serviço indisponível'));

    // O filtro visual diz Entradas; o que estava carregado era de Todos. Se
    // ele continuasse aparecendo, a tela estaria mentindo sobre QUAL pergunta
    // foi respondida — não sobre a idade da resposta.
    expect(screen.getByTestId('filtro')).toHaveTextContent('receber');
    expect(screen.getByTestId('titulos')).toHaveTextContent('(vazio)');
    expect(screen.getByTestId('resumo')).toHaveTextContent('(sem leitura)');
    expect(screen.getByTestId('nunca')).toHaveTextContent('sim');
  });

  it('voltar ao filtro anterior mostra de novo a leitura boa dele, e não a falha do outro', async () => {
    const fetchWithAuth = vi.fn(async (url: string) => (
      url.includes('tipo=receber')
        ? resposta({ success: false, error: 'Serviço indisponível' }, 503)
        : leituraBoa(1100, 'de Todos')
    ));

    render(<Sonda fetchWithAuth={fetchWithAuth} />);
    await waitFor(() => expect(screen.getByTestId('titulos')).toHaveTextContent('de Todos'));

    await userEvent.click(screen.getByRole('button', { name: 'receber' }));
    await waitFor(() => expect(screen.getByTestId('nunca')).toHaveTextContent('sim'));

    await userEvent.click(screen.getByRole('button', { name: 'todos' }));

    await waitFor(() => expect(screen.getByTestId('titulos')).toHaveTextContent('de Todos'));
    expect(screen.getByTestId('erro')).toHaveTextContent('(sem erro)');
  });

  it('a resposta que chega atrasada não sobrescreve o escopo que já é o atual', async () => {
    const entradasEmVoo = respostaControlada();
    const fetchWithAuth = vi.fn(async (url: string) => {
      if (url.includes('tipo=receber')) return entradasEmVoo.promessa;
      if (url.includes('tipo=pagar')) return leituraBoa(300, 'de Saídas');
      return leituraBoa(1100, 'de Todos');
    });

    render(<Sonda fetchWithAuth={fetchWithAuth} />);
    await waitFor(() => expect(screen.getByTestId('titulos')).toHaveTextContent('de Todos'));

    // Entradas sai e fica presa; o usuário já vai para Saídas, que responde.
    await userEvent.click(screen.getByRole('button', { name: 'receber' }));
    await userEvent.click(screen.getByRole('button', { name: 'pagar' }));
    await waitFor(() => expect(screen.getByTestId('titulos')).toHaveTextContent('de Saídas'));

    // Só então Entradas responde. Ela é de outra pergunta: não tem onde ser aplicada.
    entradasEmVoo.soltar(leituraBoa(999, 'de Entradas'));

    await waitFor(() => expect(screen.getByTestId('filtro')).toHaveTextContent('pagar'));
    expect(screen.getByTestId('titulos')).toHaveTextContent('de Saídas');
    expect(screen.getByTestId('resumo')).toHaveTextContent('300');
  });
});
