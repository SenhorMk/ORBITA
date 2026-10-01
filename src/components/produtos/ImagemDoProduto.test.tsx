/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { Produto } from '@/types';

import { ImagemDoProduto } from './ImagemDoProduto';
import type { OperacoesDeFoto } from './fotoDoProduto';

vi.mock('@/lib/supabaseClient', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }));

const ORG = '11111111-1111-4111-8111-111111111111';
const ID = '33333333-3333-4333-8333-333333333333';
const FOTO_A = `${ORG}/${ID}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`;
const FOTO_B = `${ORG}/${ID}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png`;
const BLING = 'https://orgbling.s3.amazonaws.com/p.jpg';

const produto = (extra: Partial<Produto> = {}): Produto => ({ id: ID, bling_id: '1', nome: 'P', preco: 1, estoque: 1, ...extra });
const arquivo = (tipo = 'image/png', tamanho = 1024) => new File([new Uint8Array(tamanho)], 'foto-da-cliente.png', { type: tipo });

/** Rede falsa: grava cada chamada e responde pelo roteiro. */
function rede(roteiro: { confirmar?: unknown; remover?: unknown; enviar?: boolean; segurar?: Promise<void> } = {}) {
  const chamadas: Array<{ url: string; corpo: unknown }> = [];
  const enviados: string[] = [];
  const operacoes: OperacoesDeFoto = {
    async postar(url, corpo) {
      chamadas.push({ url, corpo });
      if (url.endsWith('/upload')) return { status: 200, corpo: { resultado: 'UploadAutorizado', caminho: FOTO_B, token: 'tk' } };
      if (url.endsWith('/confirmar')) {
        await roteiro.segurar;
        return { status: 200, corpo: roteiro.confirmar ?? { resultado: 'ImagemConfirmada', caminho: FOTO_B, url: 'https://s/b' } };
      }
      return { status: 200, corpo: roteiro.remover ?? { resultado: 'ImagemRemovida', url: BLING } };
    },
    async enviarAoStorage(caminho) {
      enviados.push(caminho);
      return roteiro.enviar ?? true;
    },
  };
  return { operacoes, chamadas, enviados };
}

const campoDeArquivo = () => document.getElementById('product-detail-foto') as HTMLInputElement;

