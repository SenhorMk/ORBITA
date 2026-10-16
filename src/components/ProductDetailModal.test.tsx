/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProductDetailModal } from './ProductDetailModal';
import type { Produto } from '@/types';
import { produtoFormatoSchema, produtoSituacaoSchema, produtoTipoSchema } from '@/lib/config/produtoContract';

const fetchWithAuthMock = vi.fn();

vi.mock('@/lib/fetchWithAuth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args),
}));

vi.mock('@/lib/supabaseClient', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) } },
}));

function json(corpo: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => corpo } as Response;
}

/** Os corpos enviados a `POST /api/produtos/update` na chamada corrente. */
const enviados: Record<string, unknown>[] = [];

/** Categorias já no catálogo local, e os obrigatórios reais do ERP. */
function rede({ obrigatorios }: { obrigatorios?: unknown } = {}) {
  const chamadas: string[] = [];
  fetchWithAuthMock.mockImplementation(async (url: string, options: RequestInit = {}) => {
    chamadas.push(`${options.method ?? 'GET'} ${url}`);
    if (typeof options.body === 'string') enviados.push(JSON.parse(options.body));
    if (url === '/api/categorias/sync') {
      return json({ success: true, data: [{ id: '9a1e7f10-0000-4000-8000-00000000cafe', bling_id: '900', descricao: 'Kuripe' }] });
    }
    if (url.startsWith('/api/produtos/bling/')) {
      return obrigatorios === undefined
        ? json({ success: false, error: 'indisponível' }, 502)
        : json({ success: true, obrigatorios });
    }
    if (url === '/api/produtos/update') {
      return json({ success: true, product: { id: '3f8b6d21-0000-4000-8000-0000000000a1', blingId: '14077064', nome: 'Kuripe Cobra', codigo: null, preco: 120, estoque: 3 } });
    }
    throw new Error(`Requisição não prevista: ${url}`);
  });
  return chamadas;
}

const SINCRONIZADO: Produto = {
  id: '3f8b6d21-0000-4000-8000-0000000000a1',
  bling_id: '14077064',
  nome: 'Kuripe Cobra',
  preco: 120,
  estoque: 3,
  unidade: 'CX',
  categoria_id: '9a1e7f10-0000-4000-8000-00000000cafe',
};

const SINCRONIZADO_SEM_UNIDADE: Produto = {
  id: '3f8b6d21-0000-4000-8000-0000000000a3',
  bling_id: '14077065',
  nome: 'Kuripe Sem Unidade',
  preco: 90,
  estoque: 1,
};

const NAO_SINCRONIZADO: Produto = {
  id: '3f8b6d21-0000-4000-8000-0000000000a2',
  bling_id: 'LOCAL-2',
  nome: 'Rapé Novo',
  preco: 40,
  estoque: 1,
};

function valorDoSelect(id: string): string {
  return (document.getElementById(id) as HTMLSelectElement).value;
}

function campoCodigo(): HTMLInputElement {
  return document.getElementById('product-detail-codigo') as HTMLInputElement;
}

function campoUnidade(): HTMLInputElement {
  return document.getElementById('product-detail-unidade') as HTMLInputElement;
}

function botaoSalvar(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Salvar alterações/i }) as HTMLButtonElement;
}

