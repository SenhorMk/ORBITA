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
function rede(roteiro: { confirmar?: unknown; remover?: unknown; sincronizar?: unknown; enviar?: boolean; segurar?: Promise<void> } = {}) {
  const chamadas: Array<{ url: string; corpo: unknown }> = [];
  const enviados: string[] = [];
  const operacoes: OperacoesDeFoto = {
    async postar(url, corpo) {
      chamadas.push({ url, corpo });
      if (url.endsWith('/upload')) return { status: 200, corpo: { resultado: 'UploadAutorizado', caminho: FOTO_B, token: 'tk' } };
      if (url.endsWith('/confirmar')) {
        await roteiro.segurar;
        return { status: 200, corpo: roteiro.confirmar ?? { resultado: 'ImagemConfirmada', caminho: FOTO_B, url: 'https://s/b', bling: 'sincronizada' } };
      }
      if (url.endsWith('/sincronizar')) return { status: 200, corpo: roteiro.sincronizar ?? { resultado: 'SincronizacaoDaFoto', bling: 'sincronizada' } };
      return { status: 200, corpo: roteiro.remover ?? { resultado: 'ImagemRemovida', url: BLING, bling: 'sincronizada' } };
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

    expect(await screen.findByText('Foto atualizada.')).toBeInTheDocument();
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
    expect(await screen.findByText('Foto atualizada.')).toBeInTheDocument();
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
    await userEvent.upload(campoDeArquivo(), arquivo('image/png', 3 * 1024 * 1024 + 1));
    expect(await screen.findByRole('alert')).toHaveTextContent('A imagem passa de 3 MB');
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

  it('Bling pendente depois do upload: foto salva, aviso claro e "Tentar sincronizar novamente" sem novo arquivo', async () => {
    const { operacoes, chamadas, enviados } = rede({ confirmar: { resultado: 'ImagemConfirmada', caminho: FOTO_B, url: 'https://s/b', bling: 'pendente' } });
    render(<ImagemDoProduto produto={produto()} operacoes={operacoes} />);
    await userEvent.upload(campoDeArquivo(), arquivo());

    expect(await screen.findByText('Foto salva no ORBITA. Sincronização com o Bling pendente.')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Imagem do produto' })).toHaveAttribute('src', 'https://s/b');
    await userEvent.click(screen.getByRole('button', { name: 'Tentar sincronizar novamente' }));

    expect(await screen.findByText('Foto sincronizada com o Bling.')).toBeInTheDocument();
    expect(chamadas.at(-1)).toEqual({ url: '/api/produtos/imagem/sincronizar', corpo: { produtoId: ID } });
    // A nova tentativa não reenvia arquivo nenhum.
    expect(enviados).toEqual([FOTO_B]);
    expect(screen.getByText('Sincronizada com o Bling.')).toBeInTheDocument();
  });

  it('outra execução detém o lease: "em andamento", foto mantida e nova tentativa disponível', async () => {
    const { operacoes } = rede({ confirmar: { resultado: 'ImagemConfirmada', caminho: FOTO_B, url: 'https://s/b', bling: 'em_andamento' } });
    render(<ImagemDoProduto produto={produto()} operacoes={operacoes} />);
    await userEvent.upload(campoDeArquivo(), arquivo());
    expect(await screen.findByText('Foto salva no ORBITA. Sincronização com o Bling em andamento.')).toBeInTheDocument();
    expect(screen.getByText('Sincronização com o Bling em andamento em outra aba ou requisição.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tentar sincronizar novamente' })).toBeEnabled();
  });

  it('pendência persistida: depois de recarregar, o produto ainda mostra o pendente e o botão', () => {
    render(<ImagemDoProduto produto={produto({ imagem_storage_path: FOTO_B, imagem_bling_sync_path: FOTO_A, imagem_url: 'https://s/b' })} operacoes={rede().operacoes} />);
    expect(screen.getByText('Sincronização com o Bling pendente.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tentar sincronizar novamente' })).toBeEnabled();
  });

  it('sincronizada: sem botão de nova tentativa', () => {
    render(<ImagemDoProduto produto={produto({ imagem_storage_path: FOTO_A, imagem_bling_sync_path: FOTO_A })} operacoes={rede().operacoes} />);
    expect(screen.getByText('Sincronizada com o Bling.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tentar sincronizar novamente' })).toBeNull();
  });

  it('produto sem vínculo com o Bling: explica e permite tentar depois', () => {
    render(<ImagemDoProduto produto={produto({ bling_id: 'LOCAL-1', imagem_storage_path: FOTO_A })} operacoes={rede().operacoes} />);
    expect(screen.getByText('Produto sem vínculo com o Bling: sincronize o catálogo e tente de novo.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tentar sincronizar novamente' })).toBeInTheDocument();
  });

  it('gerenciada pelo ORBITA e sem foto: sincronizada "sem imagem", sem o espelho do Bling e sem nova tentativa', () => {
    // A API entrega a imagem efetiva: produto gerenciado sem foto chega sem imagem_url.
    render(<ImagemDoProduto produto={produto({ imagem_bling_gerenciada_pelo_orbita: true })} operacoes={rede().operacoes} />);
    expect(screen.getByText('Sincronizada com o Bling.')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Imagem do produto' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tentar sincronizar novamente' })).toBeNull();
  });

  it('drift registrado num produto gerenciado sem foto: pendente, com "Tentar sincronizar novamente"', () => {
    render(<ImagemDoProduto
      produto={produto({ imagem_bling_gerenciada_pelo_orbita: true, imagem_bling_divergencia_detectada_em: '2026-10-02T12:00:00Z' })}
      operacoes={rede().operacoes}
    />);
    expect(screen.getByText('Sincronização com o Bling pendente.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tentar sincronizar novamente' })).toBeEnabled();
  });

  it('nunca adotou foto: nenhum estado de sincronização (as imagens do Bling são do Bling)', () => {
    render(<ImagemDoProduto produto={produto({ imagem_url: BLING })} operacoes={rede().operacoes} />);
    expect(screen.queryByText(/Sincroniza/u)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tentar sincronizar novamente' })).toBeNull();
  });

  it('remoção com Bling pendente: foto local removida, mensagem de remoção pendente', async () => {
    const { operacoes } = rede({ remover: { resultado: 'ImagemRemovida', url: null, bling: 'pendente' } });
    render(<ImagemDoProduto produto={produto({ imagem_storage_path: FOTO_A, imagem_bling_sync_path: FOTO_A })} operacoes={operacoes} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remover foto' }));
    expect(await screen.findByText('Foto removida do ORBITA. Remoção no Bling pendente.')).toBeInTheDocument();
    expect(screen.getByLabelText('Adicionar foto')).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByText('Foto atualizada.')).toBeInTheDocument());
    expect(chamadas.filter((c) => c.url.endsWith('/remover'))).toEqual([]);
    expect(chamadas.filter((c) => c.url.endsWith('/confirmar'))).toHaveLength(1);
  });
});
