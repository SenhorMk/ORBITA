/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { DesfechoDaCorrecao } from '@/lib/config/correcaoOperacionalContract';
import { DetalhesDaMovimentacao } from './DetalheDaMovimentacao';
import type { TituloFinanceiro } from './useLeituraFinanceira';

/**
 * Correção de uma saída pelo detalhe da movimentação: que ação aparece para
 * cada tipo de despesa, o texto de cada confirmação, e o que acontece com cada
 * desfecho do servidor.
 */

vi.mock('@/lib/fetchWithAuth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));

const base: TituloFinanceiro = {
  id: 't-9',
  bling_id: 0,
  tipo: 'pagar',
  situacao: 'aberto',
  valor: 80,
  data_vencimento: '2026-09-30',
  descricao: 'Lançamento de teste',
};

const INTERNA = base;
const DO_BLING = { ...base, bling_id: 88123 };
const PAGA_NO_BLING = { ...base, bling_id: 88123, situacao: 'pago' as const };

const formatarDinheiro = (v: number) => `R$ ${v}`;

function montar(titulo: TituloFinanceiro, onCorrigir = vi.fn(), onCorrigido = vi.fn()) {
  render(
    <DetalhesDaMovimentacao
      titulo={titulo}
      pedidoLocal={null}
      onFechar={() => {}}
      formatarDinheiro={formatarDinheiro}
      onCorrigir={onCorrigir}
      onCorrigido={onCorrigido}
    />,
  );
  return { onCorrigir, onCorrigido, usuario: userEvent.setup() };
}

describe('correção de lançamento no detalhe da movimentação', () => {
  it('despesa interna: "Excluir lançamento" com a confirmação de remoção definitiva', async () => {
    const onCorrigir = vi.fn(async (): Promise<DesfechoDaCorrecao> => ({ resultado: 'Deleted', removidoDoBling: false }));
    const { usuario, onCorrigido } = montar(INTERNA, onCorrigir);

    await usuario.click(screen.getByRole('button', { name: 'Excluir lançamento' }));
    const dialogo = await screen.findByRole('dialog');
    expect(dialogo).toHaveTextContent(
      'Esta despesa existe apenas no ORBITA. Ao excluir, o lançamento será removido definitivamente.',
    );

    await usuario.click(within(dialogo).getByRole('button', { name: 'Excluir lançamento' }));

    expect(onCorrigir).toHaveBeenCalledWith('excluir', 't-9');
    await waitFor(() => expect(onCorrigido).toHaveBeenCalledTimes(1));
  });

  it('despesa do Bling aberta: "Cancelar despesa" com a confirmação que fala do Bling', async () => {
    const onCorrigir = vi.fn(async (): Promise<DesfechoDaCorrecao> => ({ resultado: 'Cancelled' }));
    const { usuario, onCorrigido } = montar(DO_BLING, onCorrigir);

    await usuario.click(screen.getByRole('button', { name: 'Cancelar despesa' }));
    const dialogo = await screen.findByRole('dialog');
    expect(dialogo).toHaveTextContent('Esta despesa também existe no Bling.');
    expect(dialogo).toHaveTextContent('manterá o lançamento no histórico como cancelado');

    await usuario.click(within(dialogo).getByRole('button', { name: 'Cancelar despesa' }));

    expect(onCorrigir).toHaveBeenCalledWith('cancelar', 't-9');
    await waitFor(() => expect(onCorrigido).toHaveBeenCalledTimes(1));
  });

  it('paga no Bling: aviso, nenhuma ação — nada de estorno nem borderô', () => {
    const { onCorrigir } = montar(PAGA_NO_BLING);

    expect(screen.getByText(/já foi paga no Bling. O estorno automático ainda não está disponível/u)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cancelar despesa|Excluir lançamento|Estornar/u })).toBeNull();
    expect(onCorrigir).not.toHaveBeenCalled();
  });

  it.each(['cancelado', 'estornado'] as const)('%s: nenhuma nova ação destrutiva', (situacao) => {
    montar({ ...DO_BLING, situacao });
    expect(screen.queryByRole('button', { name: /Cancelar despesa|Excluir lançamento/u })).toBeNull();
  });

  it('entrada (a receber) não tem ação de correção', () => {
    montar({ ...INTERNA, tipo: 'receber' });
    expect(screen.queryByRole('button', { name: /Cancelar despesa|Excluir lançamento/u })).toBeNull();
  });

  it('enquanto processa: botão desabilitado e um único envio', async () => {
    let entregar!: (d: DesfechoDaCorrecao) => void;
    const onCorrigir = vi.fn(() => new Promise<DesfechoDaCorrecao>((r) => { entregar = r; }));
    const { usuario, onCorrigido } = montar(INTERNA, onCorrigir);

    await usuario.click(screen.getByRole('button', { name: 'Excluir lançamento' }));
    const dialogo = await screen.findByRole('dialog');
    await usuario.click(within(dialogo).getByRole('button', { name: 'Excluir lançamento' }));
    const processando = within(dialogo).getByRole('button', { name: /Processando/u });
    await usuario.click(processando);

    expect(processando).toBeDisabled();
    expect(onCorrigir).toHaveBeenCalledTimes(1);
    expect(onCorrigido).not.toHaveBeenCalled();

    entregar({ resultado: 'Deleted', removidoDoBling: false });
    await waitFor(() => expect(onCorrigido).toHaveBeenCalledTimes(1));
  });

  it('Blocked: frase amigável, o detalhe continua e a lista não é relida', async () => {
    const onCorrigir = vi.fn(async (): Promise<DesfechoDaCorrecao> => ({
      resultado: 'Blocked', motivo: 'estorno_nao_suportado_com_seguranca',
    }));
    const { usuario, onCorrigido } = montar(DO_BLING, onCorrigir);

    await usuario.click(screen.getByRole('button', { name: 'Cancelar despesa' }));
    const dialogo = await screen.findByRole('dialog');
    await usuario.click(within(dialogo).getByRole('button', { name: 'Cancelar despesa' }));

    const alerta = await within(dialogo).findByRole('alert');
    expect(alerta).toHaveTextContent('Esta despesa já foi paga no Bling.');
    expect(alerta.textContent).not.toMatch(/88123|t-9|HTTP|SQL/u);
    expect(onCorrigido).not.toHaveBeenCalled();
  });
});