describe('ProductDetailModal — produto já sincronizado não recebe valor inventado', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    enviados.length = 0;
  });

  it('não abre com UN quando a unidade persistida é outra', async () => {
    // `unidade` EXISTE no registro local e era descartada na inicialização.
    rede({ obrigatorios: { tipo: 'S', situacao: 'I', formato: 'E', unidade: 'CX' } });
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={SINCRONIZADO} cliente={null} />);

    expect((document.getElementById('product-detail-unidade') as HTMLInputElement).value).toBe('CX');
  });

  it('mostra tipo, situação e formato REAIS do ERP, não P/A/S', async () => {
    rede({ obrigatorios: { tipo: 'S', situacao: 'I', formato: 'E', unidade: 'CX' } });
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={SINCRONIZADO} cliente={null} />);

    await waitFor(() => expect(valorDoSelect('product-detail-tipo')).toBe('S'));
    expect(valorDoSelect('product-detail-situacao')).toBe('I');
    expect(valorDoSelect('product-detail-formato')).toBe('E');
  });

  it('produto inativo não fica ativo, e composição não vira simples', async () => {
    rede({ obrigatorios: { tipo: 'P', situacao: 'I', formato: 'E', unidade: 'UN' } });
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={SINCRONIZADO} cliente={null} />);

    await waitFor(() => expect(valorDoSelect('product-detail-situacao')).toBe('I'));
    expect(valorDoSelect('product-detail-situacao')).not.toBe('A');
    expect(valorDoSelect('product-detail-formato')).not.toBe('S');
  });

  it('sem conseguir ler do ERP, salvar fica BLOQUEADO', async () => {
    // O caminho perigoso: sem valor autoritativo, um PUT com P/A/S sobrescreve
    // o ERP. O botão não pode estar disponível.
    rede();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={SINCRONIZADO} cliente={null} />);

    await waitFor(() => expect(screen.getByText(/selecione manualmente Tipo, Situação, Formato e Unidade/i)).toBeTruthy());
    expect(botaoSalvar().disabled).toBe(true);
  });

  it('não envia nada ao update enquanto os obrigatórios são desconhecidos', async () => {
    const chamadas = rede();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={SINCRONIZADO} cliente={null} />);

    await waitFor(() => expect(screen.getByText(/selecione manualmente Tipo, Situação, Formato e Unidade/i)).toBeTruthy());
    expect(chamadas.some((c) => c.includes('/api/produtos/update'))).toBe(false);
  });

  it('lida o ERP, salvar libera', async () => {
    rede({ obrigatorios: { tipo: 'S', situacao: 'I', formato: 'E', unidade: 'CX' } });
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={SINCRONIZADO} cliente={null} />);

    await waitFor(() => expect(botaoSalvar().disabled).toBe(false));
  });
});

describe('ProductDetailModal — produto novo e produto local', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    enviados.length = 0;
  });

  it('produto novo começa com os padrões seguros', () => {
    rede();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={null} cliente={null} />);

    expect(valorDoSelect('product-detail-tipo')).toBe('P');
    expect(valorDoSelect('product-detail-situacao')).toBe('A');
    expect(valorDoSelect('product-detail-formato')).toBe('S');
    expect(botaoSalvar().disabled).toBe(false);
  });

  it('produto local ainda sem par no ERP usa padrões e não consulta o Bling', async () => {
    const chamadas = rede();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={NAO_SINCRONIZADO} cliente={null} />);

    expect(valorDoSelect('product-detail-tipo')).toBe('P');
    expect(botaoSalvar().disabled).toBe(false);
    await waitFor(() => expect(chamadas.some((c) => c.includes('/api/categorias'))).toBe(true));
    expect(chamadas.some((c) => c.includes('/api/produtos/bling/'))).toBe(false);
  });

  it('produto local com unidade persistida a preserva', () => {
    rede();
    render(
      <ProductDetailModal isOpen onClose={vi.fn()} produto={{ ...NAO_SINCRONIZADO, unidade: 'KG' }} cliente={null} />,
    );

    expect((document.getElementById('product-detail-unidade') as HTMLInputElement).value).toBe('KG');
  });
});

describe('ProductDetailModal — salvar sinaliza, e não devolve o registro', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    enviados.length = 0;
  });

  it('avisa `onSaved` sem passar objeto nenhum', async () => {
    // A regressão que este caso fixa: o modal devolvia o `ProdutoPersistido` da
    // rota — outro contrato, sem `bling_id`, `categoria_id` nem `unidade` — e a
    // linha do catálogo era substituída por ele. Quem chama tem de RELER.
    rede({ obrigatorios: { tipo: 'P', situacao: 'A', formato: 'S', unidade: 'CX' } });
    const onSaved = vi.fn();
    const usuaria = userEvent.setup();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={SINCRONIZADO} cliente={null} onSaved={onSaved} />);

    await waitFor(() => expect(botaoSalvar().disabled).toBe(false));
    await usuaria.click(botaoSalvar());

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSaved).toHaveBeenCalledWith();
  });
});

