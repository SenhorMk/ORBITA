/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { PedidoEnriquecido } from '@/repositories/pedidoRepository';
import { VendasEPedidos } from './VendasEPedidos';
import { registrarTentativaPendente } from '@/components/tentativaPendente';

/**
 * O comportamento de Vendas & Pedidos.
 *
 * Os testes afirmam o que a pessoa vê e o que o sistema chama. Nenhum deles
 * olha classe de Tailwind: a fatia inteira **é** trocar classes, e um teste que
 * quebrasse com isso não protegeria nada.
 */

const ORG = '10000000-0000-4000-8000-00000000000a';

vi.mock('@/lib/fetchWithAuth', () => ({
  fetchWithAuth: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
}));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));

const NOTA = { bling_id: 'nf-1', numero: '1', chave: '', status: 'Emitida', pedido_id: 'p' };

function pedido(parcial: Partial<PedidoEnriquecido> & { numero: string }): PedidoEnriquecido {
  return {
    id: `id-${parcial.numero}`,
    bling_id: `bling-${parcial.numero}`,
    data: '2026-09-01T12:00:00.000Z',
    total: 100,
    status: 'Pendente',
    cliente_id: 'cli-1',
    ...parcial,
  } as PedidoEnriquecido;
}

const PEDIDOS = [
  pedido({ numero: '20', total: 40, status: 'Entregue', origem: 'Loja Física / Manual',
    cliente: { bling_id: 'c1', nome: 'Mateus Kahuan', cpf_cnpj: '116.446.734-44' } as PedidoEnriquecido['cliente'] }),
  pedido({ numero: '19', total: 60, status: 'Entregue', nfe: NOTA, origem: 'Bling',
    cliente: { bling_id: 'c2', nome: 'Marina Cavalcanti', cpf_cnpj: '421.908.112-07' } as PedidoEnriquecido['cliente'] }),
  pedido({ numero: '18', total: 25, status: 'Cancelado', origem: 'Bling',
    cliente: { bling_id: 'c3', nome: 'Rafael Nogueira' } as PedidoEnriquecido['cliente'] }),
];

function montar(props: Partial<Parameters<typeof VendasEPedidos>[0]> = {}) {
  const onBuscaChange = vi.fn();
  const utilitarios = render(
    <VendasEPedidos
      pedidos={PEDIDOS}
      carregando={false}
      erroDeLeitura={null}
      onRecarregar={vi.fn()}
      organizacaoId={ORG}
      ultimaSincronizacao={null}
      busca=""
      onBuscaChange={onBuscaChange}
      onAbrirVendaManual={vi.fn()}
      {...props}
    />,
  );
  return { ...utilitarios, onBuscaChange };
}

