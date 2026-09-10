/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TelaDeEntrada } from './TelaDeEntrada';

function montar(sobrescreve: Partial<Parameters<typeof TelaDeEntrada>[0]> = {}) {
  const props = {
    modo: 'signin' as const,
    onTrocarModo: vi.fn(),
    email: '',
    onEmailChange: vi.fn(),
    senha: '',
    onSenhaChange: vi.fn(),
    onSubmit: vi.fn((evento: React.FormEvent) => evento.preventDefault()),
    erro: null,
    carregando: false,
    logo: <svg data-testid="marca-orbita" />,
    ...sobrescreve,
  };
  render(<TelaDeEntrada {...props} />);
  return props;
}

describe('TelaDeEntrada', () => {
  it('pede e-mail e senha, e chama esses campos pelo nome deles', () => {
    montar();

    expect(screen.getByLabelText('E-mail')).toBeTruthy();
    expect(screen.getByLabelText('Senha')).toBeTruthy();
  });

  it('não anuncia o provedor de identidade, o ERP nem o atalho de desenvolvimento', () => {
    montar();
    const texto = document.body.textContent ?? '';

    // Cada uma destas frases dizia ao visitante que ele estava no painel de
    // outra pessoa: o subtítulo da marca vendia o produto como integração de
    // terceiros, e os rótulos dos campos imprimiam um atalho interno numa tela
    // pública. O mecanismo não mudou — só parou de ser anunciado.
    for (const legado of [
      'Ecosistema ERP Bling & Chatwoot',
      'Acesso Autenticado',
      'Supabase',
      'Usuário Dev',
      'Senha Credencial',
      'dev: admin',
    ]) {
      expect(texto, `a tela de entrada ainda mostra "${legado}"`).not.toContain(legado);
    }

    // E nenhum placeholder ensina a credencial de desenvolvimento.
    for (const campo of screen.getAllByRole('textbox').concat(
      Array.from(document.querySelectorAll('input[type="password"]')) as HTMLElement[],
    )) {
      expect(campo.getAttribute('placeholder') ?? '').not.toMatch(/dev|admin/i);
    }
  });

  it('mantém os id dos controles que a suíte E2E usa para entrar', () => {
    montar();

    // Trocar estes quatro cegaria a suíte inteira do mesmo jeito que os rótulos
    // antigos do rail cegaram — é o defeito que o Ticket 09 existiu para
    // fechar, e não vale reabri-lo pelo outro lado.
    for (const id of ['email-input', 'password-input', 'btn-login-submit', 'btn-auth-mode-toggle']) {
      expect(document.getElementById(id), `#${id} sumiu`).toBeTruthy();
    }
  });

  it('mantém o caminho para criar conta', async () => {
    const usuaria = userEvent.setup();
    const { onTrocarModo } = montar();

    await usuaria.click(screen.getByRole('button', { name: 'Criar conta' }));
    expect(onTrocarModo).toHaveBeenCalled();
  });

  it('mostra o erro de autenticação como texto, e não só como cor', () => {
    montar({ erro: 'E-mail ou senha inválidos.' });

    expect(screen.getByText('E-mail ou senha inválidos.')).toBeTruthy();
  });

  it('não autentica nada por conta própria: apenas entrega o envio a quem decide', async () => {
    const usuaria = userEvent.setup();
    const { onSubmit } = montar({ email: 'alguem@exemplo.com', senha: 'segredo' });

    await usuaria.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('bloqueia o envio enquanto a autenticação está em curso', () => {
    montar({ carregando: true });

    expect(screen.getByRole('button', { name: /Entrando/ }).hasAttribute('disabled')).toBe(true);
  });
});
