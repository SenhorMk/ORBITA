// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { PainelDaResposta } from './PainelDaResposta';

afterEach(cleanup);

it('exibe a sugestão como rascunho e só preenche o compositor após ação humana', async () => {
  const fetchWithAuth = vi.fn(async () => Response.json({ estado: 'rascunho', texto: 'Resposta sintética', provedor: 'fake' }));
  const usar = vi.fn();
  render(<PainelDaResposta fetchWithAuth={fetchWithAuth} conversaId="conversa"
    compositorOcupado={false} usar={usar} />);
  fireEvent.click(screen.getByRole('button', { name: 'Gerar rascunho de resposta' }));
  expect(await screen.findByText('Resposta sintética')).toBeDefined();
  expect(screen.getByText(/Modelo de demonstração/u)).toBeDefined();
  expect(usar).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Usar no compositor' }));
  expect(usar).toHaveBeenCalledExactlyOnceWith('Resposta sintética');
  expect(fetchWithAuth).toHaveBeenCalledExactlyOnceWith('/api/sac/resposta?conversaId=conversa', { method: 'POST' });
});