/** O chip como botão, pelo rótulo. */
function chip(rotulo: string | RegExp) {
  return screen.getByRole('button', { name: new RegExp(rotulo, 'i') });
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe('chips de resumo na tela', () => {
  it('mostra contagem e soma, e clicar filtra a tabela; clicar de novo limpa', async () => {
    montar();

    // "A emitir NF-e": #20 (ativo sem nota) e #18 está cancelado, fora da fila.
    const filaDeNfe = chip('A emitir NF-e');
    expect(within(filaDeNfe).getByText('1')).toBeInTheDocument();
    expect(within(filaDeNfe).getByText(/R\$\s*40,00/)).toBeInTheDocument();

    expect(screen.getByText('#19')).toBeInTheDocument();

    await userEvent.click(filaDeNfe);
    expect(screen.getByText('#20')).toBeInTheDocument();
    expect(screen.queryByText('#19')).not.toBeInTheDocument();

    await userEvent.click(chip('A emitir NF-e'));
    expect(screen.getByText('#19')).toBeInTheDocument();
  });

  it('mantém os totais dos chips estáveis quando a busca muda', async () => {
    const { rerender } = montar();
    const antes = within(chip('Entregue')).getByText('2');
    expect(antes).toBeInTheDocument();

    rerender(
      <VendasEPedidos
        pedidos={PEDIDOS}
        carregando={false}
        erroDeLeitura={null}
        onRecarregar={vi.fn()}
        organizacaoId={ORG}
        ultimaSincronizacao={null}
        busca="Marina"
        onBuscaChange={vi.fn()}
        onAbrirVendaManual={vi.fn()}
      />,
    );

    // A tabela filtrou…
    expect(screen.queryByText('#20')).not.toBeInTheDocument();
    // …e o chip continua respondendo sobre a operação, não sobre a busca.
    expect(within(chip('Entregue')).getByText('2')).toBeInTheDocument();
  });
});

describe('histórico', () => {
  it('mantém o pedido cancelado na lista, com o status visível', () => {
    montar();

    expect(screen.getByText('#18')).toBeInTheDocument();
    expect(screen.getByText('CANCELADO')).toBeInTheDocument();
  });

  it('desabilita as ações incompatíveis de um pedido cancelado', async () => {
    montar({ onEmitirNfe: vi.fn(), onConversarNoWhatsapp: vi.fn() });

    await userEvent.click(screen.getByRole('button', { name: /Ações do pedido 18/i }));

    expect(screen.getByText('Emitir nota fiscal').closest('button')).toBeDisabled();
    expect(screen.getByText('Cancelar pedido').closest('button')).toBeDisabled();
  });
});

describe('busca', () => {
  it('casa número, nome e CPF/CNPJ com e sem pontuação', () => {
    const casos: Array<[string, string]> = [
      ['20', '#20'],
      ['Marina', '#19'],
      ['421.908.112-07', '#19'],
      ['42190811207', '#19'],
    ];

    for (const [texto, esperado] of casos) {
      const { unmount } = montar({ busca: texto });
      expect(screen.getByText(esperado)).toBeInTheDocument();
      unmount();
    }
  });
});

describe('estados de leitura', () => {
  it('primeira carga em andamento mostra carregando, e não uma lista vazia', () => {
    montar({ pedidos: null, carregando: true });

    expect(screen.getByText(/Carregando pedidos/i)).toBeInTheDocument();
    expect(screen.queryByText(/Nenhum pedido/i)).not.toBeInTheDocument();
  });

  it('falha na primeira carga mostra erro — nunca lista vazia nem R$ 0,00', () => {
    montar({ pedidos: null, carregando: false, erroDeLeitura: 'Sua sessão expirou.' });

    expect(screen.getByRole('alert')).toHaveTextContent(/Não foi possível carregar os pedidos/i);
    expect(screen.queryByText(/Nenhum pedido/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/R\$\s*0,00/)).not.toBeInTheDocument();
  });

  it('leitura válida e sem pedidos mostra o estado vazio, que é outra coisa', () => {
    montar({ pedidos: [] });

    expect(screen.getByText(/Nenhum pedido neste período/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('falha ao ATUALIZAR preserva a última leitura boa e avisa', () => {
    montar({ erroDeLeitura: 'Falha de rede' });

    expect(screen.getByRole('alert')).toHaveTextContent(/última leitura que deu certo/i);
    expect(screen.getByText('#20')).toBeInTheDocument();
  });

  it('sem sincronização registrada, diz isso em vez de inventar um horário', () => {
    montar({ ultimaSincronizacao: null });

    expect(screen.getByText(/sem sincronização registrada nesta sessão/i)).toBeInTheDocument();
  });
});

describe('pendências de venda manual', () => {
  it('aparecem na tela de Vendas, sem abrir o modal de venda manual', async () => {
    registrarTentativaPendente(ORG, { referencia: 'ref-abc', fingerprint: 'fp-1' });

    montar();

    await waitFor(() => expect(screen.getByText('ref-abc')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Conferir no Bling/i })).toBeInTheDocument();
    // O modal de venda manual não foi aberto para isso aparecer.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('o chip "Conflito Bling" conta a pendência e não some com a tabela ao ser clicado', async () => {
    registrarTentativaPendente(ORG, { referencia: 'ref-abc', fingerprint: 'fp-1' });

    montar();

    const conflito = chip('Conflito Bling');
    expect(within(conflito).getByText('1')).toBeInTheDocument();
    // Sem soma: o contrato da tentativa não guarda valor.
    expect(within(conflito).queryByText(/R\$/)).not.toBeInTheDocument();

    await userEvent.click(conflito);

    // A tabela continua inteira: "Conflito Bling" não é status de pedido.
    expect(screen.getByText('#20')).toBeInTheDocument();
    expect(screen.getByText('#19')).toBeInTheDocument();
    expect(screen.getByText('#18')).toBeInTheDocument();
  });
});
