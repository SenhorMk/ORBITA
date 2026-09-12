/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

    await waitFor(() => expect(screen.getByText(/Salvar está bloqueado/i)).toBeTruthy());
    expect(botaoSalvar().disabled).toBe(true);
  });

  it('não envia nada ao update enquanto os obrigatórios são desconhecidos', async () => {
    const chamadas = rede();
    render(<ProductDetailModal isOpen onClose={vi.fn()} produto={SINCRONIZADO} cliente={null} />);

    await waitFor(() => expect(screen.getByText(/Salvar está bloqueado/i)).toBeTruthy());
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
