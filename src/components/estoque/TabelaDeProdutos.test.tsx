/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

import type { Produto } from '@/types';

import { TabelaDeProdutos } from './TabelaDeProdutos';

const produto = (id: string, extra: Partial<Produto> = {}): Produto => ({ id, bling_id: '1', nome: id, preco: 1, estoque: 1, ...extra });

describe('TabelaDeProdutos — miniatura', () => {
  it('desenha a imagem efetiva que a leitura entregou, e o placeholder quando não há nenhuma', () => {
    const { container } = render(
      <TabelaDeProdutos
        produtos={[
          produto('com-foto', { imagem_url: 'https://storage.test/sign/org/p/x.png?token=t', imagem_storage_path: 'org/p/x.png' }),
          produto('sem-imagem'),
        ]}
        categorias={[]}
        onAbrir={vi.fn()}
        rodape=""
      />,
    );

    const imagens = [...container.querySelectorAll('img')];
    expect(imagens.map((img) => img.getAttribute('src'))).toEqual(['https://storage.test/sign/org/p/x.png?token=t']);
    // O ícone de placeholder existe em toda linha; a imagem cobre por cima quando há.
    expect(container.querySelectorAll('svg.lucide-image')).toHaveLength(2);
  });
});
