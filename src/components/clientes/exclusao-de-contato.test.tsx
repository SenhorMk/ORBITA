/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import type { DesfechoDaCorrecao } from '@/lib/config/correcaoOperacionalContract';
import type { Cliente } from '@/types';
import { ClientesEContatos } from './ClientesEContatos';
import { ClienteDetailModal } from '@/components/ClienteDetailModal';

/**
 * Exclusão de contato na interface: a ação mora no detalhe, pede confirmação
 * dentro do mesmo modal, trava enquanto o servidor responde e só tira o contato
 * da lista depois de `Deleted`.
 *
 * A composição reproduz a fiação de `page.tsx` (`onExcluir` + `onExcluido`
 * relendo a lista), no mesmo recurso de `ligacao-detalhe-edicao.test.tsx`.
 */

vi.mock('@/lib/fetchWithAuth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));

const ANA: Cliente = { id: 'cli-a', bling_id: '4321', nome: 'Ana Clara Maciel', email: 'ana@exemplo.com' };
const LOCAL: Cliente = { id: 'cli-l', bling_id: '', nome: 'Contato Local' };

/** Uma resposta do servidor que o teste decide quando entregar. */
function adiada() {
  let entregar!: (d: DesfechoDaCorrecao) => void;
  const promessa = new Promise<DesfechoDaCorrecao>((resolve) => { entregar = resolve; });
  return { promessa, entregar };
}

function Painel({ iniciais, onExcluir }: { iniciais: Cliente[]; onExcluir: (id: string) => Promise<DesfechoDaCorrecao> }) {
  const [clientes, setClientes] = useState(iniciais);
  const [detalhe, setDetalhe] = useState<Cliente | null>(null);
  const [aberto, setAberto] = useState(false);
  return (
    <>
      <ClientesEContatos
        clientes={clientes}
        carregando={false}
        erroDeLeitura={null}
        onRecarregar={() => {}}
        onAbrirCliente={(c) => { setDetalhe(c); setAberto(true); }}
        onCadastrarCliente={() => {}}
      />
      <ClienteDetailModal
        isOpen={aberto}
        onClose={() => setAberto(false)}
        cliente={detalhe}
        onExcluir={onExcluir}
        onExcluido={() => {
          setAberto(false);
          // A "releitura" do painel: o servidor já não tem o contato.
          setClientes((atuais) => atuais.filter((c) => c.id !== detalhe?.id));
        }}
      />
    </>
  );
}

async function abrirConfirmacao(nome: string) {
  const usuario = userEvent.setup();
  await usuario.click(screen.getAllByRole('button', { name: nome })[0]!);
  const dialogo = await screen.findByRole('dialog');
  await usuario.click(within(dialogo).getByRole('button', { name: /^Excluir$/u }));
  return { usuario, dialogo: await screen.findByRole('dialog') };
}

describe('exclusão de contato na interface', () => {
  it('a lista não tem ação destrutiva por linha — ela só existe no detalhe', () => {
    render(<Painel iniciais={[ANA]} onExcluir={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /excluir/iu })).toBeNull();
  });

  it('a confirmação mostra o nome, avisa do Bling e da irreversibilidade', async () => {
    render(<Painel iniciais={[ANA]} onExcluir={vi.fn()} />);
    const { dialogo } = await abrirConfirmacao('Ana Clara Maciel');

    expect(within(dialogo).getByText('Ana Clara Maciel')).toBeInTheDocument();
    expect(dialogo).toHaveTextContent('e também do Bling');
    expect(dialogo).toHaveTextContent('não pode ser desfeita');
    expect(within(dialogo).getByRole('button', { name: 'Excluir contato' })).toBeInTheDocument();
  });

  it('contato só do ORBITA não fala em Bling', async () => {
    render(<Painel iniciais={[LOCAL]} onExcluir={vi.fn()} />);
    const { dialogo } = await abrirConfirmacao('Contato Local');
    expect(dialogo).not.toHaveTextContent('Bling');
  });

  it('enquanto processa: botão desabilitado, um único envio, detalhe aberto e lista intacta', async () => {
    const resposta = adiada();
    const onExcluir = vi.fn(() => resposta.promessa);
    render(<Painel iniciais={[ANA]} onExcluir={onExcluir} />);
    const { usuario, dialogo } = await abrirConfirmacao('Ana Clara Maciel');

    const botao = within(dialogo).getByRole('button', { name: 'Excluir contato' });
    await usuario.click(botao);
    await usuario.click(within(dialogo).getByRole('button', { name: /Excluindo/u }));

    expect(onExcluir).toHaveBeenCalledTimes(1);
    expect(onExcluir).toHaveBeenCalledWith('cli-a');
    expect(within(dialogo).getByRole('button', { name: /Excluindo/u })).toBeDisabled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // O contato continua na lista até o servidor confirmar. (`hidden`: com o
    // modal aberto, o Radix tira o fundo da árvore de acessibilidade.)
    expect(screen.getAllByRole('button', { name: 'Ana Clara Maciel', hidden: true }).length).toBeGreaterThan(0);

    resposta.entregar({ resultado: 'Deleted', removidoDoBling: true });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryAllByRole('button', { name: 'Ana Clara Maciel', hidden: true })).toEqual([]);
  });

  it('Blocked: mostra a frase amigável, mantém o detalhe e a lista', async () => {
    render(
      <Painel
        iniciais={[ANA]}
        onExcluir={async () => ({ resultado: 'Blocked', motivo: 'possui_historico' })}
      />,
    );
    const { usuario, dialogo } = await abrirConfirmacao('Ana Clara Maciel');

    await usuario.click(within(dialogo).getByRole('button', { name: 'Excluir contato' }));

    expect(await within(dialogo).findByRole('alert')).toHaveTextContent(
      'Este contato possui histórico vinculado e não pode ser excluído.',
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Ana Clara Maciel', hidden: true }).length).toBeGreaterThan(0);
  });

  it('resultado ambíguo não tira o contato da lista e não mostra nada técnico', async () => {
    render(
      <Painel
        iniciais={[ANA]}
        onExcluir={async () => ({ resultado: 'ReconcileRequired', motivo: 'estado_remoto_indeterminado' })}
      />,
    );
    const { usuario, dialogo } = await abrirConfirmacao('Ana Clara Maciel');

    await usuario.click(within(dialogo).getByRole('button', { name: 'Excluir contato' }));

    const alerta = await within(dialogo).findByRole('alert');
    expect(alerta).toHaveTextContent('Não foi possível confirmar a situação no Bling');
    expect(alerta.textContent).not.toMatch(/HTTP|SQL|foreign key|cli-a|4321|stack/iu);
    expect(screen.getAllByRole('button', { name: 'Ana Clara Maciel', hidden: true }).length).toBeGreaterThan(0);
  });
});
