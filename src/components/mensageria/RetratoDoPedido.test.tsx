/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { RetratoDoPedido as Retrato } from '@/lib/integrations/contratoDoRetrato';

import { RetratoDoPedido } from './RetratoDoPedido';

const CONVERSA = 'c0000000-0000-4000-8000-000000000001';
const PEDIDO = '88888888-8888-4888-8888-888888888888';

function respostaJson(corpo: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => corpo } as Response;
}

const atual = { situacao: 'atual', sincronizadoEm: '2026-11-12T11:00:00+00:00', motivo: null } as const;
const retrato: Retrato = {
  pedido: { id: PEDIDO, numero: '1001', data: '2026-11-08T10:00:00+00:00', status: 'Enviado', total: 129.8, frete: 0, desconto: null, formaDePagamento: 'Pix' },
  itens: [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', produtoId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', nome: 'Camiseta Sintética', codigo: 'CAM-11',
      quantidade: 2, valorUnitario: 49.9, estoque: { situacao: 'disponivel', disponivel: 7 } },
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', produtoId: null, nome: 'Caneca Sintética', codigo: null,
      quantidade: 1, valorUnitario: 30, estoque: { situacao: 'desconhecido', disponivel: null } },
  ],
  totalDeItens: 2,
  itensOmitidos: 0,
  pagamento: { situacao: 'desconhecido', vencido: false, valor: null, vencimento: null, pagoEm: null },
  rastreio: { situacao: 'desconhecido', motivo: 'sem_fonte' },
  frescor: { pedido: atual, estoque: atual, pagamento: atual },
};

const servidor = (resposta: Response) => vi.fn(async () => resposta);

