/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PainelDoCliente } from './PainelDoCliente';

const CONVERSA_A = 'c0000000-0000-4000-8000-000000000001';
const CONVERSA_B = 'c0000000-0000-4000-8000-000000000002';
const ANA = '55555555-5555-4555-8555-555555555551';
const BIA = '55555555-5555-4555-8555-555555555552';
const PEDIDO = '88888888-8888-4888-8888-888888888888';

function respostaJson(corpo: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => corpo } as Response;
}

const semProva = (candidatos: Array<{ clienteId: string; nome: string; documentoFinal: string | null }>) => ({
  success: true, versao: 1,
  verificacao: { estado: 'sem_prova', cliente: null, verificadoEm: null, expiraEm: null, totalDeCandidatos: candidatos.length, consultaPorNumeroBloqueada: false },
  candidatos,
});
const verificada = {
  success: true, versao: 1,
  verificacao: {
    estado: 'verificado', cliente: { id: ANA, nome: 'Ana Sintética' }, verificadoEm: '2026-11-10T10:00:00+00:00',
    expiraEm: '2026-11-11T10:00:00+00:00', totalDeCandidatos: 1, consultaPorNumeroBloqueada: false,
  },
  candidatos: [{ clienteId: ANA, nome: 'Ana Sintética', documentoFinal: '09' }],
};
const pedidos = { success: true, versao: 1, pedidos: [{ id: PEDIDO, numero: '1001', data: '2026-11-08T10:00:00+00:00', status: 'Pendente', total: 10 }] };

/** Servidor dublado: `verificacao` é lida a cada GET, para o teste mudar o estado depois de um comando. */
function servidor(opcoes: {
  verificacao: () => unknown;
  pedidos?: () => Response;
  alterar?: (corpo: Record<string, unknown>) => Response;
  localizar?: (corpo: Record<string, unknown>) => Response;
}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const corpo = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.startsWith('/api/sac/verificacao')) {
      return init?.method === 'POST' ? (opcoes.alterar?.(corpo) ?? respostaJson({ success: true })) : respostaJson(opcoes.verificacao());
    }
    if (url.startsWith('/api/sac/pedidos')) {
      if (init?.method === 'POST') return opcoes.localizar?.(corpo) ?? respostaJson(pedidos);
      return opcoes.pedidos?.() ?? respostaJson(pedidos);
    }
    throw new Error(`URL inesperada: ${url}`);
  });
}

const chamadasA = (fetchWithAuth: ReturnType<typeof servidor>, prefixo: string, metodo?: string) =>
  fetchWithAuth.mock.calls.filter(([url, init]) => url.startsWith(prefixo) && (init?.method ?? 'GET') === (metodo ?? 'GET'));

describe('PainelDoCliente — antes da confirmação', () => {
  it('telefone igual aparece como candidato, não como cliente; nenhum pedido é pedido ao servidor', async () => {
    const fetchWithAuth = servidor({ verificacao: () => semProva([{ clienteId: ANA, nome: 'Ana Sintética', documentoFinal: '09' }]) });
    render(<PainelDoCliente fetchWithAuth={fetchWithAuth} conversaId={CONVERSA_A} />);

    expect(await screen.findByLabelText('Cliente da conversa')).toHaveTextContent('Não confirmado');
    expect(screen.getByText('Ana Sintética')).toBeInTheDocument();
    expect(screen.getByText(/documento final 09/u)).toBeInTheDocument();
    expect(screen.getByText(/Telefone igual não confirma/u)).toBeInTheDocument();
    expect(chamadasA(fetchWithAuth, '/api/sac/pedidos')).toHaveLength(0);
    expect(screen.queryByLabelText('Número do pedido')).not.toBeInTheDocument();
  });

  it('dois clientes com o mesmo telefone: avisa e deixa a escolha para o atendente', async () => {
    const fetchWithAuth = servidor({
      verificacao: () => semProva([{ clienteId: ANA, nome: 'Ana Sintética', documentoFinal: '09' }, { clienteId: BIA, nome: 'Bia Sintética', documentoFinal: null }]),
    });
    render(<PainelDoCliente fetchWithAuth={fetchWithAuth} conversaId={CONVERSA_A} />);

    expect(await screen.findByText(/Mais de um cliente usa este telefone/u)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Confirmar/u })).toHaveLength(2);
  });

  it('sem candidato: diz que não há e não oferece confirmação', async () => {
    const fetchWithAuth = servidor({ verificacao: () => semProva([]) });
    render(<PainelDoCliente fetchWithAuth={fetchWithAuth} conversaId={CONVERSA_A} />);

    expect(await screen.findByText(/Nenhum cliente cadastrado com o telefone/u)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Confirmar/u })).not.toBeInTheDocument();
  });

  it('falha de leitura ou resposta fora do contrato: erro, sem candidato e sem pedido', async () => {
    for (const verificacao of [() => ({ success: true, versao: 1, verificacao: { estado: 'liberado' }, candidatos: [] }), () => { throw new Error('rede'); }]) {
      const fetchWithAuth = servidor({ verificacao });
      const { unmount } = render(<PainelDoCliente fetchWithAuth={fetchWithAuth} conversaId={CONVERSA_A} />);

      expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível ler a verificação do cliente.');
      expect(screen.queryByRole('button', { name: /Confirmar/u })).not.toBeInTheDocument();
      expect(chamadasA(fetchWithAuth, '/api/sac/pedidos')).toHaveLength(0);
      unmount();
    }
  });
});

