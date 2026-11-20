/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { CasoSac, EventoRecebido } from '@/lib/integrations/contratoDaMensageria';
import { MensagensRecebidas } from './MensagensRecebidas';

/** MSG-006: o operador vê recebida/processada e o desfecho, sem acionar nada. */

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const ORG = { id: 'org-a', versao: 1 };

function evento(overrides: Partial<EventoRecebido> = {}): EventoRecebido {
  return {
    id: '11111111-1111-4111-8111-111111111111', tipo: 'message_created', estado: 'processada', disposicao: 'caso_aberto',
    motivo: null, tentativas: 1, casoId: '33333333-3333-4333-8333-333333333333', recebidaEm: 'x', processadaEm: 'y',
    ...overrides,
  };
}

const CASO: CasoSac = {
  id: '33333333-3333-4333-8333-333333333333', fase: 'TRIAGE', versao: 1,
  conversaIdLocal: '44444444-4444-4444-8444-444444444444', abertoEm: 'x', ultimaMensagemEm: 'y',
};

const resposta = (eventos: EventoRecebido[], casos: CasoSac[] = []) => jsonResponse({ success: true, versao: 1, eventos, casos });

describe('MensagensRecebidas', () => {
  it('processada: mostra o estado e o caso aberto', async () => {
    const fetchWithAuth = vi.fn(async () => resposta([evento()], [CASO]));
    render(<MensagensRecebidas fetchWithAuth={fetchWithAuth} selecao={ORG} />);

    expect(await screen.findByText('Caso aberto em triagem.')).toBeInTheDocument();
    expect(screen.getByText('PROCESSADA')).toBeInTheDocument();
    expect(screen.getByText('1 caso recente.')).toBeInTheDocument();
  });

  it('recebida e ainda não processada aparece como recebida', async () => {
    const fetchWithAuth = vi.fn(async () => resposta([evento({ estado: 'recebida', disposicao: null, casoId: null, processadaEm: null, tentativas: 0 })]));
    render(<MensagensRecebidas fetchWithAuth={fetchWithAuth} selecao={ORG} />);
    expect(await screen.findByText('RECEBIDA')).toBeInTheDocument();
  });

  it('falha definitiva mostra o código e evento desconhecido explica o ignorado', async () => {
    const fetchWithAuth = vi.fn(async () => resposta([
      evento({ id: '11111111-1111-4111-8111-111111111112', estado: 'falha_definitiva', disposicao: 'falha_definitiva', motivo: 'payload_invalido', casoId: null }),
      evento({ id: '11111111-1111-4111-8111-111111111113', estado: 'ignorada', disposicao: 'evento_desconhecido', casoId: null }),
    ]));
    render(<MensagensRecebidas fetchWithAuth={fetchWithAuth} selecao={ORG} />);

    expect(await screen.findByText('payload_invalido, tentativa 1')).toBeInTheDocument();
    expect(screen.getByText('Tipo de evento que o ORBITA não trata.')).toBeInTheDocument();
  });

  it('só leitura: ajuda e atualização não oferecem escrita, e o único pedido é GET', async () => {
    const fetchWithAuth = vi.fn(async () => resposta([evento()], [CASO]));
    render(<MensagensRecebidas fetchWithAuth={fetchWithAuth} selecao={ORG} />);
    await screen.findByText('Caso aberto em triagem.');

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Atualizar mensagens' })).toBeInTheDocument();
    expect(buttons.filter((button) => button.getAttribute('data-help-id') === 'integracoes.inbox')).toHaveLength(1);
    for (const [, opcoes] of fetchWithAuth.mock.calls as unknown as Array<[string, RequestInit | undefined]>) {
      expect(opcoes?.method ?? 'GET').toBe('GET');
    }
  });

  it('resposta fora do contrato é erro, não lista vazia', async () => {
    const fetchWithAuth = vi.fn(async () => jsonResponse({ success: true }));
    render(<MensagensRecebidas fetchWithAuth={fetchWithAuth} selecao={ORG} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('formato inesperado');
    expect(screen.queryByText('Nenhuma mensagem recebida ainda.')).not.toBeInTheDocument();
  });
});
