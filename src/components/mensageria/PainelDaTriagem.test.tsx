/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PainelDaTriagem } from './PainelDaTriagem';

const CONVERSA = 'c0000000-0000-4000-8000-000000000001';
const OUTRA = 'c0000000-0000-4000-8000-000000000002';
const CASO = '55555555-5555-4555-8555-555555555555';
const TRIAGEM = {
  versao: 1, intencao: 'troca_ou_devolucao', motivo: 'Quer trocar o tamanho da camiseta.', confianca: 'media', numeroDoPedido: '1001',
  resolucaoPedida: 'troca', entidades: [], informacoesFaltando: ['tamanho desejado'], proximaPergunta: 'Qual tamanho você prefere?',
  precisaDeHumano: true, motivoDoHumano: 'pediu para falar com uma pessoa',
};

const json = (corpo: unknown, status = 200) => ({ ok: status < 300, status, json: async () => corpo }) as Response;
const resposta = (execucao: unknown, pendente = false) => json({
  success: true, versao: 1, caso: { id: CASO, fase: 'TRIAGE', pendente, execucao },
});
const execucao = (campos: Record<string, unknown>) => ({
  status: 'concluida', motivo: null, triagem: TRIAGEM, provedor: 'google', modelo: 'gemini-2.5-flash',
  criadaEm: '2026-11-12T10:00:00Z', concluidaEm: '2026-11-12T10:00:02Z', ...campos,
});

describe('PainelDaTriagem', () => {
  it('concluída: intenção, motivo, número citado como não verificado, pergunta sugerida e aviso de humano', async () => {
    const fetchWithAuth = vi.fn(async () => resposta(execucao({})));
    render(<PainelDaTriagem fetchWithAuth={fetchWithAuth} conversaId={CONVERSA} />);
    expect(await screen.findByLabelText('Intenção')).toHaveTextContent('Troca ou devolução');
    expect(fetchWithAuth).toHaveBeenCalledWith(`/api/sac/triagem?conversaId=${CONVERSA}`);
    expect(screen.getByText(/citou o pedido 1001 \(não verificado\)/u)).toBeInTheDocument();
    expect(screen.getByText(/Qual tamanho você prefere/u)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/pediu para falar com uma pessoa/u);
    expect(screen.getByText(/Hipótese da IA \(gemini-2.5-flash\)/u)).toBeInTheDocument();
  });

  it('modelo falso: diz que não há IA real', async () => {
    render(<PainelDaTriagem fetchWithAuth={vi.fn(async () => resposta(execucao({ provedor: 'fake', modelo: 'falso-v1' })))} conversaId={CONVERSA} />);
    expect(await screen.findByText(/modelo falso, sem IA real/u)).toBeInTheDocument();
  });

  it.each([
    ['handoff', 'sem_orcamento', /Limite diário/u],
    ['handoff', 'schema_invalido', /fora do formato/u],
    ['handoff', 'entrada_bloqueada', /não foi enviada à IA/u],
    ['falha', 'limite_do_provedor', /pediu para esperar/u],
  ])('%s por %s: o motivo aparece, sem resultado', async (status, motivo, texto) => {
    render(<PainelDaTriagem fetchWithAuth={vi.fn(async () => resposta(execucao({ status, motivo, triagem: null })))} conversaId={CONVERSA} />);
    expect(await screen.findByRole('status')).toHaveTextContent(texto);
    expect(screen.queryByLabelText('Intenção')).not.toBeInTheDocument();
  });

  it('falha sem tentativa na fila não promete repetição; com tentativa na fila, avisa', async () => {
    const semFila = render(<PainelDaTriagem fetchWithAuth={vi.fn(async () => resposta(execucao({ status: 'falha', motivo: 'interrompida', triagem: null })))} conversaId={CONVERSA} />);
    const aviso = await screen.findByRole('status');
    expect(aviso).toHaveTextContent('A triagem foi interrompida.');
    expect(aviso).not.toHaveTextContent(/fila|refeita|tentada/u);
    semFila.unmount();
    render(<PainelDaTriagem fetchWithAuth={vi.fn(async () => resposta(execucao({ status: 'falha', motivo: 'timeout', triagem: null }), true))} conversaId={CONVERSA} />);
    expect(await screen.findByRole('status')).toHaveTextContent(/demorou demais\. Há outra triagem na fila\./u);
  });

  it('na fila, sem execução: diz que está na fila', async () => {
    render(<PainelDaTriagem fetchWithAuth={vi.fn(async () => resposta(null, true))} conversaId={CONVERSA} />);
    expect(await screen.findByText('Triagem na fila.')).toBeInTheDocument();
  });

  it('resposta fora do contrato ou erro: aviso, nenhum resultado', async () => {
    render(<PainelDaTriagem fetchWithAuth={vi.fn(async () => resposta(execucao({ triagem: { ...TRIAGEM, intencao: 'pizza' } })))} conversaId={CONVERSA} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Não foi possível ler/u);
    expect(screen.queryByLabelText('Intenção')).not.toBeInTheDocument();
  });

  it('sem caso: não mostra nada; atualizar lê de novo; trocar de conversa lê a outra', async () => {
    const fetchWithAuth = vi.fn(async (url: string) => (url.includes(OUTRA)
      ? json({ success: true, versao: 1, caso: null })
      : resposta(null, true)));
    const { rerender } = render(<PainelDaTriagem fetchWithAuth={fetchWithAuth} conversaId={CONVERSA} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Atualizar triagem' }));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
    rerender(<PainelDaTriagem fetchWithAuth={fetchWithAuth} conversaId={OUTRA} />);
    await waitFor(() => expect(screen.queryByLabelText('Triagem do caso')).not.toBeInTheDocument());
  });
});
