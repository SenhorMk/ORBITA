/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { Produto } from '@/types';
import { EstoqueEProdutos } from './EstoqueEProdutos';

/**
 * Arquivados (aqui ou excluídos no Bling) ficam fora do catálogo, numa aba
 * separada: o catálogo não polui com o que saiu da venda, e o histórico
 * continua consultável.
 */
const produto = (nome: string, situacao: Produto['situacao'], codigo: string): Produto => ({
  id: `id-${codigo}`, bling_id: `1${codigo.length}`, codigo, nome, preco: 40, estoque: 3, situacao,
  arquivado_em: situacao === 'arquivado' ? '2026-11-23T21:51:00Z' : null,
});

function montar(arquivados: readonly Produto[] = [produto('Kuripe Cobra', 'arquivado', 'KRP-COBRA')]) {
  return render(
    <EstoqueEProdutos
      produtos={[produto('Defumador Portal da Harmonia', 'ativo', 'DEF-HAR')]}
      produtosArquivados={arquivados}
      categorias={[]}
      carregando={false}
      erroDeLeitura={null}
      onRecarregar={vi.fn()}
      onAbrirProduto={vi.fn()}
      onCadastrarProduto={vi.fn()}
    />,
  );
}

describe('Estoque & Produtos: aba de arquivados', () => {
  it('o catálogo, padrão, não mostra arquivados', () => {
    montar();
    expect(screen.getByRole('tab', { name: /Catálogo \(1\)/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Defumador Portal da Harmonia')).toBeInTheDocument();
    expect(screen.queryByText('Kuripe Cobra')).not.toBeInTheDocument();
  });

  it('a aba Arquivados mostra só os arquivados', async () => {
    montar();
    await userEvent.click(screen.getByRole('tab', { name: /Arquivados \(1\)/ }));
    expect(screen.getByText('Kuripe Cobra')).toBeInTheDocument();
    expect(screen.queryByText('Defumador Portal da Harmonia')).not.toBeInTheDocument();
  });

  it('sem arquivados, a aba mostra zero e a lista vazia', async () => {
    montar([]);
    await userEvent.click(screen.getByRole('tab', { name: /Arquivados \(0\)/ }));
    expect(screen.queryByText('Defumador Portal da Harmonia')).not.toBeInTheDocument();
  });
});
