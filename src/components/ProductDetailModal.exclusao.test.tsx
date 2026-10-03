/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProductDetailModal } from './ProductDetailModal';
import type { Produto } from '@/types';

/**
 * Excluir produto pela tela: só expõe `POST /api/produtos/delete`, cujo fluxo
 * (Bling primeiro, ausência confirmada, depois o ORBITA) já é testado na rota.
 * Aqui: dois passos no MESMO modal, UMA requisição com só o id, nada otimista.
 */

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/fetchWithAuth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args) }));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) } },
}));

function json(corpo: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => corpo } as Response;
}

const SUCESSO = () => json({ success: true, message: 'Produto excluído.', removidoDoBling: true });

/** A rede do modal. `excluir` responde a `POST /api/produtos/delete`; tudo o mais não previsto falha. */
function rede(excluir: () => Promise<Response> | Response = SUCESSO) {
  const chamadas: Array<{ url: string; metodo: string; corpo: unknown }> = [];
  fetchWithAuthMock.mockImplementation(async (url: string, options: RequestInit = {}) => {
    chamadas.push({ url, metodo: options.method ?? 'GET', corpo: typeof options.body === 'string' ? JSON.parse(options.body) : null });
    if (url === '/api/categorias/sync') return json({ success: true, data: [{ id: '9a1e7f10-0000-4000-8000-00000000cafe', bling_id: '900', descricao: 'Kuripe' }] });
    if (url.startsWith('/api/produtos/bling/')) return json({ success: true, obrigatorios: { tipo: 'P', situacao: 'A', formato: 'S', unidade: 'CX' } });
    if (url === '/api/produtos/delete') return excluir();
    if (url === '/api/produtos/update') return json({ success: true, product: {} });
    throw new Error(`Requisição não prevista: ${url}`);
  });
  return { chamadas, exclusoes: () => chamadas.filter((c) => c.url === '/api/produtos/delete') };
}

/** Uma resposta que só chega quando o teste mandar. */
function pendente() {
  let soltar: (r: Response) => void = () => {};
  const promessa = new Promise<Response>((resolve) => { soltar = resolve; });
  return { responder: () => promessa, soltar: (r: Response) => soltar(r) };
}

const NO_BLING: Produto = {
  id: '3f8b6d21-0000-4000-8000-0000000000a1',
  bling_id: '16656037809',
  nome: 'Kuripe Cobra',
  codigo: 'KC-01',
  preco: 80,
  estoque: 1,
  unidade: 'UN',
  imagem_storage_path: '11111111-1111-4111-8111-111111111111/3f8b6d21-0000-4000-8000-0000000000a1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png',
  imagem_bling_gerenciada_pelo_orbita: true,
};
const SO_LOCAL: Produto = { id: '3f8b6d21-0000-4000-8000-0000000000a2', bling_id: 'LOCAL-2', nome: 'Rapé Novo', preco: 40, estoque: 1 };

const botao = (nome: string | RegExp) => screen.getByRole('button', { name: nome }) as HTMLButtonElement;
const consultar = (nome: string | RegExp) => screen.queryByRole('button', { name: nome });

function abrir(produto: Produto | null, extras: Partial<Parameters<typeof ProductDetailModal>[0]> = {}) {
  const onClose = vi.fn();
  const onDeleted = vi.fn();
  render(<ProductDetailModal isOpen onClose={onClose} onDeleted={onDeleted} produto={produto} cliente={null} {...extras} />);
  return { onClose, onDeleted };
}

async function abrirConfirmacao(produto: Produto = NO_BLING) {
  const usuaria = userEvent.setup();
  const r = abrir(produto);
  await usuaria.click(botao('Excluir produto'));
  return { usuaria, ...r };
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
});

describe('ProductDetailModal — o botão de excluir', () => {
  it('produto novo não mostra "Excluir produto": o rodapé continua Cancelar + Salvar', () => {
    rede();
    abrir(null);
    expect(consultar('Excluir produto')).toBeNull();
    expect(botao('Cancelar')).toBeInTheDocument();
    expect(botao(/Salvar alterações/)).toBeInTheDocument();
  });

  it('produto existente mostra "Excluir produto", um botão de verdade (type=button)', () => {
    rede();
    abrir(NO_BLING);
    expect(botao('Excluir produto').getAttribute('type')).toBe('button');
  });

  it('clicar não exclui: abre a confirmação no mesmo modal, com o nome, o SKU e o ID Bling', async () => {
    const { exclusoes } = rede();
    await abrirConfirmacao();
    expect(exclusoes()).toEqual([]);
    expect(screen.getByRole('heading', { name: 'Excluir “Kuripe Cobra”?' })).toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByText('KC-01')).toBeInTheDocument();
    expect(screen.getByText('16656037809')).toBeInTheDocument();
    expect(consultar(/Salvar alterações/)).toBeNull();
  });

  it('produto vinculado: avisa que sai do Bling primeiro e do ORBITA só depois da confirmação lá', async () => {
    rede();
    await abrirConfirmacao();
    expect(screen.getByText('Este produto será excluído do Bling e, somente depois da confirmação da exclusão no Bling, será removido do ORBITA. Esta ação não pode ser desfeita.')).toBeInTheDocument();
  });

  it('produto só local: avisa apenas a remoção do ORBITA, sem ID Bling', async () => {
    rede();
    await abrirConfirmacao(SO_LOCAL);
    expect(screen.getByText('Este produto será removido do ORBITA. Esta ação não pode ser desfeita.')).toBeInTheDocument();
    expect(screen.queryByText('ID Bling')).toBeNull();
  });

  it('"Voltar" retorna ao formulário sem requisição nenhuma', async () => {
    const { exclusoes } = rede();
    const { usuaria } = await abrirConfirmacao();
    await usuaria.click(botao('Voltar'));
    expect(botao(/Salvar alterações/)).toBeInTheDocument();
    expect(botao('Excluir produto')).toBeInTheDocument();
    expect(exclusoes()).toEqual([]);
  });
});

