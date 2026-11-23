/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PropostaPersistida } from './PropostaPersistida';

const id = (n: number) => 'eed00000-0000-4000-8000-' + String(n).padStart(12, '0');
const digest1 = '1'.repeat(64);
const digest2 = '2'.repeat(64);
const item = { id: id(3), produtoId: id(4), nome: 'Camiseta sintética', codigo: null, quantidade: 2,
  valorUnitario: 40.99, estoque: { situacao: 'disponivel', disponivel: 7 } } as const;
const recebido = { estado: 'ok', casoId: id(5), versao: 1, digest: digest1, situacao: 'rascunho' };
const leitura = { ...recebido, entrada: { tipo: 'devolucao', pedidoId: id(2), itemId: item.id, quantidade: 1, motivo: 'avaria' },
  pendencias: [], podeAprovar: true, podeRejeitar: true, fatosAlterados: false, expiraEm: '2026-11-24T17:00:00Z' };

const json = (data: unknown) => ({ ok: true, json: async () => data } as Response);

describe('editor da proposta com API simulada', () => {
  it('grava um rascunho, decide a versão lida e salva uma nova versão', async () => {
    const aprovada = { ...recebido, situacao: 'aprovada' };
    const versao2 = { ...recebido, versao: 2, digest: digest2 };
    const fetchWithAuth = vi.fn()
      .mockResolvedValueOnce(json({ estado: 'sem_proposta' }))
      .mockResolvedValueOnce(json(recebido))
      .mockResolvedValueOnce(json(leitura))
      .mockResolvedValueOnce(json(aprovada))
      .mockResolvedValueOnce(json({ ...leitura, ...aprovada, podeAprovar: false, podeRejeitar: false }))
      .mockResolvedValueOnce(json(versao2))
      .mockResolvedValueOnce(json({ ...leitura, ...versao2 }));
    render(<PropostaPersistida fetchWithAuth={fetchWithAuth} conversaId={id(1)} pedidoId={id(2)} itens={[item]} />);
    const user = userEvent.setup();
    await user.click(screen.getByText('Proposta e decisão de troca'));
    await user.selectOptions(await screen.findByLabelText('Tipo da proposta'), 'devolucao');
    await user.selectOptions(screen.getByLabelText('Item da proposta'), item.id);
    await user.type(screen.getByLabelText('Quantidade da proposta'), '1');
    await user.selectOptions(screen.getByLabelText('Motivo da proposta'), 'avaria');
    await user.click(screen.getByRole('button', { name: 'Salvar rascunho' }));
    await user.click(await screen.findByRole('button', { name: 'Aprovar proposta' }));
    expect(await screen.findByText('Proposta aprovada, troca ainda não executada.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Salvar nova versão' }));
    expect(await screen.findByText('Versão 2 · rascunho')).toBeVisible();
    const comandos = fetchWithAuth.mock.calls
      .filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(init.body));
    expect(comandos).toEqual([
      { acao: 'criar', conversaId: id(1), entrada: leitura.entrada, operacaoId: expect.any(String) },
      { acao: 'aprovar', conversaId: id(1), versao: 1, digest: digest1, operacaoId: expect.any(String) },
      { acao: 'editar', conversaId: id(1), versao: 1, digest: digest1, entrada: leitura.entrada, operacaoId: expect.any(String) },
    ]);
    expect(new Set(comandos.map(c => c.operacaoId)).size).toBe(3);
  });
});
