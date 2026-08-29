/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { RegisterForm } from './RegisterForm';

const GENERIC_MESSAGE =
  'Se os dados informados forem válidos, você receberá um e-mail para confirmar seu cadastro.';

interface RecordedRegisterRequest {
  readonly url: string;
  readonly body: unknown;
}

let recorded: RecordedRegisterRequest[] = [];

/** Fake of `POST /api/auth/register`, answering exactly as the hardened route does. */
function registerEndpointFake(status: number, payload: unknown) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    recorded.push({
      url: typeof input === 'string' ? input : String(input),
      body: JSON.parse(String(init?.body ?? 'null')),
    });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

async function fillAndSubmit(email: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Nome'), 'Maria Souza');
  await user.type(screen.getByLabelText('E-mail'), email);
  await user.type(screen.getByLabelText('Senha'), 'senha-forte-1');
  await user.click(screen.getByRole('button', { name: /criar conta/iu }));
}

describe('RegisterForm', () => {
  beforeEach(() => {
    recorded = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('envia o cadastro para /api/auth/register e mostra a mensagem genérica de sucesso', async () => {
    vi.stubGlobal('fetch', registerEndpointFake(200, { success: true, message: GENERIC_MESSAGE }));

    render(<RegisterForm />);
    await fillAndSubmit('novo@empresa.com');

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(GENERIC_MESSAGE));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.url).toBe('/api/auth/register');
    expect(recorded[0]?.body).toEqual({
      name: 'Maria Souza',
      email: 'novo@empresa.com',
      password: 'senha-forte-1',
    });
  });

  it('não distingue e-mail novo de e-mail já cadastrado (sem enumeração de contas)', async () => {
    // A rota responde de forma idêntica nos dois casos (Ticket 07). A UI só pode
    // repetir a resposta da rota: qualquer texto diferente aqui transformaria a
    // tela de cadastro num oráculo de e-mails registrados.
    vi.stubGlobal('fetch', registerEndpointFake(200, { success: true, message: GENERIC_MESSAGE }));
    const { unmount } = render(<RegisterForm />);
    await fillAndSubmit('novo@empresa.com');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(GENERIC_MESSAGE));
    const newAddressFeedback = screen.getByRole('status').textContent;
    unmount();

    render(<RegisterForm />);
    await fillAndSubmit('ja-cadastrado@empresa.com');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(GENERIC_MESSAGE));

    expect(screen.getByRole('status').textContent).toBe(newAddressFeedback);
    expect(screen.queryByText(/já (existe|está|em uso)|cadastrad[oa] anteriormente/iu)).toBeNull();
  });

  it('mostra o erro de validação devolvido pela rota sem inventar detalhes', async () => {
    vi.stubGlobal(
      'fetch',
      registerEndpointFake(400, { success: false, error: 'A senha deve ter pelo menos 6 caracteres.' }),
    );

    render(<RegisterForm />);
    await fillAndSubmit('novo@empresa.com');

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('A senha deve ter pelo menos 6 caracteres.'),
    );
  });

  it('degrada para uma mensagem genérica quando a rota falha', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    render(<RegisterForm />);
    await fillAndSubmit('novo@empresa.com');

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Não foi possível concluir o cadastro agora. Tente novamente mais tarde.',
      ),
    );
  });
});
