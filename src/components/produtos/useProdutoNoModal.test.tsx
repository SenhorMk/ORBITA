/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProductDetailModal } from '@/components/ProductDetailModal';
import { useLeituraDoPainel } from '@/components/painel/useLeituraDoPainel';
import { fetchWithAuth } from '@/lib/fetchWithAuth';
import type { Produto } from '@/types';

import { useProdutoNoModal } from './useProdutoNoModal';

/**
 * O modal de produto pertence ao tenant que produziu o produto.
 *
 * Monta a mesma composição de `page.tsx` — leitura carimbada, seleção
 * carimbada e o `ProductDetailModal` real — para provar que a foto privada de
 * A (URL assinada) não sobrevive visualmente à troca para B, nem por um render,
 * nem por uma resposta tardia do painel de A.
 */

vi.mock('@/lib/fetchWithAuth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/supabaseClient', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }));

const ESCOPO_A = 'ana@exemplo.com|org-a:1';
const ESCOPO_B = 'ana@exemplo.com|org-b:2';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const PRODUTO_A = '33333333-3333-4333-8333-333333333333';
const URL_ASSINADA_DE_A = `https://proj.supabase.co/storage/v1/object/sign/produto-imagens/${ORG_A}/${PRODUTO_A}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png?token=assinatura-de-A`;

const produtoDeA: Produto = {
  id: PRODUTO_A,
  bling_id: 'LOCAL-A',
  nome: 'Kuripe da Org A',
  preco: 10,
  estoque: 2,
  imagem_url: URL_ASSINADA_DE_A,
  imagem_storage_path: `${ORG_A}/${PRODUTO_A}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`,
};

function corpoDoPainel(produtos: Produto[]) {
  return {
    success: true,
    data: {
      pedidos: [], produtos, clientes: [], categorias: [],
      estatisticas: { faturamento30Dias: 0, faturamento30DiasAnterior: 0, totalPedidos: 0, pendentes: 0, cancelados: 0, atendidos: 0 },
    },
  };
}

function resposta(corpo: unknown): Response {
  return { ok: true, status: 200, json: async () => corpo } as Response;
}

/** Cada `GET /api/dashboard` fica em voo até o teste soltar, na ordem em que saiu. */
let leituras: Array<(corpo: unknown) => void>;

beforeEach(() => {
  leituras = [];
  vi.mocked(fetchWithAuth).mockReset();
  vi.mocked(fetchWithAuth).mockImplementation(async (url: string) => {
    if (url === '/api/dashboard') {
      return new Promise<Response>((resolver) => { leituras.push((corpo) => resolver(resposta(corpo))); });
    }
    if (url === '/api/categorias/sync') return resposta({ success: true, data: [] });
    throw new Error(`Requisição não prevista: ${url}`);
  });
});

function Tela({ escopo }: { escopo: string }) {
  const painel = useLeituraDoPainel(escopo);
  const modal = useProdutoNoModal(escopo);
  return (
    <>
      {painel.dados?.produtos.map((p) => (
        <button key={p.id} type="button" onClick={() => modal.abrir(p)}>abrir {p.nome}</button>
      ))}
      <button type="button" onClick={modal.abrirCadastro}>cadastrar</button>
      <button type="button" onClick={() => { void painel.recarregar(); }}>recarregar</button>
      <ProductDetailModal isOpen={modal.aberto} onClose={modal.fechar} produto={modal.produto} cliente={null} />
    </>
  );
}

const urlDeAVisivel = () => document.body.innerHTML.includes('assinatura-de-A');

describe('modal de produto preso ao escopo da leitura', () => {
  it('produto de A com foto privada some no mesmo render da troca para B, e resposta tardia de A não o traz de volta', async () => {
    const { rerender } = render(<Tela escopo={ESCOPO_A} />);
    await act(async () => { leituras[0]!(corpoDoPainel([produtoDeA])); });

    // 1–2. Produto de A aberto, com a URL assinada da foto de A na tela.
    await userEvent.click(screen.getByRole('button', { name: 'abrir Kuripe da Org A' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Imagem do produto' })).toHaveAttribute('src', URL_ASSINADA_DE_A);

    // Uma releitura de A fica em voo antes da troca (o fundo está sob o modal,
    // fora da árvore acessível — por isso hidden e ireEvent).
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'recarregar', hidden: true })); });
    const releituraTardiaDeA = leituras.at(-1)!;

    // 3–5. A seleção muda para B: no primeiro render de B, sem esperar nada.
    rerender(<Tela escopo={ESCOPO_B} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(urlDeAVisivel()).toBe(false);

    // 6. A resposta tardia de A chega depois da troca: não reabre nem popula.
    await act(async () => { releituraTardiaDeA(corpoDoPainel([produtoDeA])); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'abrir Kuripe da Org A' })).toBeNull();
    expect(urlDeAVisivel()).toBe(false);

    // B carrega normalmente, e o modal continua fechado.
    await act(async () => { leituras.at(-2)!(corpoDoPainel([])); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(urlDeAVisivel()).toBe(false);

    // Voltar para A é uma seleção nova (outra versão): a seleção antiga não revive.
    rerender(<Tela escopo="ana@exemplo.com|org-a:3" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(urlDeAVisivel()).toBe(false);
  });

  it('o cadastro de produto novo aberto em A também fecha no mesmo render da troca', async () => {
    const { rerender } = render(<Tela escopo={ESCOPO_A} />);
    await userEvent.click(screen.getByRole('button', { name: 'cadastrar' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    rerender(<Tela escopo={ESCOPO_B} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('page.tsx usa a seleção carimbada', () => {
  it('o ProductDetailModal da página abre, fecha e recebe o produto só por useProdutoNoModal(escopoDaLeitura)', () => {
    const pagina = readFileSync(path.resolve(__dirname, '../../app/page.tsx'), 'utf8');
    expect(pagina).toContain('useProdutoNoModal(escopoDaLeitura)');
    expect(pagina).toContain('isOpen={produtoNoModal.aberto}');
    expect(pagina).toContain('produto={produtoNoModal.produto}');
    expect(pagina).not.toMatch(/selectedProdutoModal|isProductModalOpen/u);
  });
});