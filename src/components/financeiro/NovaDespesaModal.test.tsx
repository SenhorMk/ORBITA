/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { NovaDespesaModal } from './NovaDespesaModal';
import type { CategoriaFinanceira } from './useLeituraFinanceira';

/**
 * O que uma despesa nova precisa carregar.
 *
 * Título e Descrição são campos distintos, e o título passou a ser exigido no
 * formulário — a coluna continua `nullable` no banco, porque os registros
 * anteriores a ela não podem ser invalidados retroativamente. A categoria é
 * escolhida entre as **reais** da organização, que a leitura do Financeiro já
 * traz na mesma resposta; sem categorias, nenhuma é inventada.
 *
 * O status não é escolhido aqui: ele continua sendo derivado do fluxo
 * (`aberto`/`pago`, conforme o ERP confirma), e um seletor seria uma segunda
 * autoridade sobre o mesmo fato.
 */

const CATEGORIAS: CategoriaFinanceira[] = [
  { id: '33333333-3333-4333-8333-333333333333', descricao: 'Mercadorias' },
  { id: '44444444-4444-4444-8444-444444444444', descricao: 'Frete' },
];

const picker = {
  fornecedorSelecionado: null,
  showFornecedorDropdown: false,
  setShowFornecedorDropdown: vi.fn(),
  dropdownRef: { current: null },
  fornecedorSearchInputRef: { current: null },
  searchFornecedor: '',
  setSearchFornecedor: vi.fn(),
  fornecedoresFiltrados: [],
  setFornecedorSelecionado: vi.fn(),
  onCadastrarNovo: vi.fn(),
};

function montar(overrides: { categorias?: CategoriaFinanceira[]; onSubmit?: (e: React.FormEvent<HTMLFormElement>) => void } = {}) {
  const onSubmit = overrides.onSubmit ?? vi.fn((e: React.FormEvent<HTMLFormElement>) => e.preventDefault());
  render(
    <NovaDespesaModal
      isOpen
      onClose={vi.fn()}
      modoLancamento="contabil"
      setModoLancamento={vi.fn()}
      syncing={false}
      onSubmit={onSubmit}
      fornecedorPicker={picker}
      categorias={overrides.categorias ?? CATEGORIAS}
    />,
  );
  return { onSubmit };
}

describe('nova despesa', () => {
  it('o título é exigido no formulário', () => {
    montar();
    expect(screen.getByLabelText('Título')).toBeRequired();
  });

  it('título e descrição são dois campos, com dois nomes diferentes', () => {
    montar();
    expect(screen.getByLabelText('Título')).toHaveAttribute('name', 'titulo');
    expect(screen.getByLabelText('Descrição do Gasto')).toHaveAttribute('name', 'descricao');
  });

  it('a categoria escolhida é a real da organização, e vai como `categoriaId`', async () => {
    montar();
    const seletor = screen.getByLabelText('Categoria');

    expect(seletor).toHaveAttribute('name', 'categoriaId');
    expect(screen.getByRole('option', { name: 'Mercadorias' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Frete' })).toBeInTheDocument();

    await userEvent.selectOptions(seletor, CATEGORIAS[1]!.id);
    expect(seletor).toHaveValue(CATEGORIAS[1]!.id);
  });

  it('"Sem categoria" é uma resposta legítima e sai como vazio, não como id inventado', () => {
    montar();
    expect(screen.getByLabelText('Categoria')).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Sem categoria' })).toHaveValue('');
  });

  it('sem categorias na organização, nenhuma é fabricada', () => {
    montar({ categorias: [] });

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText(/Nenhuma categoria financeira cadastrada/i)).toBeInTheDocument();
  });

  it('não existe seletor de status: ele continua derivado do fluxo', () => {
    montar();
    expect(screen.queryByLabelText(/situação|status/i)).not.toBeInTheDocument();
  });

  it('o formulário submetido carrega título, descrição e categoria juntos', async () => {
    const capturado: Record<string, string> = {};
    montar({
      onSubmit: (e) => {
        e.preventDefault();
        for (const [chave, valor] of new FormData(e.currentTarget).entries()) {
          capturado[chave] = String(valor);
        }
      },
    });

    await userEvent.type(screen.getByLabelText('Título'), 'Insumos');
    await userEvent.type(screen.getByLabelText('Descrição do Gasto'), '1kg de rapé');
    await userEvent.type(screen.getByLabelText('Valor (R$)'), '120.5');
    await userEvent.selectOptions(screen.getByLabelText('Categoria'), CATEGORIAS[0]!.id);
    await userEvent.click(screen.getByRole('button', { name: 'Registrar saída' }));

    expect(capturado).toMatchObject({
      titulo: 'Insumos',
      descricao: '1kg de rapé',
      categoriaId: CATEGORIAS[0]!.id,
    });
  });
});