describe('PainelDoCliente — confirmar, consultar e desfazer', () => {
  it('confirmar manda conversa, cliente e um comando novo; depois lê o estado e os pedidos do servidor', async () => {
    let estado: unknown = semProva([{ clienteId: ANA, nome: 'Ana Sintética', documentoFinal: '09' }]);
    const fetchWithAuth = servidor({
      verificacao: () => estado,
      alterar: () => {
        estado = verificada;
        return respostaJson({ success: true, duplicado: false, expiraEm: '2026-11-11T10:00:00+00:00' });
      },
    });
    render(<PainelDoCliente fetchWithAuth={fetchWithAuth} conversaId={CONVERSA_A} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Confirmar Ana Sintética' }));

    await waitFor(() => expect(screen.getByLabelText('Cliente da conversa')).toHaveTextContent('Ana Sintética'));
    const [[, init]] = chamadasA(fetchWithAuth, '/api/sac/verificacao', 'POST');
    expect(JSON.parse(String(init!.body))).toEqual({
      acao: 'confirmar', conversaId: CONVERSA_A, clienteId: ANA, commandId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
    expect(await screen.findByText('Pedido 1001')).toBeInTheDocument();
    expect(screen.getByText(/Pendente/u)).toBeInTheDocument();
  });

  it('confirmação recusada: mostra o motivo do servidor e continua sem cliente', async () => {
    const fetchWithAuth = servidor({
      verificacao: () => semProva([{ clienteId: ANA, nome: 'Ana Sintética', documentoFinal: '09' }]),
      alterar: () => respostaJson({ success: false, error: 'Cliente não encontrado', motivo: 'cliente_nao_encontrado' }, 404),
    });
    render(<PainelDoCliente fetchWithAuth={fetchWithAuth} conversaId={CONVERSA_A} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Confirmar Ana Sintética' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Cliente não encontrado');
    expect(screen.getByLabelText('Cliente da conversa')).toHaveTextContent('Não confirmado');
    expect(chamadasA(fetchWithAuth, '/api/sac/pedidos')).toHaveLength(0);
  });

  it('busca por número: o corpo leva o número; não encontrado e bloqueio aparecem como texto, sem pedido', async () => {
    let resposta = respostaJson({ success: false, error: 'Nenhum pedido deste cliente com esse número.', motivo: 'nao_encontrado' }, 404);
    const fetchWithAuth = servidor({ verificacao: () => verificada, localizar: () => resposta });
    render(<PainelDoCliente fetchWithAuth={fetchWithAuth} conversaId={CONVERSA_A} />);

    await userEvent.type(await screen.findByLabelText('Número do pedido'), '2001');
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }));

    expect(await screen.findByText('Nenhum pedido deste cliente com esse número.')).toBeInTheDocument();
    const [[url, init]] = chamadasA(fetchWithAuth, '/api/sac/pedidos', 'POST');
    expect(url).toBe('/api/sac/pedidos');
    expect(JSON.parse(String(init!.body))).toEqual({ conversaId: CONVERSA_A, numero: '2001' });

    resposta = respostaJson({ success: false, error: 'Muitas tentativas sem resultado. A consulta por número volta em alguns minutos.', motivo: 'bloqueada' }, 429);
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    expect(await screen.findByText(/Muitas tentativas sem resultado/u)).toBeInTheDocument();
  });

  it('prova que venceu entre a leitura e a consulta: os pedidos somem e o estado é relido', async () => {
    let estado: unknown = verificada;
    const fetchWithAuth = servidor({
      verificacao: () => estado,
      pedidos: () => {
        estado = { ...semProva([]), verificacao: { ...semProva([]).verificacao, estado: 'expirada' } };
        return respostaJson({ success: false, error: 'Confirme o cliente da conversa antes de consultar pedidos.', motivo: 'sem_prova' }, 409);
      },
    });
    render(<PainelDoCliente fetchWithAuth={fetchWithAuth} conversaId={CONVERSA_A} />);

    await waitFor(() => expect(screen.getByLabelText('Cliente da conversa')).toHaveTextContent('Confirmação vencida'));
    expect(screen.queryByText('Pedido 1001')).not.toBeInTheDocument();
  });

  it('desfazer: pede a revogação e volta a não confirmado, sem pedidos na tela', async () => {
    let estado: unknown = verificada;
    const fetchWithAuth = servidor({
      verificacao: () => estado,
      alterar: (corpo) => {
        expect(corpo).toEqual({ acao: 'revogar', conversaId: CONVERSA_A });
        estado = semProva([{ clienteId: ANA, nome: 'Ana Sintética', documentoFinal: '09' }]);
        return respostaJson({ success: true, revogada: true });
      },
    });
    render(<PainelDoCliente fetchWithAuth={fetchWithAuth} conversaId={CONVERSA_A} />);

    expect(await screen.findByText('Pedido 1001')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Desfazer confirmação' }));

    await waitFor(() => expect(screen.getByLabelText('Cliente da conversa')).toHaveTextContent('Não confirmado'));
    expect(screen.queryByText('Pedido 1001')).not.toBeInTheDocument();
  });
});

describe('PainelDoCliente — troca de conversa', () => {
  it('a resposta atrasada da conversa anterior não aparece na nova', async () => {
    const soltar: Array<() => void> = [];
    const fetchWithAuth = vi.fn((url: string) => new Promise<Response>((resolver) => {
      const daA = url.includes(CONVERSA_A);
      soltar.push(() => resolver(respostaJson(url.startsWith('/api/sac/pedidos') ? pedidos : daA ? verificada : semProva([]))));
    }));
    const { rerender } = render(<PainelDoCliente fetchWithAuth={fetchWithAuth} conversaId={CONVERSA_A} />);
    rerender(<PainelDoCliente fetchWithAuth={fetchWithAuth} conversaId={CONVERSA_B} />);

    await act(async () => {
      soltar.forEach((s) => s());
    });

    await waitFor(() => expect(screen.getByLabelText('Cliente da conversa')).toHaveTextContent('Não confirmado'));
    expect(screen.queryByText('Ana Sintética')).not.toBeInTheDocument();
    expect(fetchWithAuth.mock.calls.some(([url]) => url.startsWith('/api/sac/pedidos'))).toBe(false);
  });
});

describe('PainelDoCliente — detalhes do pedido (MSG-011)', () => {
  const atual = { situacao: 'atual', sincronizadoEm: '2026-11-12T11:00:00+00:00', motivo: null };
  const retrato = {
    success: true, versao: 1,
    retrato: {
      pedido: { id: PEDIDO, numero: '1001', data: '2026-11-08T10:00:00+00:00', status: 'Pendente', total: 10, frete: null, desconto: null, formaDePagamento: null },
      itens: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', produtoId: null, nome: 'Item Sintético', codigo: null, quantidade: 1, valorUnitario: 10,
        estoque: { situacao: 'desconhecido', disponivel: null } }],
      totalDeItens: 1, itensOmitidos: 0,
      pagamento: { situacao: 'desconhecido', vencido: false, valor: null, vencimento: null, pagoEm: null },
      rastreio: { situacao: 'desconhecido', motivo: 'sem_fonte' },
      frescor: { pedido: atual, estoque: atual, pagamento: atual },
    },
  };

  it('Detalhes abre o retrato do pedido da conversa; trocar de conversa fecha', async () => {
    const fetchWithAuth = vi.fn(async (url: string) => {
      if (url.startsWith('/api/sac/pedidos/retrato')) return respostaJson(retrato);
      if (url.startsWith('/api/sac/pedidos')) return respostaJson(pedidos);
      return respostaJson(url.includes(CONVERSA_A) ? verificada : semProva([]));
    });
    const { rerender } = render(<PainelDoCliente fetchWithAuth={fetchWithAuth} conversaId={CONVERSA_A} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Detalhes do pedido 1001' }));
    expect(await screen.findByText('Item Sintético')).toBeInTheDocument();
    expect(fetchWithAuth).toHaveBeenCalledWith(`/api/sac/pedidos/retrato?conversaId=${CONVERSA_A}&pedidoId=${PEDIDO}`);

    rerender(<PainelDoCliente fetchWithAuth={fetchWithAuth} conversaId={CONVERSA_B} />);
    await waitFor(() => expect(screen.queryByText('Item Sintético')).not.toBeInTheDocument());
  });
});
