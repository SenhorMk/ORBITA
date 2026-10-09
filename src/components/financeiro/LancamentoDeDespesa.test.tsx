/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import { LancamentoDeDespesa } from './LancamentoDeDespesa';
import type { BuscaAutenticada } from './useLeituraFinanceira';

/**
 * PRE-001 no formulário: a chave da operação nasce no navegador antes da rede,
 * volta igual em toda retentativa do mesmo lançamento, e um resultado não
 * confirmado não deixa o mesmo diálogo lançar de novo.
 */

const REF = '55555555-5555-4555-8555-555555555555';

function json(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

/** `fetchWithAuth` fake: fornecedores vazios, e o POST responde o que o teste programar. */
function servidor(...respostasDoPost: Array<Response | Error>) {
  const posts: Array<Record<string, unknown>> = [];
  const busca: BuscaAutenticada = async (url, options) => {
    if (url === '/api/financeiro/fornecedores') return json(200, { success: true, data: [] });
    posts.push(JSON.parse(String(options?.body)) as Record<string, unknown>);
    const proxima = respostasDoPost.shift() ?? json(500, { success: false, error: 'sem resposta programada' });
    if (proxima instanceof Error) throw proxima;
    return proxima;
  };
  return { busca, posts };
}

function Montado({ busca, onSalvo = () => {} }: { busca: BuscaAutenticada; onSalvo?: () => void }) {
  const [syncing, setSyncing] = useState(false);
  return (
    <LancamentoDeDespesa
      fetchWithAuth={busca}
      categorias={[]}
      aberto
      onFechar={() => {}}
      onSalvo={onSalvo}
      syncing={syncing}
      setSyncing={setSyncing}
    />
  );
}

async function preencherEEnviar(descricao = 'Aluguel') {
  const campoDescricao = screen.getByLabelText('Descrição do Gasto');
  await userEvent.clear(campoDescricao);
  await userEvent.type(campoDescricao, descricao);
  if ((screen.getByLabelText('Título') as HTMLInputElement).value === '') {
    await userEvent.type(screen.getByLabelText('Título'), 'Aluguel');
    await userEvent.type(screen.getByLabelText('Valor (R$)'), '1200');
    // `userEvent.type` não preenche `type="date"` no jsdom.
    fireEvent.change(screen.getByLabelText('Data Vencimento'), { target: { value: '2026-09-10' } });
  }
  await userEvent.click(screen.getByRole('button', { name: /Salvar Despesa|Salvando/i }));
}

let alerta: ReturnType<typeof vi.fn>;
beforeEach(() => {
  alerta = vi.fn();
  vi.stubGlobal('alert', alerta);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PRE-001 — o formulário diante de um resultado não confirmado', () => {
  it('não confirmado: mostra o motivo e não deixa lançar de novo pelo mesmo diálogo', async () => {
    const { busca, posts } = servidor(json(202, {
      success: false,
      error: 'O Bling não confirmou o resultado deste lançamento. Não lance de novo.',
      operacao: { ref: REF, estado: 'indeterminada' },
    }));
    render(<Montado busca={busca} />);

    await preencherEEnviar();

    expect(await screen.findByRole('status')).toHaveTextContent('Não lance de novo');
    const botao = screen.getByRole('button', { name: /Salvar Despesa/i });
    expect(botao).toBeDisabled();
    await userEvent.click(botao);
    expect(posts).toHaveLength(1);
  });

  it('a resposta se perdeu no caminho: a retentativa leva a MESMA chave', async () => {
    const onSalvo = vi.fn();
    const { busca, posts } = servidor(
      new TypeError('Failed to fetch'),
      json(200, { success: true, operacao: { ref: REF, estado: 'confirmada' } }),
    );
    render(<Montado busca={busca} onSalvo={onSalvo} />);

    await preencherEEnviar();
    await waitFor(() => expect(alerta).toHaveBeenCalledWith(expect.stringContaining('mesma operação')));
    await preencherEEnviar();

    await waitFor(() => expect(onSalvo).toHaveBeenCalled());
    expect(posts).toHaveLength(2);
    expect(posts[0]!.chaveIdempotencia).toEqual(expect.any(String));
    expect(posts[1]!.chaveIdempotencia).toBe(posts[0]!.chaveIdempotencia);
  });

  it('recusa definitiva: corrigir e enviar de novo é uma operação nova, com chave nova', async () => {
    const { busca, posts } = servidor(
      json(400, { success: false, error: 'O Bling recusou o lançamento', operacao: { ref: REF, estado: 'recusada' } }),
      json(200, { success: true }),
    );
    render(<Montado busca={busca} />);

    await preencherEEnviar();
    await waitFor(() => expect(alerta).toHaveBeenCalledWith(expect.stringContaining('recusou')));
    await preencherEEnviar();

    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.chaveIdempotencia).not.toBe(posts[0]!.chaveIdempotencia);
  });

  it('o lançamento só interno não leva chave: não há efeito externo a proteger', async () => {
    const { busca, posts } = servidor(json(200, { success: true }));
    render(<Montado busca={busca} />);

    await userEvent.click(screen.getByRole('button', { name: /Somente Interno/i }));
    await preencherEEnviar();

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.chaveIdempotencia).toBeUndefined();
  });
});
