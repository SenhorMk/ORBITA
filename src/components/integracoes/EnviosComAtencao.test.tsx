/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { EventoDaOutbox } from '@/lib/integrations/contratoDaOutbox';
import { EnviosComAtencao } from './EnviosComAtencao';

/**
 * MSG-007: o operador vê por que um envio não pode ser repetido, e o reenvio
 * só aparece quando a não aplicação foi provada (e para quem gere).
 */

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const ORG = { id: 'org-a', versao: 1 };

function evento(overrides: Partial<EventoDaOutbox> = {}): EventoDaOutbox {
  return {
    id: '11111111-1111-4111-8111-111111111111', destino: 'chatwoot', tipo: 'message.send', status: 'unknown',
    desfecho: 'desconhecido', motivoBloqueio: 'timeout', resolucao: null, tentativasContadas: 1, podeRepetir: false,
    explicacao: 'O provedor não respondeu a tempo. A mensagem pode ter sido entregue. Não reenvie: confira no provedor e registre o resultado.',
    atualizadoEm: '2026-10-26T00:00:00Z',
    tentativas: [{ fencingToken: 1, desfecho: 'desconhecido', motivo: 'timeout', iniciadaEm: 'x', concluidaEm: 'y' }],
    ...overrides,
  };
}

const lista = (eventos: EventoDaOutbox[]) => jsonResponse({ success: true, versao: 1, eventos });

describe('EnviosComAtencao', () => {
  it('desconhecido sem prova: mostra o motivo e as tentativas, e não oferece reenvio', async () => {
    const fetchWithAuth = vi.fn(async () => lista([evento()]));
    render(<EnviosComAtencao fetchWithAuth={fetchWithAuth} selecao={ORG} podeGerir />);

    expect(await screen.findByText(/Não reenvie/)).toBeInTheDocument();
    expect(screen.getByText('DESCONHECIDO')).toBeInTheDocument();
    expect(screen.getByText('#1 desconhecida (timeout)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Autorizar reenvio/ })).not.toBeInTheDocument();
  });

  it('provado não aplicado: quem gere autoriza o replay pela rota, e a lista é relida', async () => {
    const elegivel = evento({ resolucao: 'provado_nao_aplicado', podeRepetir: true, explicacao: 'A não aplicação foi comprovada.' });
    const fetchWithAuth = vi.fn(async (url: string) => (url.endsWith('/api/integracoes/outbox') ? lista([elegivel]) : jsonResponse({ success: true, status: 'pending' })));
    render(<EnviosComAtencao fetchWithAuth={fetchWithAuth} selecao={ORG} podeGerir />);

    await userEvent.click(await screen.findByRole('button', { name: /Autorizar reenvio/ }));

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(
      `/api/integracoes/outbox/${elegivel.id}`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ acao: 'replay' }) }),
    ));
    await waitFor(() => expect(fetchWithAuth.mock.calls.filter(([u]) => u === '/api/integracoes/outbox')).toHaveLength(2));
  });

  it('quem não gere não vê o botão, mesmo elegível', async () => {
    const fetchWithAuth = vi.fn(async () => lista([evento({ podeRepetir: true, resolucao: 'provado_nao_aplicado' })]));
    render(<EnviosComAtencao fetchWithAuth={fetchWithAuth} selecao={ORG} podeGerir={false} />);

    expect(await screen.findByText('DESCONHECIDO')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Autorizar reenvio/ })).not.toBeInTheDocument();
  });

  it('a recusa do servidor aparece com a razão', async () => {
    const fetchWithAuth = vi.fn(async (url: string) => (url.endsWith('/api/integracoes/outbox')
      ? lista([evento({ podeRepetir: true, resolucao: 'provado_nao_aplicado' })])
      : jsonResponse({ success: false, error: 'Este envio não admite a decisão.' }, 409)));
    render(<EnviosComAtencao fetchWithAuth={fetchWithAuth} selecao={ORG} podeGerir />);

    await userEvent.click(await screen.findByRole('button', { name: /Autorizar reenvio/ }));

    expect(await screen.findByText('Este envio não admite a decisão.')).toBeInTheDocument();
  });

  it('resposta fora do contrato é erro, não "nada pendente"', async () => {
    const fetchWithAuth = vi.fn(async () => jsonResponse({ success: true, eventos: 'nada' }));
    render(<EnviosComAtencao fetchWithAuth={fetchWithAuth} selecao={ORG} podeGerir />);

    expect(await screen.findByRole('alert')).toHaveTextContent('formato inesperado');
    expect(screen.queryByText(/Nenhum envio/)).not.toBeInTheDocument();
  });

  it('lista vazia é dita como tal', async () => {
    const fetchWithAuth = vi.fn(async () => lista([]));
    render(<EnviosComAtencao fetchWithAuth={fetchWithAuth} selecao={ORG} podeGerir />);

    expect(await screen.findByText(/Nenhum envio desconhecido/)).toBeInTheDocument();
  });
});
