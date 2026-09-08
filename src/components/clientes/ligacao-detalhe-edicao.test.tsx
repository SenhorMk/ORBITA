/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import type { Cliente } from '@/types';
import { ClientesEContatos } from './ClientesEContatos';
import { ClienteDetailModal } from '@/components/ClienteDetailModal';
import { ClienteEditModal } from '@/components/ClienteEditModal';

/**
 * A **ligação** entre o detalhe de um contato e a edição dele.
 *
 * O reskin do ticket 04 não devia mudar comportamento observável, e não mudou —
 * com uma exceção, que a revisão da PR #81 apontou com razão. `ClienteEditModal`
 * já sabia editar um contato existente e `selectedClienteToEdit` já existia em
 * `page.tsx`, mas **nada nunca o preenchia**: o estado só recebia `null`, para
 * cadastrar. Editar um contato que já existe não tinha por onde ser aberto. A
 * ação primária do detalhe passou a ligar os dois, e isso é comportamento novo.
 *
 * As três peças estão certas sozinhas e continuam testadas onde estão. O que só
 * a composição responde é se o clique leva ao **mesmo** contato: um `onEdit` que
 * abrisse a edição sem carregar a seleção daria um formulário de "Cadastrar
 * contato" em cima de um contato que já existe — e salvar ali criaria um
 * segundo registro em vez de corrigir o primeiro. É esse desfecho que este
 * arquivo cobra.
 *
 * A composição abaixo é a fiação de `page.tsx`, reduzida ao que importa aqui —
 * o mesmo recurso de `escopoEfetivo.test.tsx` e de
 * `ticket-22-startup-ligacao.test.tsx`, e pela mesma razão: montar a página
 * inteira arrastaria autenticação, organizações e a leitura do painel para uma
 * pergunta que não é sobre nenhum dos três.
 */

vi.mock('@/lib/fetchWithAuth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));

const ANA: Cliente = {
  id: 'cli-a',
  bling_id: '4321',
  nome: 'Ana Clara Maciel',
  email: 'ana@exemplo.com',
  telefone: '42999112233',
  cpf_cnpj: '11644673444',
};

const BRUNO: Cliente = {
  id: 'cli-b',
  bling_id: '8765',
  nome: 'Bruno Dias',
  email: 'bruno@exemplo.com',
};

/** A fiação de `page.tsx` para a aba de contatos, e só ela. */
function PainelDeContatos({ clientes }: { clientes: Cliente[] }) {
  const [detalhe, setDetalhe] = useState<Cliente | null>(null);
  const [detalheAberto, setDetalheAberto] = useState(false);
  const [emEdicao, setEmEdicao] = useState<Cliente | null>(null);
  const [edicaoAberta, setEdicaoAberta] = useState(false);

  return (
    <>
      <ClientesEContatos
        clientes={clientes}
        carregando={false}
        erroDeLeitura={null}
        onRecarregar={() => {}}
        onAbrirCliente={(cliente) => {
          setDetalhe(cliente);
          setDetalheAberto(true);
        }}
        onCadastrarCliente={() => {
          setEmEdicao(null);
          setEdicaoAberta(true);
        }}
      />

      <ClienteDetailModal
        isOpen={detalheAberto}
        onClose={() => setDetalheAberto(false)}
        cliente={detalhe}
        onEdit={(cliente) => {
          setDetalheAberto(false);
          setEmEdicao(cliente);
          setEdicaoAberta(true);
        }}
      />

      <ClienteEditModal
        isOpen={edicaoAberta}
        onClose={() => setEdicaoAberta(false)}
        cliente={emEdicao}
        onSave={() => {}}
      />
    </>
  );
}

describe('detalhe do contato → edição do mesmo contato', () => {
  it('abre a edição carregada com o contato que estava aberto no detalhe', async () => {
    const usuario = userEvent.setup();
    render(<PainelDeContatos clientes={[ANA, BRUNO]} />);

    // O contato existe na lista, e é dele que se abre o detalhe.
    await usuario.click(screen.getAllByRole('button', { name: 'Ana Clara Maciel' })[0]);
    expect(await screen.findByRole('heading', { name: 'Ana Clara Maciel' })).toBeInTheDocument();

    const editar = screen.getByRole('button', { name: 'Editar contato' });
    await usuario.click(editar);

    // O detalhe deixa de ser a superfície ativa: o título dele e a própria ação
    // que foi clicada saem da tela.
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Ana Clara Maciel' })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Editar contato' })).not.toBeInTheDocument();

    // E a edição abre para o MESMO contato — não como cadastro de um novo.
    expect(screen.getByRole('heading', { name: 'Editar contato' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Cadastrar contato' })).not.toBeInTheDocument();

    expect(screen.getByLabelText(/Nome \/ Razão social/)).toHaveValue('Ana Clara Maciel');
    expect(screen.getByLabelText(/CPF \/ CNPJ/)).toHaveValue('11644673444');
    expect(screen.getByText(`ID Bling: ${ANA.bling_id}`)).toBeInTheDocument();
  });

  it('cadastrar um contato continua abrindo o formulário vazio', async () => {
    const usuario = userEvent.setup();
    render(<PainelDeContatos clientes={[ANA, BRUNO]} />);

    await usuario.click(screen.getByRole('button', { name: /Novo contato/ }));

    expect(await screen.findByRole('heading', { name: 'Cadastrar contato' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Nome \/ Razão social/)).toHaveValue('');
  });
});
