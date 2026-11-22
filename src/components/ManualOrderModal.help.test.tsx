// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ManualOrderModal } from './ManualOrderModal';

const boundary = vi.hoisted(() => ({ fetch: vi.fn(), session: vi.fn() }));
vi.mock('@/lib/fetchWithAuth', () => ({ fetchWithAuth: boundary.fetch }));
vi.mock('@/lib/supabaseClient', () => ({ supabase: {
  auth: { getSession: boundary.session },
  from: () => { const query = { select() { return this; }, is() { return this; }, eq() { return this; }, order: async () => ({ data: [], error: null }) }; return query; },
} }));

describe('HelpInfo no pedido manual', () => {
  it('a ajuda fica junto do destino no rodapé, sem alternar Bling ou iniciar uma venda', async () => {
    localStorage.clear();
    const user = userEvent.setup(), onSuccess = vi.fn();
    render(<ManualOrderModal open onOpenChange={vi.fn()} onSuccess={onSuccess} organizacaoId="11111111-1111-4111-8111-111111111111" />);
    const checkbox = screen.getByRole('checkbox', { name: 'Sincronizar pedido com o Bling v3' });
    expect(checkbox).toBeChecked();
    const help = screen.getByRole('button', { name: 'Ajuda: Destino do pedido manual' });
    expect(help.closest('footer')).toContainElement(checkbox);
    expect(help.parentElement).toContainElement(checkbox);
    expect(help.closest('label')).toBeNull();
    await user.click(help);
    expect(screen.getByRole('dialog', { name: 'Destino do pedido manual' })).toHaveTextContent('apenas como registro local');
    await user.keyboard('{Escape}');
    expect(help).toHaveFocus();
    expect(checkbox).toBeChecked();
    expect(screen.getByRole('button', { name: 'Finalizar e baixar estoque' })).toBeDisabled();
    expect(boundary.fetch).not.toHaveBeenCalled();
    expect(boundary.session).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