describe('ImagemDoProduto', () => {
  it('produto novo, sem id: nada de upload — só o aviso', () => {
    const { operacoes, chamadas } = rede();
    render(<ImagemDoProduto produto={null} operacoes={operacoes} />);
    expect(screen.getByText('Salve o produto primeiro para adicionar uma foto.')).toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    render(<ImagemDoProduto produto={{ ...produto(), id: undefined }} operacoes={operacoes} />);
    expect(screen.getAllByText('Salve o produto primeiro para adicionar uma foto.')).toHaveLength(2);
    expect(chamadas).toEqual([]);
  });

  it('sem foto própria: "Adicionar foto" ligado ao input de arquivo com accept de JPEG/PNG/WebP, e o fallback do Bling', () => {
    render(<ImagemDoProduto produto={produto({ imagem_url: BLING })} operacoes={rede().operacoes} />);
    const campo = screen.getByLabelText('Adicionar foto');
    expect(campo).toBe(campoDeArquivo());
    expect(campo).toHaveAttribute('type', 'file');
    expect(campo).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
    expect(screen.queryByRole('button', { name: 'Remover foto' })).toBeNull();
    expect(screen.getByRole('img', { name: 'Imagem do produto' })).toHaveAttribute('src', BLING);
    expect(screen.getByText('Exibindo a imagem do Bling.')).toBeInTheDocument();
  });

  it('sem nenhuma imagem: placeholder, sem <img>', () => {
    render(<ImagemDoProduto produto={produto()} operacoes={rede().operacoes} />);
    expect(screen.queryByRole('img', { name: 'Imagem do produto' })).toBeNull();
    expect(screen.getByText('Sem imagem.')).toBeInTheDocument();
  });

  it('com foto própria: "Trocar foto" e "Remover foto"', () => {
    render(<ImagemDoProduto produto={produto({ imagem_storage_path: FOTO_A, imagem_url: 'https://s/a' })} operacoes={rede().operacoes} />);
    expect(screen.getByLabelText('Trocar foto')).toBe(campoDeArquivo());
    expect(screen.getByRole('button', { name: 'Remover foto' })).toBeEnabled();
  });

  it('adicionar: autoriza, envia ao Storage, confirma sem precondição, mostra a prévia nova e avisa quem abriu', async () => {
    const { operacoes, chamadas, enviados } = rede();
    const onAlterada = vi.fn();
    render(<ImagemDoProduto produto={produto()} operacoes={operacoes} onAlterada={onAlterada} />);

    await userEvent.upload(campoDeArquivo(), arquivo());

    expect(await screen.findByText('Foto adicionada.')).toBeInTheDocument();
    expect(chamadas.map((c) => c.url)).toEqual(['/api/produtos/imagem/upload', '/api/produtos/imagem/confirmar']);
    expect(chamadas[0]!.corpo).toEqual({ produtoId: ID, tipo: 'image/png', tamanho: 1024 });
    expect(chamadas[1]!.corpo).toEqual({ produtoId: ID, caminho: FOTO_B, anterior: null });
    // O nome do arquivo não sai do navegador.
    expect(JSON.stringify(chamadas)).not.toContain('foto-da-cliente');
    expect(enviados).toEqual([FOTO_B]);
    expect(screen.getByRole('img', { name: 'Imagem do produto' })).toHaveAttribute('src', 'https://s/b');
    expect(screen.getByLabelText('Trocar foto')).toBeInTheDocument();
    expect(onAlterada).toHaveBeenCalledTimes(1);
  });

  it('trocar: a foto atual vai como precondição', async () => {
    const { operacoes, chamadas } = rede();
    render(<ImagemDoProduto produto={produto({ imagem_storage_path: FOTO_A })} operacoes={operacoes} />);
    await userEvent.upload(campoDeArquivo(), arquivo('image/webp'));
    expect(await screen.findByText('Foto trocada.')).toBeInTheDocument();
    expect(chamadas[1]!.corpo).toEqual({ produtoId: ID, caminho: FOTO_B, anterior: FOTO_A });
  });

  it('remover: devolve a imagem do Bling e volta a "Adicionar foto"', async () => {
    const { operacoes, chamadas } = rede();
    render(<ImagemDoProduto produto={produto({ imagem_storage_path: FOTO_A, imagem_url: 'https://s/a' })} operacoes={operacoes} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remover foto' }));
    expect(await screen.findByText('Foto removida.')).toBeInTheDocument();
    expect(chamadas).toEqual([{ url: '/api/produtos/imagem/remover', corpo: { produtoId: ID, anterior: FOTO_A } }]);
    expect(screen.getByRole('img', { name: 'Imagem do produto' })).toHaveAttribute('src', BLING);
    expect(screen.getByLabelText('Adicionar foto')).toBeInTheDocument();
  });

  it('tipo e tamanho são conferidos antes de qualquer chamada (UX; o servidor confere de novo)', async () => {
    const { operacoes, chamadas } = rede();
    render(<ImagemDoProduto produto={produto()} operacoes={operacoes} />);
    await userEvent.upload(campoDeArquivo(), arquivo('image/png', 5 * 1024 * 1024 + 1));
    expect(await screen.findByRole('alert')).toHaveTextContent('A imagem passa de 5 MB');
    expect(chamadas).toEqual([]);
  });

  it('falha no envio ao Storage: erro na tela, sem confirmação', async () => {
    const { operacoes, chamadas } = rede({ enviar: false });
    render(<ImagemDoProduto produto={produto()} operacoes={operacoes} />);
    await userEvent.upload(campoDeArquivo(), arquivo());
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível enviar a imagem');
    expect(chamadas.map((c) => c.url)).toEqual(['/api/produtos/imagem/upload']);
  });

  it('conflito de outra aba: mensagem própria, e o catálogo é relido', async () => {
    const onAlterada = vi.fn();
    render(<ImagemDoProduto produto={produto({ imagem_storage_path: FOTO_A })} operacoes={rede({ confirmar: { resultado: 'Conflito' } }).operacoes} onAlterada={onAlterada} />);
    await userEvent.upload(campoDeArquivo(), arquivo());
    expect(await screen.findByRole('alert')).toHaveTextContent('alterada em outra janela');
    expect(onAlterada).toHaveBeenCalledTimes(1);
  });

  it('resposta fora do contrato (403 da autorização) não ecoa o corpo', async () => {
    const operacoes: OperacoesDeFoto = {
      postar: async () => ({ status: 403, corpo: { success: false, error: 'detalhe interno' } }),
      enviarAoStorage: async () => true,
    };
    render(<ImagemDoProduto produto={produto()} operacoes={operacoes} />);
    await userEvent.upload(campoDeArquivo(), arquivo());
    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent('Apenas quem administra');
    expect(alerta).not.toHaveTextContent('detalhe interno');
  });

  it('durante a operação os controles travam: não há duplo envio', async () => {
    let liberar: () => void = () => {};
    const segurar = new Promise<void>((resolve) => { liberar = resolve; });
    const { operacoes, chamadas } = rede({ segurar });
    render(<ImagemDoProduto produto={produto({ imagem_storage_path: FOTO_A })} operacoes={operacoes} />);

    await userEvent.upload(campoDeArquivo(), arquivo());
    expect(await screen.findByText('Enviando a foto…')).toBeInTheDocument();
    expect(campoDeArquivo()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remover foto' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Remover foto' }));

    liberar();
    await waitFor(() => expect(screen.getByText('Foto trocada.')).toBeInTheDocument());
    expect(chamadas.filter((c) => c.url.endsWith('/remover'))).toEqual([]);
    expect(chamadas.filter((c) => c.url.endsWith('/confirmar'))).toHaveLength(1);
  });
});