describe('RetratoDoPedido', () => {
  it('pede o retrato da conversa e do pedido, e mostra desconhecido como desconhecido', async () => {
    const fetchWithAuth = servidor(respostaJson({ success: true, versao: 1, retrato }));
    render(<RetratoDoPedido fetchWithAuth={fetchWithAuth} conversaId={CONVERSA} pedidoId={PEDIDO} onFechar={() => {}} />);

    expect(await screen.findByText('Camiseta Sintética')).toBeInTheDocument();
    expect(fetchWithAuth).toHaveBeenCalledWith(`/api/sac/pedidos/retrato?conversaId=${CONVERSA}&pedidoId=${PEDIDO}`);
    expect(screen.getByText(/7 disponíveis/u)).toBeInTheDocument();
    expect(screen.getByText(/Estoque desconhecido/u)).toBeInTheDocument();
    expect(screen.getByLabelText('Pagamento')).toHaveTextContent('Sem título a receber: pagamento desconhecido');
    expect(screen.getByLabelText('Rastreio')).toHaveTextContent(/desconhecido/u);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('dado velho: avisa qual parte está desatualizada e por quê', async () => {
    const velho = {
      ...retrato,
      frescor: {
        pedido: { situacao: 'desatualizado', sincronizadoEm: '2026-11-01T10:00:00+00:00', motivo: 'ultima_sincronizacao_falhou' },
        estoque: { situacao: 'desatualizado', sincronizadoEm: '2026-11-01T10:00:00+00:00', motivo: 'antiga' },
        pagamento: { situacao: 'desconhecido', sincronizadoEm: null, motivo: 'sem_sincronizacao' },
      },
    };
    render(<RetratoDoPedido fetchWithAuth={servidor(respostaJson({ success: true, versao: 1, retrato: velho }))}
      conversaId={CONVERSA} pedidoId={PEDIDO} onFechar={() => {}} />);

    const aviso = await screen.findByRole('alert');
    expect(aviso).toHaveTextContent(/Pedido: a última sincronização falhou/u);
    expect(aviso).toHaveTextContent(/Estoque: sincronizado há mais de um dia/u);
    expect(aviso).toHaveTextContent(/Pagamento: nunca sincronizado/u);
    expect(aviso).toHaveTextContent(/Confirme no Bling antes de responder/u);
  });

  it('pagamento parcial e vencido aparecem com o valor do título', async () => {
    const parcial = { ...retrato, pagamento: { situacao: 'em_aberto', vencido: true, valor: 129.8, vencimento: '2026-11-01', pagoEm: null } };
    render(<RetratoDoPedido fetchWithAuth={servidor(respostaJson({ success: true, versao: 1, retrato: parcial }))}
      conversaId={CONVERSA} pedidoId={PEDIDO} onFechar={() => {}} />);
    expect(await screen.findByLabelText('Pagamento')).toHaveTextContent(/Em aberto, vencido/u);
  });

  it('itens omitidos: diz quantos ficaram de fora', async () => {
    render(<RetratoDoPedido fetchWithAuth={servidor(respostaJson({ success: true, versao: 1, retrato: { ...retrato, totalDeItens: 73, itensOmitidos: 71 } }))}
      conversaId={CONVERSA} pedidoId={PEDIDO} onFechar={() => {}} />);
    expect(await screen.findByText(/mais 71 itens/u)).toBeInTheDocument();
  });

  it.each([
    [respostaJson({ success: false, error: 'Confirme o cliente da conversa antes de consultar pedidos.', motivo: 'sem_prova' }, 409), /Confirme o cliente/u],
    [respostaJson({ success: true, versao: 1, retrato: { ...retrato, pedido: { ...retrato.pedido, cpf: '123' } } }), /Não foi possível ler/u],
    [respostaJson({ success: false, error: 'x' }, 503), /x/u],
  ])('resposta recusada ou fora do contrato: nenhum item aparece', async (resposta, mensagem) => {
    render(<RetratoDoPedido fetchWithAuth={servidor(resposta)} conversaId={CONVERSA} pedidoId={PEDIDO} onFechar={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(mensagem);
    expect(screen.queryByText('Camiseta Sintética')).not.toBeInTheDocument();
  });


  it('prepara uma troca no cockpit e deixa a decisão bloqueada', async () => {
    const item = retrato.itens[0];
    const fetchWithAuth = vi.fn()
      .mockResolvedValueOnce(respostaJson({ success: true, versao: 1, retrato }))
      .mockResolvedValueOnce(respostaJson({
        versao: 1, casoId: CONVERSA, conversaId: CONVERSA, tipo: 'troca',
        estado: 'requer_compatibilidade', pendencias: ['ranking', 'politica'], proximaPergunta: null,
        pedido: { id: PEDIDO, numero: '1001', sincronizadoEm: atual.sincronizadoEm, fonte: 'espelho_bling',
          item: { id: item.id, nome: item.nome, quantidadeComprada: 2, precoUnitarioCentavos: 4990, moeda: 'BRL' } },
        quantidadeSolicitada: 1, motivo: 'avaria', substitutoPretendido: 'Camiseta azul',
        rastreio: 'sem_fonte', podeAprovar: false,
      }));
    const user = userEvent.setup();
    render(<RetratoDoPedido fetchWithAuth={fetchWithAuth} conversaId={CONVERSA} pedidoId={PEDIDO} onFechar={() => {}} />);

    await user.click(await screen.findByText('Preparar troca ou devolução'));
    await user.selectOptions(screen.getByLabelText('Item', { exact: true }), item.id);
    await user.type(screen.getByLabelText('Quantidade', { exact: true }), '1');
    await user.selectOptions(screen.getByLabelText('Motivo', { exact: true }), 'avaria');
    await user.type(screen.getByLabelText('Substituto desejado', { exact: true }), 'Camiseta azul');
    await user.click(screen.getByRole('button', { name: 'Conferir prévia' }));

    const previa = await screen.findByRole('region', { name: 'Prévia da proposta' });
    expect(previa).toHaveTextContent(/49,90/u);
    expect(previa).toHaveTextContent('Política de elegibilidade pendente');
    expect(screen.queryByRole('button', { name: /aprovar/u })).not.toBeInTheDocument();
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    const [, opcoes] = fetchWithAuth.mock.calls[1];
    expect(JSON.parse(opcoes.body)).toEqual({
      conversaId: CONVERSA, pedidoId: PEDIDO, itemId: item.id, tipo: 'troca', quantidade: 1,
      motivo: 'avaria', substitutoPretendido: 'Camiseta azul',
    });
  });
  it('fechar devolve o controle ao painel', async () => {
    const onFechar = vi.fn();
    render(<RetratoDoPedido fetchWithAuth={servidor(respostaJson({ success: true, versao: 1, retrato }))}
      conversaId={CONVERSA} pedidoId={PEDIDO} onFechar={onFechar} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Fechar detalhes do pedido' }));
    expect(onFechar).toHaveBeenCalledOnce();
  });
});
