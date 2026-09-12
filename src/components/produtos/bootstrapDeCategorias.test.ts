import { describe, expect, it, vi } from 'vitest';

import { avisoDoBootstrap, carregarCategoriasDoProduto } from './bootstrapDeCategorias';

const CATEGORIA = { id: 'cat-1', bling_id: '900', descricao: 'Bebidas' };

function json(corpo: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => corpo,
  } as Response;
}

/**
 * A fronteira de rede, registrando **o que foi chamado e em que ordem**.
 *
 * A ordem é metade do que estes casos medem: "não sincronizou porque já havia
 * catálogo" e "sincronizou e releu" são sequências diferentes de chamadas, e
 * um dublê que só devolvesse corpos não distinguiria uma da outra.
 */
function rede(respostas: {
  primeiroGet: Response;
  post?: Response;
  segundoGet?: Response;
}) {
  const chamadas: string[] = [];
  let gets = 0;
  const fetchWithAuth = vi.fn(async (url: string, options: RequestInit = {}) => {
    const metodo = options.method ?? 'GET';
    chamadas.push(`${metodo} ${url}`);
    if (metodo === 'POST') {
      if (!respostas.post) throw new Error('POST não previsto neste caso');
      return respostas.post;
    }
    gets += 1;
    if (gets === 1) return respostas.primeiroGet;
    if (!respostas.segundoGet) throw new Error('segundo GET não previsto neste caso');
    return respostas.segundoGet;
  });
  return { fetchWithAuth, chamadas };
}

describe('carregarCategoriasDoProduto', () => {
  it('catálogo local já preenchido: usa o que tem e NÃO sincroniza', async () => {
    const { fetchWithAuth, chamadas } = rede({
      primeiroGet: json({ success: true, data: [CATEGORIA] }),
    });

    const resultado = await carregarCategoriasDoProduto(fetchWithAuth);

    expect(resultado).toEqual({ _tag: 'Carregadas', categorias: [CATEGORIA], sincronizou: false });
    // Abrir o modal não é motivo para uma importação no ERP.
    expect(chamadas).toEqual(['GET /api/categorias/sync']);
  });

  it('catálogo vazio: POST e depois GET, e as categorias aparecem', async () => {
    const { fetchWithAuth, chamadas } = rede({
      primeiroGet: json({ success: true, data: [] }),
      post: json({ success: true, count: 1 }),
      segundoGet: json({ success: true, data: [CATEGORIA] }),
    });

    const resultado = await carregarCategoriasDoProduto(fetchWithAuth);

    expect(resultado).toEqual({ _tag: 'Carregadas', categorias: [CATEGORIA], sincronizou: true });
    expect(chamadas).toEqual([
      'GET /api/categorias/sync',
      'POST /api/categorias/sync',
      'GET /api/categorias/sync',
    ]);
    expect(avisoDoBootstrap(resultado)).toBeNull();
  });

  it('Bling realmente sem categorias: é desfecho, e não tentativa a repetir', async () => {
    const { fetchWithAuth, chamadas } = rede({
      primeiroGet: json({ success: true, data: [] }),
      post: json({ success: true, count: 0 }),
    });

    const resultado = await carregarCategoriasDoProduto(fetchWithAuth);

    expect(resultado).toEqual({ _tag: 'CatalogoVazioNoBling' });
    // Sem segundo GET: não há o que reler, e insistir seria bater no ERP a cada
    // abertura de modal para ouvir a mesma resposta.
    expect(chamadas).toEqual(['GET /api/categorias/sync', 'POST /api/categorias/sync']);
    expect(avisoDoBootstrap(resultado)).toMatch(/sem categoria/i);
  });

  it('nunca faz mais de um POST — o caminho é linear por construção', async () => {
    const { fetchWithAuth, chamadas } = rede({
      primeiroGet: json({ success: true, data: [] }),
      post: json({ success: false }, 500),
    });

    await carregarCategoriasDoProduto(fetchWithAuth);

    expect(chamadas.filter((c) => c.startsWith('POST'))).toHaveLength(1);
  });

  it('falha na sincronização vira aviso visível, e não console.warn', async () => {
    const { fetchWithAuth } = rede({
      primeiroGet: json({ success: true, data: [] }),
      post: json({ success: false, error: 'Falha ao sincronizar categorias' }, 500),
    });

    const resultado = await carregarCategoriasDoProduto(fetchWithAuth);

    expect(resultado._tag).toBe('FalhaAoSincronizar');
    // E o aviso diz que dá para seguir: categoria é opcional no produto, então
    // falha de sincronização não pode travar o cadastro.
    expect(avisoDoBootstrap(resultado)).toMatch(/cadastrar sem categoria/i);
  });

  it('403 no POST é dito como permissão, não como falha genérica', async () => {
    // O POST continua exigindo `organization:manage`; esta fatia não contorna
    // nada. O que muda é quem lê a tela saber por que não aconteceu.
    const { fetchWithAuth } = rede({
      primeiroGet: json({ success: true, data: [] }),
      post: json({ success: false, error: 'Acesso negado' }, 403),
    });

    const resultado = await carregarCategoriasDoProduto(fetchWithAuth);

    expect(resultado._tag).toBe('FalhaAoSincronizar');
    expect(avisoDoBootstrap(resultado)).toMatch(/administrador/i);
  });

  it('falha ao ler o catálogo local é dita como leitura, não como catálogo vazio', async () => {
    const { fetchWithAuth, chamadas } = rede({
      primeiroGet: json({ success: false, error: 'Falha ao carregar categorias' }, 500),
    });

    const resultado = await carregarCategoriasDoProduto(fetchWithAuth);

    expect(resultado._tag).toBe('FalhaAoCarregar');
    // Não dá para concluir "está vazio" de uma leitura que não deu certo — e,
    // portanto, não dá para sair importando do ERP por causa dela.
    expect(chamadas).toEqual(['GET /api/categorias/sync']);
  });

  it('rede caindo não explode: vira falha nomeada', async () => {
    const fetchWithAuth = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });

    const resultado = await carregarCategoriasDoProduto(fetchWithAuth);

    expect(resultado._tag).toBe('FalhaAoCarregar');
  });

  it('corpo 200 mas sem envelope reconhecível não passa por catálogo', async () => {
    const { fetchWithAuth } = rede({ primeiroGet: json(null) });

    const resultado = await carregarCategoriasDoProduto(fetchWithAuth);

    expect(resultado._tag).toBe('FalhaAoCarregar');
  });
});