describe('ProductDetailModal — imagem do produto', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    enviados.length = 0;
  });

  it('produto novo: a seção existe e só informa que é preciso salvar antes', () => {
    rede();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={null} cliente={null} />);
    expect(screen.getByRole('heading', { name: 'Imagem do produto' })).toBeInTheDocument();
    expect(screen.getByText('Salve o produto primeiro para adicionar uma foto.')).toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('a foto é independente do "Salvar alterações": não chama a rota de produto nem sinaliza onSaved', async () => {
    // `rede` recusa qualquer URL não prevista — abrir o modal não dispara nada da foto.
    const chamadas = rede();
    const onSaved = vi.fn();
    const onImagemAlterada = vi.fn();
    const postar = vi.fn(async (url: string) => (url.endsWith('/upload')
      ? { status: 200, corpo: { resultado: 'UploadAutorizado', caminho: 'c', token: 't' } }
      : { status: 200, corpo: { resultado: 'ImagemConfirmada', caminho: 'c', url: 'https://s/c', bling: 'sincronizada' } }));
    render(
      <ProductDetailModal
        isOpen
        onClose={vi.fn()}
        produto={NAO_SINCRONIZADO}
        cliente={null}
        onSaved={onSaved}
        onImagemAlterada={onImagemAlterada}
        operacoesDeFoto={{ postar, enviarAoStorage: async () => true }}
      />,
    );

    await userEvent.upload(screen.getByLabelText('Adicionar foto'), new File(['x'], 'f.png', { type: 'image/png' }));

    await waitFor(() => expect(onImagemAlterada).toHaveBeenCalledTimes(1));
    expect(onSaved).not.toHaveBeenCalled();
    expect(chamadas.some((c) => c.includes('/api/produtos/update'))).toBe(false);
    expect(botaoSalvar().disabled).toBe(false);
  });
});

describe('ProductDetailModal — todo valor do contrato tem representação no controle', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    enviados.length = 0;
  });

  it('tipo `N` aparece, é mantido, e é o que vai no envio', async () => {
    // `produtoTipoSchema` aceita S|P|N. Sem a opção `N`, um produto real desse
    // tipo não tinha representação e salvar o rebaixava a P ou S.
    rede({ obrigatorios: { tipo: 'N', situacao: 'A', formato: 'S', unidade: 'UN' } });
    const usuaria = userEvent.setup();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={SINCRONIZADO} cliente={null} />);

    await waitFor(() => expect(valorDoSelect('product-detail-tipo')).toBe('N'));
    await waitFor(() => expect(botaoSalvar().disabled).toBe(false));
    await usuaria.click(botaoSalvar());

    await waitFor(() => expect(enviados).toHaveLength(1));
    expect(enviados[0].tipo).toBe('N');
  });

  it('o select de tipo oferece exatamente os valores do schema', () => {
    rede();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={null} cliente={null} />);

    const valores = [...(document.getElementById('product-detail-tipo') as HTMLSelectElement).options]
      .map((o) => o.value)
      .filter((v) => v !== '');

    expect(valores.sort()).toEqual([...produtoTipoSchema.options].sort());
  });

  it('situação e formato também cobrem o schema inteiro', () => {
    rede();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={null} cliente={null} />);

    for (const [id, schema] of [
      ['product-detail-situacao', produtoSituacaoSchema],
      ['product-detail-formato', produtoFormatoSchema],
    ] as const) {
      const valores = [...(document.getElementById(id) as HTMLSelectElement).options]
        .map((o) => o.value)
        .filter((v) => v !== '');
      expect(valores.sort()).toEqual([...schema.options].sort());
    }
  });
});

