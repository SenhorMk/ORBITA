// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AreaDeConteudo } from './AreaDeConteudo';

describe('rolagem das telas do ERP', () => {
  it('retorna ao topo ao navegar sem remontar o conteúdo nem comandar a rolagem do SAC', async () => {
    const user = userEvent.setup();
    const content = <input aria-label="Campo em edição" defaultValue="" />;
    const { rerender } = render(<AreaDeConteudo aba="finance">{content}</AreaDeConteudo>);
    const area = screen.getByRole('main');
    const scroll = vi.fn();
    area.scrollTo = scroll;
    await user.type(screen.getByRole('textbox'), 'Valor preservado');
    rerender(<AreaDeConteudo aba="organization">{content}</AreaDeConteudo>);
    expect(scroll).toHaveBeenCalledWith({ top: 0, left: 0 });
    expect(screen.getByRole('main')).toBe(area);
    expect(screen.getByRole('textbox')).toHaveValue('Valor preservado');
    scroll.mockClear();
    rerender(<AreaDeConteudo aba="sac">{content}</AreaDeConteudo>);
    expect(scroll).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveValue('Valor preservado');
  });
});
