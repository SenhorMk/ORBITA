/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { Cliente } from '@/types';

import { ClienteEditModal } from './ClienteEditModal';

/**
 * Edição × criação quando o resultado não é confirmado. Editar é `PUT` de um
 * contato que existe: a tela nunca pode dizer que ele "pode ter sido criado".
 */

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/fetchWithAuth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args) }));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) } },
}));

const EXISTENTE = { id: '33333333-3333-4333-8333-333333333333', bling_id: '4321', nome: 'Ana Souza' } as Cliente;

/** Resposta cujo corpo não é JSON: `json()` rejeita, como num 500 HTML do Next. */
const naoJson = (status: number, texto = '<!DOCTYPE html><title>Internal Server Error</title> stack: Error at handler') =>
  ({ ok: false, status, json: async () => { throw new SyntaxError(`Unexpected token < in ${texto}`); }, text: async () => texto }) as unknown as Response;
const json = (corpo: unknown, status: number) => ({ ok: status >= 200 && status < 300, status, json: async () => corpo }) as Response;

async function salvar(cliente: Cliente | null) {
  const usuaria = userEvent.setup();
  render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={cliente} onSave={vi.fn()} />);
  if (!cliente) await usuaria.type(screen.getByLabelText('Nome / Razão social *'), 'Ana Souza');
  // Tipo e contribuinte são escolha explícita: sem eles o formulário nem envia.
  await usuaria.selectOptions(screen.getByLabelText('Tipo de pessoa *'), 'F');
  await usuaria.selectOptions(screen.getByLabelText('Tipo de contribuinte *'), '9');
  await usuaria.click(screen.getByRole('button', { name: 'Salvar contato' }));
}

const texto = () => document.body.textContent ?? '';

beforeEach(() => { fetchWithAuthMock.mockReset(); });

describe('resultado não confirmado: criação diz "criado", edição diz "atualização"', () => {
  it('novo contato + rede caiu: "pode ter sido criado"', async () => {
    fetchWithAuthMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await salvar(null);
    expect((await screen.findAllByText(/O contato pode ter sido criado no Bling/u)).length).toBeGreaterThan(0);
  });

  it('edição + rede caiu: "a atualização pode ter sido aplicada", nunca "criado"', async () => {
    fetchWithAuthMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await salvar(EXISTENTE);
    expect(await screen.findByText('A atualização pode ter sido aplicada no Bling. Sincronize os clientes antes de tentar novamente.')).toBeInTheDocument();
    expect(screen.getByText('Resultado da atualização não confirmado')).toBeInTheDocument();
    expect(texto()).not.toMatch(/pode ter sido criado/u);
  });

  it('edição + 500 com corpo NÃO-JSON: mensagem segura de atualização, nada do corpo na tela, sem "tentar novamente"', async () => {
    fetchWithAuthMock.mockResolvedValue(naoJson(500));
    await salvar(EXISTENTE);
    expect((await screen.findAllByText(/A atualização pode ter sido aplicada no Bling/u)).length).toBeGreaterThan(0);
    expect(texto()).not.toMatch(/DOCTYPE|Internal Server Error|stack|Unexpected token/u);
    expect(texto()).not.toMatch(/pode ter sido criado/u);
    expect(screen.queryByRole('button', { name: /Tentar Novamente/iu })).toBeNull();
  });

  it('novo contato + 502 com corpo não-JSON: continua a mensagem de possível criação', async () => {
    fetchWithAuthMock.mockResolvedValue(naoJson(502));
    await salvar(null);
    expect((await screen.findAllByText(/O contato pode ter sido criado no Bling/u)).length).toBeGreaterThan(0);
  });

  it('edição + 502 com JSON do contrato: a frase do servidor é mostrada e o contrato é respeitado (sem retry)', async () => {
    const frase = 'Não foi possível confirmar o resultado da atualização. As alterações podem ter sido aplicadas no Bling. Sincronize os clientes e confira o contato antes de tentar novamente.';
    fetchWithAuthMock.mockResolvedValue(json({ success: false, error: frase }, 502));
    await salvar(EXISTENTE);
    expect(await screen.findByText(frase)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Tentar Novamente/iu })).toBeNull();
  });

  it('edição + JSON sem `error`: o fallback também é o de atualização', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ success: false }, 500));
    await salvar(EXISTENTE);
    expect((await screen.findAllByText(/A atualização pode ter sido aplicada no Bling/u)).length).toBeGreaterThan(0);
  });

  it('edição + limite do Bling (retrySafe): oferece tentar de novo', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ success: false, error: 'O Bling está limitando as requisições no momento. Nada foi alterado no Bling. Tente de novo em instantes.', retrySafe: true }, 503));
    await salvar(EXISTENTE);
    expect(await screen.findByRole('button', { name: /Tentar Novamente/iu })).toBeInTheDocument();
  });
});