describe('ProductDetailModal — o SKU não é inventado', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    enviados.length = 0;
  });

  const OBRIGATORIOS = { tipo: 'P', situacao: 'A', formato: 'S', unidade: 'CX' };

  it('produto sincronizado sem código abre com o campo vazio', async () => {
    // `BLING-<id>` entrava no campo editável como se tivesse sido digitado.
    rede({ obrigatorios: OBRIGATORIOS });
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={SINCRONIZADO} cliente={null} />);

    expect(campoCodigo().value).toBe('');
    expect(campoCodigo().value).not.toMatch(/BLING-/);
  });

  it('e salvar não grava código nenhum no ERP', async () => {
    rede({ obrigatorios: OBRIGATORIOS });
    const usuaria = userEvent.setup();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={SINCRONIZADO} cliente={null} />);

    await waitFor(() => expect(botaoSalvar().disabled).toBe(false));
    await usuaria.click(botaoSalvar());

    await waitFor(() => expect(enviados).toHaveLength(1));
    expect(enviados[0]).not.toHaveProperty('codigo');
    expect(JSON.stringify(enviados[0])).not.toMatch(/BLING-/);
  });

  it('o id do Bling continua identificando o produto no cabeçalho', () => {
    // Aparecer no cabeçalho é diferente de ocupar o campo de SKU.
    rede({ obrigatorios: OBRIGATORIOS });
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={SINCRONIZADO} cliente={null} />);

    expect(screen.getByText(/ID Bling 14077064/)).toBeTruthy();
  });

  it('código real é preservado e enviado igual quando ninguém o altera', async () => {
    rede({ obrigatorios: OBRIGATORIOS });
    const usuaria = userEvent.setup();
    render(
      <ProductDetailModal isOpen onClose={vi.fn()} produto={{ ...SINCRONIZADO, codigo: 'KUR-001' }} cliente={null} />,
    );

    expect(campoCodigo().value).toBe('KUR-001');
    await waitFor(() => expect(botaoSalvar().disabled).toBe(false));
    await usuaria.click(botaoSalvar());

    await waitFor(() => expect(enviados).toHaveLength(1));
    expect(enviados[0].codigo).toBe('KUR-001');
  });

  it('produto novo sem código continua permitido, e nada é gerado', async () => {
    rede();
    const usuaria = userEvent.setup();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={null} cliente={null} />);

    expect(campoCodigo().value).toBe('');
    await usuaria.type(document.getElementById('product-detail-nome') as HTMLInputElement, 'Rape Nov');
    await usuaria.click(botaoSalvar());

    await waitFor(() => expect(enviados).toHaveLength(1));
    expect(enviados[0]).not.toHaveProperty('codigo');
  });
});