describe('ProductDetailModal — a requisição', () => {
  it('envia exatamente POST /api/produtos/delete com { id } — sem bling_id, organização nem foto', async () => {
    const { exclusoes } = rede();
    const { usuaria } = await abrirConfirmacao();
    await usuaria.click(botao('Excluir definitivamente'));
    await waitFor(() => expect(exclusoes()).toHaveLength(1));
    expect(exclusoes()[0]).toEqual({ url: '/api/produtos/delete', metodo: 'POST', corpo: { id: NO_BLING.id } });
    expect(Object.keys(exclusoes()[0]!.corpo as object)).toEqual(['id']);
  });

  it('duplo clique no mesmo quadro gera UMA requisição só', async () => {
    const resposta = pendente();
    const { exclusoes } = rede(resposta.responder);
    await abrirConfirmacao();
    const confirmar = botao('Excluir definitivamente');
    // Os dois cliques no MESMO act: o React ainda não renderizou o `disabled` entre eles.
    act(() => {
      confirmar.click();
      confirmar.click();
    });
    await waitFor(() => expect(exclusoes()).toHaveLength(1));
    resposta.soltar(SUCESSO());
    await waitFor(() => expect(consultar('Excluindo…')).toBeNull());
    expect(exclusoes()).toHaveLength(1);
  });

  it('durante a requisição tudo trava: Excluindo…, Voltar desligado, ESC não fecha, sem salvar nem foto', async () => {
    const resposta = pendente();
    rede(resposta.responder);
    const { usuaria, onClose } = await abrirConfirmacao();
    await usuaria.click(botao('Excluir definitivamente'));
    expect(botao('Excluindo…').disabled).toBe(true);
    expect(botao('Voltar').disabled).toBe(true);
    await usuaria.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(consultar(/Salvar alterações/)).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    resposta.soltar(SUCESSO());
  });
});

