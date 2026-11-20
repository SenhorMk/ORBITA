// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SeletorDeFundo } from './SeletorDeFundo';

describe('Ajuda do fundo', () => {
  it('explica a sessão sem trocar a preferência nem submeter formulário', async () => {
    const onEscolher = vi.fn();
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const user = userEvent.setup();
    render(<form onSubmit={onSubmit}><SeletorDeFundo fundo="armazem" onEscolher={onEscolher} /></form>);
    const group = screen.getByRole('group', { name: 'Fundo da tela' });
    expect(within(group).getAllByRole('button')).toHaveLength(5);
    await user.click(within(group).getByRole('button', { name: /^Ajuda:/ }));
    expect(screen.getByRole('dialog')).toHaveTextContent('ela não é salva');
    await user.keyboard('{Escape}');
    expect(onEscolher).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Fundo Armazém' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Fundo Grafite' }));
    expect(onEscolher).toHaveBeenCalledExactlyOnceWith('grafite');
  });
});