describe('ProductDetailModal — recuperação manual quando a leitura do ERP falha', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    enviados.length = 0;
  });

  /** Preenche os três selects como a usuária faria. */
  async function escolherObrigatorios(usuaria: ReturnType<typeof userEvent.setup>) {
    await usuaria.selectOptions(document.getElementById('product-detail-tipo') as HTMLSelectElement, 'S');
    await usuaria.selectOptions(document.getElementById('product-detail-situacao') as HTMLSelectElement, 'I');
    await usuaria.selectOptions(document.getElementById('product-detail-formato') as HTMLSelectElement, 'E');
  }

  it('(A) leitura falha: campos vazios, dropdowns utilizáveis, salvar ainda bloqueado', async () => {
    // O beco sem saída: os selects eram desabilitados pela MESMA condição que
    // bloqueia o salvar, então não havia como sair dela de dentro do ORBITA.
    rede();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={SINCRONIZADO} cliente={null} />);

    await waitFor(() => expect(screen.getByText(/selecione manualmente/i)).toBeTruthy());

    expect(valorDoSelect('product-detail-tipo')).toBe('');
    expect(valorDoSelect('product-detail-situacao')).toBe('');
    expect(valorDoSelect('product-detail-formato')).toBe('');
    for (const id of ['product-detail-tipo', 'product-detail-situacao', 'product-detail-formato']) {
      expect((document.getElementById(id) as HTMLSelectElement).disabled).toBe(false);
    }
    expect(botaoSalvar().disabled).toBe(true);
  });

  it('(B) escolhendo os três manualmente, salvar libera', async () => {
    rede();
    const usuaria = userEvent.setup();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={SINCRONIZADO} cliente={null} />);

    await waitFor(() => expect(screen.getByText(/selecione manualmente/i)).toBeTruthy());
    expect(botaoSalvar().disabled).toBe(true);

    await escolherObrigatorios(usuaria);

    expect(botaoSalvar().disabled).toBe(false);
  });

  it('(C) salvar depois da recuperação envia o que a usuária escolheu', async () => {
    rede();
    const usuaria = userEvent.setup();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={SINCRONIZADO} cliente={null} />);

    await waitFor(() => expect(screen.getByText(/selecione manualmente/i)).toBeTruthy());
    await escolherObrigatorios(usuaria);
    await usuaria.click(botaoSalvar());

    await waitFor(() => expect(enviados).toHaveLength(1));
    expect(enviados[0]).toMatchObject({ tipo: 'S', situacao: 'I', formato: 'E', unidade: 'CX' });
    // Nada de P/A/S/UN entrando por baixo.
    expect(enviados[0].tipo).not.toBe('P');
    expect(enviados[0].situacao).not.toBe('A');
    expect(enviados[0].formato).not.toBe('S');
  });

  it('(D) sincronizado sem unidade local: unidade fica vazia e segura o salvar', async () => {
    rede();
    const usuaria = userEvent.setup();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={SINCRONIZADO_SEM_UNIDADE} cliente={null} />);

    await waitFor(() => expect(screen.getByText(/selecione manualmente/i)).toBeTruthy());
    expect(campoUnidade().value).toBe('');

    await escolherObrigatorios(usuaria);
    // Os três selects já estão preenchidos; só a unidade segura o botão.
    expect(botaoSalvar().disabled).toBe(true);

    await usuaria.type(campoUnidade(), 'kg');

    expect(campoUnidade().value).toBe('KG');
    expect(botaoSalvar().disabled).toBe(false);
  });

  it('(D) e a unidade informada é a que vai no envio', async () => {
    rede();
    const usuaria = userEvent.setup();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={SINCRONIZADO_SEM_UNIDADE} cliente={null} />);

    await waitFor(() => expect(screen.getByText(/selecione manualmente/i)).toBeTruthy());
    await escolherObrigatorios(usuaria);
    await usuaria.type(campoUnidade(), 'kg');
    await usuaria.click(botaoSalvar());

    await waitFor(() => expect(enviados).toHaveLength(1));
    expect(enviados[0].unidade).toBe('KG');
  });

  it('(E) sincronizado COM unidade local a preserva mesmo com a leitura falhando', async () => {
    rede();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={SINCRONIZADO} cliente={null} />);

    await waitFor(() => expect(screen.getByText(/selecione manualmente/i)).toBeTruthy());
    expect(campoUnidade().value).toBe('CX');
  });

  it('(F) durante a leitura os controles ficam bloqueados, e depois editáveis', async () => {
    // Bloquear enquanto a resposta não chegou evita a corrida entre a escolha
    // manual e o valor que ainda pode vir do ERP.
    let responder: (() => void) | null = null;
    const espera = new Promise<void>((resolve) => { responder = resolve; });
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url === '/api/categorias/sync') return json({ success: true, data: [] });
      if (url.startsWith('/api/produtos/bling/')) {
        await espera;
        return json({ success: false, error: 'indisponível' }, 502);
      }
      throw new Error(`Requisição não prevista: ${url}`);
    });

    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={SINCRONIZADO} cliente={null} />);

    await waitFor(() => {
      expect((document.getElementById('product-detail-tipo') as HTMLSelectElement).disabled).toBe(true);
    });
    expect(screen.getAllByText(/Lendo do Bling/i)).toHaveLength(3);

    responder!();

    await waitFor(() => {
      expect((document.getElementById('product-detail-tipo') as HTMLSelectElement).disabled).toBe(false);
    });
    expect(campoUnidade().disabled).toBe(false);
    expect(botaoSalvar().disabled).toBe(true);
  });
});

describe('ProductDetailModal — o saldo só vai quando a pessoa o alterou (PRE-006B)', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    enviados.length = 0;
  });

  function campoEstoque(): HTMLInputElement {
    return document.getElementById('product-detail-estoque') as HTMLInputElement;
  }

  it('editar o nome não reenvia o saldo lido ao abrir a tela', async () => {
    // O saldo é balanço absoluto no Bling: reenviar o `3` lido na abertura
    // desfaria uma venda feita enquanto a tela estava aberta.
    rede({ obrigatorios: { tipo: 'P', situacao: 'A', formato: 'S', unidade: 'CX' } });
    const usuaria = userEvent.setup();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={SINCRONIZADO} cliente={null} />);

    await waitFor(() => expect(botaoSalvar().disabled).toBe(false));
    await usuaria.type(document.getElementById('product-detail-nome') as HTMLInputElement, ' Grande');
    await usuaria.click(botaoSalvar());

    await waitFor(() => expect(enviados).toHaveLength(1));
    expect(enviados[0]).not.toHaveProperty('estoque');
  });

  it('saldo alterado vai no envio', async () => {
    rede({ obrigatorios: { tipo: 'P', situacao: 'A', formato: 'S', unidade: 'CX' } });
    const usuaria = userEvent.setup();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={SINCRONIZADO} cliente={null} />);

    await waitFor(() => expect(botaoSalvar().disabled).toBe(false));
    await usuaria.clear(campoEstoque());
    await usuaria.type(campoEstoque(), '7');
    await usuaria.click(botaoSalvar());

    await waitFor(() => expect(enviados).toHaveLength(1));
    expect(enviados[0].estoque).toBe(7);
  });
});