describe('ProductDetailModal — o X do cabeçalho durante a exclusão', () => {
  it('com a resposta pendente, o X não fecha; a requisição é única; só o sucesso fecha', async () => {
    const resposta = pendente();
    const { exclusoes } = rede(resposta.responder);
    const { usuaria, onClose, onDeleted } = await abrirConfirmacao();
    await usuaria.click(botao('Excluir definitivamente'));
    await usuaria.click(botao('Fechar'));
    expect(onClose).not.toHaveBeenCalled();
    expect(botao('Excluindo…')).toBeInTheDocument();
    expect(exclusoes()).toHaveLength(1);
    resposta.soltar(SUCESSO());
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(exclusoes()).toHaveLength(1);
  });

  it('depois de uma falha, fechar pelo X volta a ser permitido', async () => {
    rede(() => json({ success: false, error: 'O Bling não confirmou a exclusão: o produto continua lá. O produto foi mantido no ORBITA.' }, 409));
    const { usuaria, onClose, onDeleted } = await abrirConfirmacao();
    await usuaria.click(botao('Excluir definitivamente'));
    await screen.findByRole('alert');
    await usuaria.click(botao('Fechar'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDeleted).not.toHaveBeenCalled();
  });
});

describe('ProductDetailModal — o desfecho', () => {
  it('200: fecha o modal e sinaliza onDeleted, sem passar registro (quem chama relê o catálogo)', async () => {
    rede();
    const { usuaria, onClose, onDeleted } = await abrirConfirmacao();
    await usuaria.click(botao('Excluir definitivamente'));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(onDeleted).toHaveBeenCalledWith();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('409: mostra a frase do servidor, fica na confirmação, nada fecha nem some', async () => {
    const mensagem = 'O Bling não confirmou a exclusão: o produto continua lá. O produto foi mantido no ORBITA.';
    rede(() => json({ success: false, error: mensagem }, 409));
    const { usuaria, onClose, onDeleted } = await abrirConfirmacao();
    await usuaria.click(botao('Excluir definitivamente'));
    expect(await screen.findByRole('alert')).toHaveTextContent(mensagem);
    expect(onClose).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(botao('Excluir definitivamente').disabled).toBe(false);
    expect(botao('Voltar').disabled).toBe(false);
  });

  it('503: mostra a frase e permite tentar de novo — a segunda tentativa conclui', async () => {
    const respostas = [
      json({ success: false, error: 'Não foi possível confirmar a exclusão no Bling. O produto foi mantido no ORBITA. Tente de novo.' }, 503),
      SUCESSO(),
    ];
    const { exclusoes } = rede(() => respostas.shift()!);
    const { usuaria, onDeleted } = await abrirConfirmacao();
    await usuaria.click(botao('Excluir definitivamente'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Tente de novo.');
    expect(onDeleted).not.toHaveBeenCalled();
    await usuaria.click(botao('Excluir definitivamente'));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(exclusoes()).toHaveLength(2);
  });

  it('500 "excluído no Bling, falhou no ORBITA": a frase exata, e o produto não é dado como removido', async () => {
    const mensagem = 'O produto foi excluído no Bling, mas a exclusão no ORBITA falhou. Tente de novo para concluir.';
    rede(() => json({ success: false, error: mensagem }, 500));
    const { usuaria, onClose, onDeleted } = await abrirConfirmacao();
    await usuaria.click(botao('Excluir definitivamente'));
    expect(await screen.findByRole('alert')).toHaveTextContent(mensagem);
    expect(onClose).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('erro de rede: o produto é mantido e a tela diz isso', async () => {
    rede(() => { throw new TypeError('Failed to fetch'); });
    const { usuaria, onDeleted } = await abrirConfirmacao();
    await usuaria.click(botao('Excluir definitivamente'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível falar com o servidor. O produto foi mantido. Tente de novo.');
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('resposta fora do contrato não vaza nada: frase genérica, nenhum detalhe remoto na tela', async () => {
    rede(() => json({ erro: { mensagem: 'corpo bruto do Bling: invalid_token xyz' } }, 502));
    const { usuaria } = await abrirConfirmacao();
    await usuaria.click(botao('Excluir definitivamente'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível excluir o produto. Ele foi mantido. Tente de novo.');
    expect(document.body.textContent).not.toContain('invalid_token');
  });
});

describe('ProductDetailModal — exclusão × foto × salvar', () => {
  it('foto enviando bloqueia "Excluir produto"; a exclusão nunca chama rota de foto', async () => {
    rede();
    const postar = vi.fn<(url: string, corpo: unknown) => Promise<never>>(() => new Promise<never>(() => {}));
    abrir(SO_LOCAL, { operacoesDeFoto: { postar, enviarAoStorage: async () => true } });
    await userEvent.upload(screen.getByLabelText('Adicionar foto'), new File(['x'], 'f.png', { type: 'image/png' }));
    await waitFor(() => expect(botao('Excluir produto').disabled).toBe(true));
    expect(postar.mock.calls.every(([url]) => String(url).startsWith('/api/produtos/imagem/'))).toBe(true);
  });

  it('salvando bloqueia "Excluir produto": salvar e excluir não correm juntos', async () => {
    const update = pendente();
    rede();
    const base = fetchWithAuthMock.getMockImplementation()!;
    fetchWithAuthMock.mockImplementation(async (url: string, options?: RequestInit) => (url === '/api/produtos/update' ? update.responder() : base(url, options)));
    const usuaria = userEvent.setup();
    abrir(SO_LOCAL);
    await usuaria.click(botao(/Salvar alterações/));
    expect(botao('Excluir produto').disabled).toBe(true);
    update.soltar(json({ success: true, product: {} }));
    await waitFor(() => expect(botao('Excluir produto').disabled).toBe(false));
  });

  it('salvar continua funcionando normalmente, e não envia nada à rota de exclusão', async () => {
    const { chamadas, exclusoes } = rede();
    const onSaved = vi.fn();
    const usuaria = userEvent.setup();
    abrir(SO_LOCAL, { onSaved });
    await usuaria.click(botao(/Salvar alterações/));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(chamadas.some((c) => c.url === '/api/produtos/update')).toBe(true);
    expect(exclusoes()).toEqual([]);
  });

  it('fechar o modal na confirmação descarta a confirmação: reabrir volta ao formulário', async () => {
    rede();
    const usuaria = userEvent.setup();
    const props = { onClose: vi.fn(), produto: NO_BLING, cliente: null };
    const { rerender } = render(<ProductDetailModal isOpen {...props} />);
    await usuaria.click(botao('Excluir produto'));
    rerender(<ProductDetailModal isOpen={false} {...props} />);
    rerender(<ProductDetailModal isOpen {...props} />);
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: /Salvar alterações/ })).toBeInTheDocument();
  });
});
