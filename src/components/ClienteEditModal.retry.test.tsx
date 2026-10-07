/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ClienteEditModal } from './ClienteEditModal';

const fetchWithAuthMock = vi.fn();

vi.mock('@/lib/fetchWithAuth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args),
}));

vi.mock('@/lib/supabaseClient', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) } },
}));

function resposta(corpo: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => corpo } as Response;
}

/**
 * O botão "Tentar Novamente" do `ErrorLogModal` só existe quando
 * `ClienteEditModal` passa `onRetry`. É por ele que estes casos medem a
 * decisão — não por texto de mensagem, que muda sem mudar o risco.
 */
function botaoDeRepetir() {
  return screen.queryByRole('button', { name: /Tentar Novamente/i });
}

async function salvarContatoNovo() {
  const usuaria = userEvent.setup();
  render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={null} />);
  await usuaria.type(screen.getByLabelText('Nome / Razão social *'), 'Ana Souza');
  // Tipo e contribuinte são escolha explícita: sem eles o formulário nem envia.
  await usuaria.selectOptions(screen.getByLabelText('Tipo de pessoa *'), 'F');
  await usuaria.selectOptions(screen.getByLabelText('Tipo de contribuinte *'), '9');
  await usuaria.click(screen.getByRole('button', { name: 'Salvar contato' }));
}

describe('ClienteEditModal — "tentar novamente" exige prova', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
  });

  it('resposta estruturada com retrySafe: o retry APARECE', async () => {
    // O servidor afirmou que nada foi confirmado do outro lado — contrato
    // recusado antes do envio, ou o Bling respondendo que não aceita.
    fetchWithAuthMock.mockResolvedValue(
      resposta({ success: false, error: 'O Bling recusou o cadastro do contato: documento inválido', retrySafe: true }, 400),
    );

    await salvarContatoNovo();

    await waitFor(() => expect(botaoDeRepetir()).not.toBeNull());
  });

  it('reconcileRequired: o retry NÃO aparece', async () => {
    // O Bling criou. Repetir não conserta a gravação local e cadastra um
    // segundo contato no ERP.
    fetchWithAuthMock.mockResolvedValue(
      resposta(
        {
          success: false,
          error: 'Contato salvo no Bling, mas não foi possível concluir a gravação no ORBITA. Sincronize os clientes para reconciliar.',
          reconcileRequired: true,
          blingId: '5150',
        },
        500,
      ),
    );

    await salvarContatoNovo();

    await waitFor(() => expect(screen.getAllByText(/Sincronize os clientes/i).length).toBeGreaterThan(0));
    expect(botaoDeRepetir()).toBeNull();
  });

  it('rejeição de rede: o retry NÃO aparece — e este era o bloqueio', async () => {
    // O caminho que a revisão externa apontou. O POST pode ter chegado, o Bling
    // pode ter criado o contato, e só a resposta ter se perdido. O navegador
    // cai aqui sem saber de nada; oferecer repetir é convidar a duplicar.
    fetchWithAuthMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await salvarContatoNovo();

    await waitFor(() => expect(screen.getAllByText(/não pôde ser confirmado/i).length).toBeGreaterThan(0));
    expect(botaoDeRepetir()).toBeNull();
  });

  it('rejeição de rede não afirma que nada foi criado', async () => {
    fetchWithAuthMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await salvarContatoNovo();

    await waitFor(() => expect(screen.getAllByText(/pode ter sido criado no Bling/i).length).toBeGreaterThan(0));
    // E não expõe o erro técnico, que nada diz sobre o efeito externo.
    expect(document.body.textContent).not.toContain('Failed to fetch');
  });

  it('JSON ilegível na resposta também é ambíguo: sem retry', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
    } as unknown as Response);

    await salvarContatoNovo();

    await waitFor(() => expect(screen.getAllByText(/não pôde ser confirmado/i).length).toBeGreaterThan(0));
    expect(botaoDeRepetir()).toBeNull();
  });

  it('falha sem retrySafe nem reconcileRequired é ambígua, não segura', async () => {
    // A regra que o bloqueio pediu: ausência de `reconcileRequired` NÃO é
    // sinônimo de repetição segura. Sem prova, sem botão.
    fetchWithAuthMock.mockResolvedValue(resposta({ success: false, error: 'Erro interno' }, 500));

    await salvarContatoNovo();

    await waitFor(() => expect(screen.getAllByText(/Erro interno/i).length).toBeGreaterThan(0));
    expect(botaoDeRepetir()).toBeNull();
  });
});
