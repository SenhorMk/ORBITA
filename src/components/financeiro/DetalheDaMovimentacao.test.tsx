/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import type { PedidoEnriquecido } from '@/repositories/pedidoRepository';
import { fetchWithAuth } from '@/lib/fetchWithAuth';
import { DetalhesDaMovimentacao } from './DetalheDaMovimentacao';
import type { TituloFinanceiro } from './useLeituraFinanceira';

/**
 * De onde a movimentação veio decide o detalhe que ela abre.
 *
 * A decisão é pelo vínculo estrutural `pedido_id` (migration 61), exposto pelo
 * join de `GET /api/financeiro` — **nunca** pelo texto da descrição, que foi
 * exatamente o que aquela migration existiu para substituir. Entrada vinculada
 * a pedido abre o drawer de Vendas & Pedidos, o mesmo componente; despesa abre
 * o detalhe da movimentação, com os campos que de fato existem.
 */

vi.mock('@/lib/fetchWithAuth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));

function resposta(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const PEDIDO_LOCAL = {
  id: 'pedido-a',
  bling_id: 'bling-777',
  numero: '777',
  data: '2026-09-01T12:00:00.000Z',
  total: 40,
  status: 'Entregue',
  cliente_id: 'cli-1',
  cliente: { bling_id: 'c1', nome: 'Mateus Kahuan', cpf_cnpj: '116.446.734-44' },
} as unknown as PedidoEnriquecido;

const ENTRADA_DE_PEDIDO: TituloFinanceiro = {
  id: 't-1',
  bling_id: 0,
  tipo: 'receber',
  situacao: 'pago',
  valor: 40,
  data_vencimento: '2026-09-01',
  descricao: 'Venda manual 26801269702',
  pedido_id: 'pedido-a',
};

const DESPESA: TituloFinanceiro = {
  id: 't-2',
  bling_id: 88123,
  tipo: 'pagar',
  situacao: 'aberto',
  valor: 120.5,
  data_vencimento: '2026-09-30',
  titulo: 'Insumos',
  descricao: '1kg de rapé para revenda',
  categoria: { descricao: 'Mercadorias' },
  fornecedor_bling_id: 4242,
  fornecedor_nome: 'Fornecedor Exemplo LTDA',
};

const formatarDinheiro = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

function montar(titulo: TituloFinanceiro | null, pedidoLocal: PedidoEnriquecido | null = null) {
  return render(
    <DetalhesDaMovimentacao
      titulo={titulo}
      pedidoLocal={pedidoLocal}
      onFechar={vi.fn()}
      formatarDinheiro={formatarDinheiro}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('entrada vinculada a um pedido', () => {
  it('abre o detalhe DAQUELE pedido, pelo id do vínculo e não pela descrição', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(resposta({ error: 'not found' }, 404));

    montar(ENTRADA_DE_PEDIDO, PEDIDO_LOCAL);

    // O id consultado é o `bling_id` que veio do JOIN com `pedidos`, e não
    // nada extraído do texto "Venda manual 26801269702" da descrição.
    await waitFor(() => {
      expect(vi.mocked(fetchWithAuth)).toHaveBeenCalledWith(
        '/api/bling/pedidos/bling-777',
        expect.anything(),
      );
    });
    expect(await screen.findByText(/Pedido #777/)).toBeInTheDocument();
  });

  it('do Financeiro o pedido é LEITURA: nenhuma ação que escreve no ERP fica disponível', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(resposta({ error: 'not found' }, 404));

    montar(ENTRADA_DE_PEDIDO, PEDIDO_LOCAL);

    // Os dados aparecem…
    expect(await screen.findByText('Mateus Kahuan')).toBeInTheDocument();
    // …e as três mutações do pedido, não. `Editar` é interna ao drawer e
    // continuava disponível mesmo sem os callbacks — era uma escrita no ERP a
    // partir de uma tela que não a oferece.
    expect(screen.queryByRole('button', { name: /Editar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cancelar pedido/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Emitir NF-e/i })).not.toBeInTheDocument();
  });

  it('uma entrada sem pedido vinculado diz isso, em vez de deixar a ausência passar', () => {
    montar({ ...ENTRADA_DE_PEDIDO, pedido_id: null }, null);

    expect(screen.getByText('Pedido de origem')).toBeInTheDocument();
    expect(screen.getByText(/não vinculado/i)).toBeInTheDocument();
  });

  it('sem o pedido na leitura corrente, abre o detalhe da movimentação em vez de um drawer vazio', async () => {
    montar(ENTRADA_DE_PEDIDO, null);

    expect(screen.getByRole('heading', { name: 'Venda manual 26801269702' })).toBeInTheDocument();
    expect(vi.mocked(fetchWithAuth)).not.toHaveBeenCalled();
  });

  it('é o drawer de Vendas & Pedidos que abre — não um segundo detalhe de movimentação', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(resposta({ error: 'not found' }, 404));

    montar(ENTRADA_DE_PEDIDO, PEDIDO_LOCAL);

    // O snapshot local do pedido é o que aparece, com o cliente — informação
    // que só o detalhe de pedido tem.
    expect(await screen.findByText('Mateus Kahuan')).toBeInTheDocument();
    expect(screen.queryByText('Fornecedor')).not.toBeInTheDocument();
  });
});

describe('detalhe de uma despesa', () => {
  it('mostra título e descrição como campos distintos', () => {
    montar(DESPESA);

    expect(screen.getByRole('heading', { name: 'Insumos' })).toBeInTheDocument();
    expect(screen.getByText('Descrição')).toBeInTheDocument();
    expect(screen.getByText('1kg de rapé para revenda')).toBeInTheDocument();
  });

  it('mostra categoria, situação, vencimento, valor, fornecedor e origem', () => {
    montar(DESPESA);

    expect(screen.getByText('Mercadorias')).toBeInTheDocument();
    expect(screen.getByText('ABERTO')).toBeInTheDocument();
    expect(screen.getByText('30/09/2026')).toBeInTheDocument();
    expect(screen.getAllByText(/120,50/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Fornecedor Exemplo LTDA/)).toBeInTheDocument();
    expect(screen.getByText(/contato 4242/)).toBeInTheDocument();
    expect(screen.getByText(/Bling · 88123/)).toBeInTheDocument();
  });

  it('num registro anterior à migration 62 exibe a descrição como título e não finge um segundo campo', () => {
    const antigo: TituloFinanceiro = {
      ...DESPESA,
      titulo: null,
      fornecedor_bling_id: null,
      fornecedor_nome: null,
      bling_id: 0,
    };
    montar(antigo);

    expect(screen.getByRole('heading', { name: '1kg de rapé para revenda' })).toBeInTheDocument();
    // Sem `titulo` próprio, o campo Descrição não aparece repetindo a mesma
    // frase como se fossem dois dados.
    expect(screen.queryByText('Descrição')).not.toBeInTheDocument();
    // E o fornecedor não é inventado: a despesa antiga não registrou nenhum.
    expect(screen.getByText(/Não registrado nesta movimentação/)).toBeInTheDocument();
    expect(screen.getByText('Interno (Orbita)')).toBeInTheDocument();
  });

  it('um título terminal diz que está fora dos totais, e continua legível', () => {
    montar({ ...DESPESA, situacao: 'cancelado' });

    expect(screen.getByText('CANCELADO')).toBeInTheDocument();
    expect(screen.getByText(/não entra/)).toBeInTheDocument();
    expect(screen.getAllByText(/120,50/).length).toBeGreaterThan(0);
  });
});
