/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { Atividade } from '@/lib/auditoria/historicoDeAtividades';
import { HistoricoDeAtividades } from './HistoricoDeAtividades';

/**
 * Rastreabilidade: quem administra abre, pela aba Integrações, o histórico de
 * quem fez o quê na organização — pessoa (com nome e papel), bot ou sistema.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const MARIA = '11111111-1111-4111-8111-111111111111';

function atividade(overrides: Partial<Atividade>): Atividade {
  return {
    id: 'a1', acao: 'catalog.product_saved', descricao: 'Produto cadastrado ou atualizado no Bling e espelhado no ORBITA.',
    recurso: 'produto', recursoId: '42', correlationId: 'corr-1', createdAt: '2026-11-24T15:30:00Z',
    autor: { tipo: 'pessoa', userId: MARIA, papel: 'admin', nome_exibicao: 'Maria Silva', origem_do_nome: 'cadastro' },
    viaAssistente: false, gravidade: 'info', ...overrides,
  };
}

const pagina = (atividades: Atividade[], total = atividades.length) => jsonResponse({ atividades, total });

async function abrir(fetchWithAuth: (url: string) => Promise<Response>) {
  render(<HistoricoDeAtividades fetchWithAuth={fetchWithAuth} podeGerir />);
  await userEvent.click(screen.getByRole('button', { name: /Histórico de atividades/ }));
  return screen.findByRole('dialog');
}

describe('HistoricoDeAtividades', () => {
  it('mostra quem fez cada ação: pessoa com nome e papel, bot, sistema e via assistente', async () => {
    const fetchWithAuth = vi.fn(async () => pagina([
      atividade({ id: '1' }),
      atividade({ id: '2', acao: 'chatwoot.send_requested', descricao: 'Resposta registrada no cockpit para envio pelo worker.', autor: { tipo: 'bot' } }),
      atividade({ id: '3', acao: 'sac.case_opened', descricao: 'Caso SAC aberto em TRIAGE pelo consumidor da inbox.', autor: { tipo: 'sistema' } }),
      atividade({ id: '4', acao: 'catalog.assistant_product_edit', descricao: 'Edição pelo assistente.', viaAssistente: true,
        autor: { tipo: 'pessoa', userId: MARIA, papel: 'owner', nome_exibicao: 'Maria Silva', origem_do_nome: 'cadastro' } }),
    ]));
    const dialogo = await abrir(fetchWithAuth);
    const itens = await within(dialogo).findAllByRole('listitem');

    expect(within(itens[0]).getByText('Salvou um produto')).toBeInTheDocument();
    expect(within(itens[0]).getByText('Maria Silva')).toBeInTheDocument();
    expect(within(itens[0]).getByText('Administrador')).toBeInTheDocument();
    // O rastro técnico fica nos detalhes: descrição do catálogo e ID completo.
    expect(within(itens[0]).getByText(/Produto cadastrado/)).toBeInTheDocument();
    expect(within(itens[0]).getByText(MARIA)).toBeInTheDocument();
    expect(within(itens[1]).getByText('Respondeu um cliente pelo WhatsApp')).toBeInTheDocument();
    expect(within(itens[1]).getByText('Bot de atendimento (IA)')).toBeInTheDocument();
    expect(within(itens[2]).getByText('Sistema automático')).toBeInTheDocument();
    expect(within(itens[3]).getByText(/^via assistente$/i)).toBeInTheDocument();
    expect(within(dialogo).getByText('Mostrando 4 de 4 registros')).toBeInTheDocument();
    expect(fetchWithAuth).toHaveBeenCalledWith('/api/auditoria?limit=20&offset=0', expect.anything());
  });

  it('quem saiu da organização continua identificado', async () => {
    const fetchWithAuth = vi.fn(async () => pagina([
      atividade({ autor: { tipo: 'pessoa', userId: MARIA, papel: null, nome_exibicao: null, origem_do_nome: 'ausente' } }),
    ]));
    const dialogo = await abrir(fetchWithAuth);

    expect(await within(dialogo).findByText('Sem nome cadastrado')).toBeInTheDocument();
    expect(within(dialogo).getByText('Não é mais membro')).toBeInTheDocument();
  });

  it('destaca a ação que pede conferência', async () => {
    const fetchWithAuth = vi.fn(async () => pagina([atividade({ acao: 'order.manual_sale_unresolved', gravidade: 'critical' })]));
    const dialogo = await abrir(fetchWithAuth);

    expect(await within(dialogo).findByText(/^Precisa de conferência$/i)).toBeInTheDocument();
  });

  it('filtro sem resultado explica o vazio', async () => {
    const fetchWithAuth = vi.fn(async (url: string) => pagina(url.includes('origem=bot') ? [] : [atividade({})]));
    const dialogo = await abrir(fetchWithAuth);
    await within(dialogo).findAllByRole('listitem');

    await userEvent.click(within(dialogo).getByRole('tab', { name: 'Bot' }));

    expect(await within(dialogo).findByText('O bot de atendimento ainda não respondeu ninguém.')).toBeInTheDocument();
  });

  it('filtra pelo tipo de autor', async () => {
    const fetchWithAuth = vi.fn(async () => pagina([atividade({})]));
    const dialogo = await abrir(fetchWithAuth);
    await within(dialogo).findAllByRole('listitem');

    await userEvent.click(within(dialogo).getByRole('tab', { name: 'Bot' }));

    expect(fetchWithAuth).toHaveBeenLastCalledWith('/api/auditoria?limit=20&offset=0&origem=bot', expect.anything());
    expect(within(dialogo).getByRole('tab', { name: 'Bot' })).toHaveAttribute('aria-selected', 'true');
  });

  it('carrega a próxima página e junta à lista', async () => {
    const fetchWithAuth = vi.fn(async (url: string) => (url.includes('offset=0')
      ? pagina([atividade({ id: '1' })], 2)
      : pagina([atividade({ id: '2', descricao: 'Segunda página' })], 2)));
    const dialogo = await abrir(fetchWithAuth);
    await within(dialogo).findAllByRole('listitem');

    await userEvent.click(within(dialogo).getByRole('button', { name: /Carregar mais/ }));

    expect(await within(dialogo).findByText('Segunda página')).toBeInTheDocument();
    expect(within(dialogo).getAllByRole('listitem')).toHaveLength(2);
    expect(fetchWithAuth).toHaveBeenLastCalledWith('/api/auditoria?limit=20&offset=1', expect.anything());
    expect(within(dialogo).queryByRole('button', { name: /Carregar mais/ })).not.toBeInTheDocument();
  });

  it('falha do servidor aparece com o status, sem lista inventada', async () => {
    const fetchWithAuth = vi.fn(async () => jsonResponse({ error: 'Acesso restrito a administradores' }, 403));
    const dialogo = await abrir(fetchWithAuth);

    expect(await within(dialogo).findByRole('alert')).toHaveTextContent('HTTP 403');
    expect(within(dialogo).queryAllByRole('listitem')).toHaveLength(0);
  });

  it('quem não administra vê o botão desabilitado', () => {
    render(<HistoricoDeAtividades fetchWithAuth={vi.fn()} podeGerir={false} />);
    expect(screen.getByRole('button', { name: /Histórico de atividades/ })).toBeDisabled();
  });
});