describe('ProductDetailModal — resultado indeterminado bloqueia nova tentativa (PRE-006B, revisão)', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    enviados.length = 0;
  });

  /** Rede em que o update responde `resposta` (ou lança `falha`). */
  function redeComUpdate(resposta: { corpo: unknown; status: number } | { falha: Error }) {
    fetchWithAuthMock.mockImplementation(async (url: string, options: RequestInit = {}) => {
      if (url === '/api/categorias/sync') return json({ success: true, data: [] });
      if (url.startsWith('/api/produtos/bling/')) return json({ success: true, obrigatorios: { tipo: 'P', situacao: 'A', formato: 'S', unidade: 'CX' } });
      if (url === '/api/produtos/update') {
        if (typeof options.body === 'string') enviados.push(JSON.parse(options.body));
        if ('falha' in resposta) throw resposta.falha;
        return json(resposta.corpo, resposta.status);
      }
      throw new Error(`Requisição não prevista: ${url}`);
    });
  }

  const SEM_CONFIRMACAO = {
    status: 502,
    corpo: {
      success: false,
      error: 'O Bling não confirmou o cadastro do produto (tempo esgotado) e ele pode ter sido criado. Não cadastre de novo: sincronize o catálogo e confira antes.',
      reconciliacao: { motivo: 'bling_sem_confirmacao', blingId: null },
    },
  };

  function botaoBloqueado(): HTMLButtonElement {
    // `hidden`: o log de erro aberto por cima deixa o modal de trás `aria-hidden`.
    return screen.getByRole('button', { name: /Aguardando reconciliação/i, hidden: true }) as HTMLButtonElement;
  }

  async function cadastrarNovo(usuaria: ReturnType<typeof userEvent.setup>) {
    await usuaria.type(document.getElementById('product-detail-nome') as HTMLInputElement, 'Rape Novo');
    await usuaria.click(botaoSalvar());
    await waitFor(() => expect(enviados).toHaveLength(1));
  }

  it('502 sem confirmação: sem "Tentar Novamente", salvar bloqueado e o aviso de reconciliação visível', async () => {
    redeComUpdate(SEM_CONFIRMACAO);
    const usuaria = userEvent.setup();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={null} cliente={null} />);

    await cadastrarNovo(usuaria);

    await waitFor(() => expect(screen.getAllByText(/Resultado não confirmado/i).length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: /Tentar Novamente/i })).toBeNull();
    expect(botaoBloqueado().disabled).toBe(true);
    expect(screen.getByRole('alert', { hidden: true }).textContent).toContain('Não cadastre de novo');
  });

  it('fechar e reabrir na mesma sessão continua bloqueado, e nenhum segundo envio acontece', async () => {
    redeComUpdate(SEM_CONFIRMACAO);
    const usuaria = userEvent.setup();
    const { rerender } = render(<ProductDetailModal isOpen onClose={vi.fn()} produto={null} cliente={null} />);
    await cadastrarNovo(usuaria);
    await waitFor(() => expect(botaoBloqueado().disabled).toBe(true));

    rerender(<ProductDetailModal isOpen={false} onClose={vi.fn()} produto={null} cliente={null} />);
    rerender(<ProductDetailModal isOpen onClose={vi.fn()} produto={null} cliente={null} />);

    expect(botaoBloqueado().disabled).toBe(true);
    fireEvent.click(botaoBloqueado());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(enviados).toHaveLength(1);
  });

  it('Bling confirmou e o espelho falhou (500): mesmo bloqueio, sem retentativa', async () => {
    redeComUpdate({
      status: 500,
      corpo: {
        success: false,
        error: 'Produto salvo no Bling (id 14077064), mas falhou ao gravar no ORBITA. Sincronize o catálogo para reconciliar.',
        reconciliacao: { motivo: 'espelho_local_falhou', blingId: '14077064' },
      },
    });
    const usuaria = userEvent.setup();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={SINCRONIZADO} cliente={null} />);

    await waitFor(() => expect(botaoSalvar().disabled).toBe(false));
    await usuaria.click(botaoSalvar());

    await waitFor(() => expect(botaoBloqueado().disabled).toBe(true));
    expect(screen.queryByRole('button', { name: /Tentar Novamente/i })).toBeNull();
  });

  it('resposta perdida na rede também é indeterminada', async () => {
    redeComUpdate({ falha: new TypeError('Failed to fetch') });
    const usuaria = userEvent.setup();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={null} cliente={null} />);

    await cadastrarNovo(usuaria);

    await waitFor(() => expect(botaoBloqueado().disabled).toBe(true));
    expect(screen.queryByRole('button', { name: /Tentar Novamente/i })).toBeNull();
  });

  it('o bloqueio é do produto indeterminado: outro produto continua editável', async () => {
    redeComUpdate(SEM_CONFIRMACAO);
    const usuaria = userEvent.setup();
    const { rerender } = render(<ProductDetailModal isOpen onClose={vi.fn()} produto={null} cliente={null} />);
    await cadastrarNovo(usuaria);
    await waitFor(() => expect(botaoBloqueado().disabled).toBe(true));

    rerender(<ProductDetailModal isOpen onClose={vi.fn()} produto={SINCRONIZADO} cliente={null} />);

    await waitFor(() => expect((screen.getByRole('button', { name: /Salvar alterações/i, hidden: true }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('recusa comprovada mantém "Tentar Novamente" e o salvar liberado', async () => {
    redeComUpdate({ status: 400, corpo: { success: false, error: 'O Bling recusou o cadastro do produto: Campo obrigatório' } });
    const usuaria = userEvent.setup();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={null} cliente={null} />);

    await cadastrarNovo(usuaria);

    await waitFor(() => expect(screen.getByRole('button', { name: /Tentar Novamente/i })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Aguardando reconciliação/i, hidden: true })).toBeNull();
  });
});

describe('ProductDetailModal — sucesso parcial fica visível (PRE-006B, revisão)', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    enviados.length = 0;
  });

  function redeComSucesso(corpo: unknown) {
    fetchWithAuthMock.mockImplementation(async (url: string, options: RequestInit = {}) => {
      if (url === '/api/categorias/sync') return json({ success: true, data: [] });
      if (url.startsWith('/api/produtos/bling/')) return json({ success: true, obrigatorios: { tipo: 'P', situacao: 'A', formato: 'S', unidade: 'CX' } });
      if (url === '/api/produtos/update') {
        if (typeof options.body === 'string') enviados.push(JSON.parse(options.body));
        return json(corpo);
      }
      throw new Error(`Requisição não prevista: ${url}`);
    });
  }

  it('saldo não confirmado: mostra "salvo, com pendência", relê o catálogo e não fecha sozinho', async () => {
    redeComSucesso({
      success: true,
      saldo: 'nao_confirmado',
      avisos: ['O produto 14077064 foi salvo no Bling, mas o saldo de estoque não foi confirmado: Depósito padrão não configurado. O estoque no ORBITA não foi alterado; sincronize para conferir.'],
    });
    const onClose = vi.fn();
    const onSaved = vi.fn();
    const usuaria = userEvent.setup();
    render(<ProductDetailModal isOpen onClose={onClose} produto={SINCRONIZADO} cliente={null} onSaved={onSaved} />);

    await waitFor(() => expect(botaoSalvar().disabled).toBe(false));
    await usuaria.clear(document.getElementById('product-detail-estoque') as HTMLInputElement);
    await usuaria.type(document.getElementById('product-detail-estoque') as HTMLInputElement, '9');
    await usuaria.click(botaoSalvar());

    await waitFor(() => expect(screen.getByText(/Produto salvo, com pendência/i)).toBeTruthy());
    expect(screen.getByText(/Depósito padrão não configurado/i)).toBeTruthy();
    expect(onSaved).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/Produto salvo, com pendência/i)).toBeTruthy();
  });

  it('sucesso completo continua fechando sozinho', async () => {
    redeComSucesso({ success: true, saldo: 'nao_solicitado', avisos: [] });
    const onClose = vi.fn();
    const usuaria = userEvent.setup();
    render(<ProductDetailModal isOpen onClose={onClose} produto={SINCRONIZADO} cliente={null} />);

    await waitFor(() => expect(botaoSalvar().disabled).toBe(false));
    await usuaria.click(botaoSalvar());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });
});
