/** @vitest-environment jsdom */
/**
 * Ticket 30, fatia 3 — 5ª rodada de revisão.
 *
 * A metade de tela do ciclo `indeterminada → reconciliar → concluída/falhou →
 * liberada`. O que estes testes protegem é a regra que torna o ciclo seguro:
 * a referência só é esquecida quando o SERVIDOR diz que o desfecho é
 * conhecido (`referenciaLiberada: true`). Esquecer em qualquer outra condição
 * — inclusive "deu erro ao conferir" — removeria a âncora de idempotência de
 * uma tentativa que ninguém resolveu, que é exatamente o furo que a proteção
 * existe para impedir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REFERENCIA = '55555555-5555-4555-8555-555555555555';
const CHAVE = `orbita:pedidos-manual:tentativa-pendente:${ORG}`;

let respostaDoServidor: Record<string, unknown> = {};
const chamadas: Array<Record<string, unknown>> = [];

vi.mock('@/lib/fetchWithAuth', () => ({
  fetchWithAuth: vi.fn(async (_url: string, options: RequestInit) => {
    chamadas.push(JSON.parse(String(options.body)) as Record<string, unknown>);
    return { ok: true, json: async () => respostaDoServidor } as Response;
  }),
}));

const { PendenciasDeVendaManual } = await import('./PendenciasDeVendaManual');

function semearPendencia() {
  window.localStorage.setItem(
    CHAVE,
    JSON.stringify([{ referencia: REFERENCIA, fingerprint: 'fp-da-venda' }]),
  );
}

describe('PendenciasDeVendaManual', () => {
  beforeEach(() => {
    chamadas.length = 0;
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('sem pendências, não mostra nada — não polui a tela do caso normal', () => {
    const { container } = render(<PendenciasDeVendaManual open organizacaoId={ORG} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('avisa sobre a venda pendente e a oferece para conferência', () => {
    semearPendencia();
    render(<PendenciasDeVendaManual open organizacaoId={ORG} />);

    expect(screen.getByText(/resultado não foi confirmado/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /conferir no bling/i })).toBeTruthy();
  });

  it('conferir manda a referência para a rota de reconciliação', async () => {
    semearPendencia();
    respostaDoServidor = { referenciaLiberada: true, mensagem: 'Conferido: o pedido não foi criado.' };
    render(<PendenciasDeVendaManual open organizacaoId={ORG} />);

    await userEvent.click(screen.getByRole('button', { name: /conferir no bling/i }));

    await waitFor(() => expect(chamadas).toEqual([{ referenciaLocal: REFERENCIA }]));
  });

  it('desfecho CONHECIDO (referenciaLiberada): esquece a pendência e mostra o que aconteceu', async () => {
    semearPendencia();
    respostaDoServidor = { referenciaLiberada: true, mensagem: 'Conferido no Bling: o pedido não chegou a ser criado.' };
    render(<PendenciasDeVendaManual open organizacaoId={ORG} />);

    await userEvent.click(screen.getByRole('button', { name: /conferir no bling/i }));

    await waitFor(() => expect(screen.getByText(/não chegou a ser criado/i)).toBeTruthy());
    expect(window.localStorage.getItem(CHAVE)).toBeNull();
  });

  it('pedido existe no Bling e não no ORBITA: MANTÉM a pendência — ainda precisa de decisão humana', async () => {
    semearPendencia();
    respostaDoServidor = {
      referenciaLiberada: false,
      mensagem: 'Conferido no Bling: o pedido 918273 existe lá, mas a venda não foi gravada no ORBITA.',
    };
    render(<PendenciasDeVendaManual open organizacaoId={ORG} />);

    await userEvent.click(screen.getByRole('button', { name: /conferir no bling/i }));

    await waitFor(() => expect(screen.getByText(/existe lá, mas a venda não foi gravada/i)).toBeTruthy());
    // O ponto: a âncora continua guardada. Sem ela não haveria como reconciliar
    // esta tentativa de novo, e uma retentativa criaria um segundo pedido.
    expect(window.localStorage.getItem(CHAVE)).toContain(REFERENCIA);
  });

  it('a conferência falha: NÃO esquece a pendência', async () => {
    semearPendencia();
    respostaDoServidor = { error: 'Não foi possível consultar o Bling agora.' };
    render(<PendenciasDeVendaManual open organizacaoId={ORG} />);

    await userEvent.click(screen.getByRole('button', { name: /conferir no bling/i }));

    await waitFor(() => expect(screen.getByText(/não foi possível consultar/i)).toBeTruthy());
    expect(window.localStorage.getItem(CHAVE)).toContain(REFERENCIA);
  });

  it('sem organização confirmada, não mostra pendência de organização nenhuma', () => {
    semearPendencia();
    const { container } = render(<PendenciasDeVendaManual open organizacaoId={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('a pendência de OUTRA organização não aparece nesta', () => {
    semearPendencia();
    const { container } = render(
      <PendenciasDeVendaManual open organizacaoId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
