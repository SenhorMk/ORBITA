// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Dialog from '@radix-ui/react-dialog';
import { HelpInfo } from './HelpInfo';
import { catalogoDeAjuda, type AjudaId } from './catalogo';

describe('HelpInfo', () => {
  it.each(Object.keys(catalogoDeAjuda) as AjudaId[])('mostra o conteúdo específico de %s por clique', async (ajudaId) => {
    const user = userEvent.setup();
    render(<HelpInfo ajudaId={ajudaId} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: `Ajuda: ${catalogoDeAjuda[ajudaId].titulo}` });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: catalogoDeAjuda[ajudaId].titulo });
    for (const text of [catalogoDeAjuda[ajudaId].oQueE, catalogoDeAjuda[ajudaId].comoUsar, catalogoDeAjuda[ajudaId].depois, catalogoDeAjuda[ajudaId].atencao]) {
      expect(within(dialog).getByText(text)).toBeVisible();
    }
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it.each(['{Enter}', ' '])('abre por teclado com %s e mantém o foco dentro da ajuda', async (key) => {
    const user = userEvent.setup();
    render(<><HelpInfo ajudaId="sac.rascunho" /><button type="button">Fora</button></>);
    await user.tab();
    const trigger = screen.getByRole('button', { name: /^Ajuda:/ });
    expect(trigger).toHaveFocus();
    await user.keyboard(key);
    const close = screen.getByRole('button', { name: 'Fechar ajuda' });
    expect(close).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
  });

  it('não submete o formulário nem chama serviços ao consultar ajuda', async () => {
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const user = userEvent.setup();
    render(<form onSubmit={submit}><input aria-label="Valor" defaultValue="123" /><HelpInfo ajudaId="financeiro.despesa" /></form>);
    await user.click(screen.getByRole('button', { name: /^Ajuda:/ }));
    await user.click(screen.getByRole('button', { name: 'Fechar ajuda' }));
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Valor' })).toHaveValue('123');
  });

  it('isola mouse e teclado das ações do contêiner de origem', async () => {
    const acao = vi.fn();
    const user = userEvent.setup();
    render(<div onClick={acao} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') acao(); }}>
      <HelpInfo ajudaId="estoque.produto" />
    </div>);
    const trigger = screen.getByRole('button', { name: /^Ajuda:/ });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Fechar ajuda' }));
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog')).toBeVisible();
    await user.keyboard('{Escape}');
    await user.keyboard(' ');
    expect(screen.getByRole('dialog')).toBeVisible();
    await user.keyboard('{Escape}');
    expect(acao).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  it('fecha somente a ajuda e devolve o foco ao modal de origem', async () => {
    const user = userEvent.setup();
    render(<Dialog.Root defaultOpen><Dialog.Portal><Dialog.Content aria-describedby={undefined}>
      <Dialog.Title>Editar contato</Dialog.Title><HelpInfo ajudaId="clientes.editar" />
      <input aria-label="Nome do contato" defaultValue="Contato sintético" />
    </Dialog.Content></Dialog.Portal></Dialog.Root>);
    const trigger = screen.getByRole('button', { name: /^Ajuda:/ });
    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: catalogoDeAjuda['clientes.editar'].titulo })).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Editar contato' })).toBeVisible();
    expect(screen.getByRole('textbox')).toHaveValue('Contato sintético');
    expect(trigger).toHaveFocus();
  });

  it('mantém instâncias com IDs de diálogo distintos', async () => {
    const user = userEvent.setup();
    render(<><HelpInfo ajudaId="sac.triagem" /><HelpInfo ajudaId="sac.triagem" /></>);
    const triggers = screen.getAllByRole('button', { name: /^Ajuda:/ });
    await user.click(triggers[0]);
    const firstId = screen.getByRole('dialog').id;
    expect(firstId).not.toBe('');
    await user.keyboard('{Escape}');
    await user.click(triggers[1]);
    expect(screen.getByRole('dialog').id).not.toBe(firstId);
    await user.keyboard('{Escape}');
    expect(triggers[1]).toHaveFocus();
  });

  it('isola Escape de um listener de origem ainda registrado e o libera ao fechar', async () => {
    const user = userEvent.setup();
    const origem = vi.fn();
    document.addEventListener('keydown', origem, true);
    try {
      render(<HelpInfo ajudaId="financeiro.despesa" />);
      const trigger = screen.getByRole('button', { name: /^Ajuda:/ });
      await user.click(trigger);
      fireEvent.keyDown(screen.getByRole('button', { name: 'Fechar ajuda' }), { key: 'Escape' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(origem).not.toHaveBeenCalled();
      await waitFor(() => expect(trigger).toHaveFocus());
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(origem).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', origem, true);
    }
  });
});
