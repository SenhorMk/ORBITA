import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { BlingFake } from './__testkit__/blingFake';

/**
 * Ticket 31 — descoberta das situações de pedido de venda, pelo fio.
 *
 * O defeito que originou este arquivo não era de lógica: era **rota errada**.
 * `getSituacoesModulo` chamava `GET /situacoes/modulos` — a lista de módulos —
 * e procurava um campo `situacoes` dentro de cada módulo. Devolvia `[]` em
 * qualquer conta, e dois recursos concluíam que a conta não tinha a situação
 * "Cancelado": a compensação da venda manual e o botão de cancelar da listagem.
 *
 * Nenhum teste pegou porque nada comparava o **caminho chamado** com o
 * contrato oficial — cada lado era coerente consigo mesmo. Por isso a guarda
 * central deste arquivo é o caminho que sai pelo fio, conferido contra a
 * captura oficial em `docs/integrations/bling-v3-paths.json`.
 */

const RAIZ = path.resolve(__dirname, '..', '..');

const rotasOficiais = (
  JSON.parse(readFileSync(path.join(RAIZ, 'docs/integrations/bling-v3-paths.json'), 'utf8')) as {
    paths: readonly string[];
  }
).paths;

const fake = new BlingFake();
const ORG = '31313131-3131-4131-8131-313131313131';
let BlingClient: typeof import('./bling').BlingClient;

function adapter() {
  const cliente = BlingClient.forOrganization(`${ORG}-${Math.random()}`);
  Object.defineProperty(cliente, 'getAccessToken', {
    value: async () => 'token-de-teste',
    configurable: true,
  });
  return cliente;
}

const caminhos = () => fake.recebidas.map((r) => new URL(r.url, 'http://fake.local').pathname);

const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });

const MODULOS = {
  data: [
    { id: 98765431, nome: 'Compras', descricao: 'Pedidos de Compra', criarSituacoes: true },
    { id: 98765432, nome: 'Vendas', descricao: 'Pedidos de Venda', criarSituacoes: true },
  ],
};

const SITUACOES = {
  data: [
    { id: 9, nome: 'Em aberto', cor: '#E9DC40' },
    { id: 15, nome: 'Cancelado', cor: '#F44336' },
  ],
};

beforeAll(async () => {
  const baseUrl = await fake.iniciar();
  vi.stubEnv('BLING_API_BASE_URL', baseUrl);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://situacoes-test-000000.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'situacoes-test-service-role-key-000000');
  ({ BlingClient } = await import('./bling'));
});

afterEach(() => fake.limpar());

afterAll(async () => {
  vi.unstubAllEnvs();
  await fake.parar();
});

describe('as rotas usadas existem no contrato oficial', () => {
  it('a listagem de módulos e a de situações de um módulo são recursos distintos', () => {
    // Se um dia forem a mesma rota, este teste cai — e é o aviso de que a
    // descoberta em dois passos deixou de ser necessária.
    expect(rotasOficiais).toContain('/situacoes/modulos');
    expect(rotasOficiais).toContain('/situacoes/modulos/{idModuloSistema}');
  });
});

describe('obterSituacoesDePedidoDeVenda', () => {
  it('descobre o módulo e depois pede as situações DELE, nessa ordem', async () => {
    fake.programar(json(200, MODULOS), json(200, SITUACOES));

    const resultado = await adapter().obterSituacoesDePedidoDeVenda();

    expect(resultado).toEqual({ _tag: 'BlingOk', value: [{ id: 9, nome: 'Em aberto' }, { id: 15, nome: 'Cancelado' }] });
    // A guarda que faltava: o segundo caminho carrega o id do módulo achado no
    // primeiro. A versão anterior chamava só o primeiro, e por isso nunca via
    // situação nenhuma.
    expect(caminhos()).toEqual(['/situacoes/modulos', '/situacoes/modulos/98765432']);
  });

  it('não fixa id de módulo: pede o que a conta devolveu', async () => {
    fake.programar(
      json(200, { data: [{ id: 555, nome: 'Vendas', descricao: 'Pedidos de Venda' }] }),
      json(200, SITUACOES),
    );

    await adapter().obterSituacoesDePedidoDeVenda();

    expect(caminhos()[1]).toBe('/situacoes/modulos/555');
    // O `9` que estava fixo no código era exemplo de id de *situação*, de outro
    // schema. Nunca foi id de módulo.
    expect(caminhos()[1]).not.toBe('/situacoes/modulos/9');
  });

  it('falha com a razão do Bling quando a lista de módulos não vem', async () => {
    fake.programar(json(400, { error: { type: 'VALIDATION_ERROR', description: 'Requisição inválida' } }));

    const resultado = await adapter().obterSituacoesDePedidoDeVenda();

    expect(resultado._tag).toBe('BlingFailed');
    if (resultado._tag !== 'BlingFailed') throw new Error('esperava falha');
    expect(resultado.failure.status).toBe(400);
    expect(resultado.failure.message).toMatch(/requisição inválida/iu);
    // Não pediu situações de módulo nenhum: parou no primeiro passo.
    expect(caminhos()).toEqual(['/situacoes/modulos']);
  });

  it('devolve falha tipada quando o cliente LANÇA em vez de responder', async () => {
    // `fetchWithAuth` lança em 401/403: antes de devolver a resposta ele tenta
    // renovar o token, e a falha da renovação vira exceção. Sem tratamento,
    // isso escapava de dentro do tratamento de erro da venda manual — e o
    // usuário perdia a instrução de cancelar o pedido à mão.
    fake.programar(json(401, { error: { type: 'UNAUTHORIZED', description: 'Token inválido' } }));

    const resultado = await adapter().obterSituacoesDePedidoDeVenda();

    expect(resultado._tag).toBe('BlingFailed');
    if (resultado._tag !== 'BlingFailed') throw new Error('esperava falha');
    expect(resultado.failure.message).toMatch(/Conectar APIs|OAuth/iu);
    expect(resultado.failure.message).not.toMatch(/situação de venda chamada/iu);
  });

  it('falha com a razão do Bling quando as situações do módulo não vêm', async () => {
    fake.programar(json(200, MODULOS), json(500, { error: { type: 'SERVER_ERROR', description: 'Indisponível' } }));

    const resultado = await adapter().obterSituacoesDePedidoDeVenda();

    expect(resultado._tag).toBe('BlingFailed');
    if (resultado._tag !== 'BlingFailed') throw new Error('esperava falha');
    expect(resultado.failure.status).toBe(500);
  });

  it('não culpa a conta quando o corpo vem em formato inesperado', async () => {
    fake.programar({ status: 200, body: '<html>manutenção</html>' });

    const resultado = await adapter().obterSituacoesDePedidoDeVenda();

    if (resultado._tag !== 'BlingFailed') throw new Error('esperava falha');
    expect(resultado.failure.message).toMatch(/formato/iu);
    expect(resultado.failure.message).not.toMatch(/a conta .* não tem/iu);
  });

  it('diz que não identificou o módulo — não que a conta não tem situação', async () => {
    fake.programar(json(200, { data: [{ id: 1, nome: 'Compras', descricao: 'Pedidos de Compra' }] }));

    const resultado = await adapter().obterSituacoesDePedidoDeVenda();

    if (resultado._tag !== 'BlingFailed') throw new Error('esperava falha');
    expect(resultado.failure.message).toMatch(/módulo de pedidos de venda/iu);
    expect(caminhos()).toEqual(['/situacoes/modulos']);
  });

  it('devolve lista vazia sem inventar falha quando o módulo existe e não tem situações', async () => {
    fake.programar(json(200, MODULOS), json(200, { data: [] }));

    expect(await adapter().obterSituacoesDePedidoDeVenda()).toEqual({ _tag: 'BlingOk', value: [] });
  });
});

describe('cancelarPedidoVenda', () => {
  it('marca o pedido com o id da situação que a conta usa para cancelar', async () => {
    fake.programar(json(200, MODULOS), json(200, SITUACOES), json(200, { data: {} }));

    const resultado = await adapter().cancelarPedidoVenda('26764331138');

    expect(resultado).toEqual({ _tag: 'BlingOk', value: undefined });
    expect(caminhos()).toEqual([
      '/situacoes/modulos',
      '/situacoes/modulos/98765432',
      '/pedidos/vendas/26764331138/situacoes/15',
    ]);
    expect(fake.recebidas.at(-1)?.method).toBe('PATCH');
  });

  it('só menciona a conta quando a leitura funcionou e a situação não está lá', async () => {
    fake.programar(json(200, MODULOS), json(200, { data: [{ id: 9, nome: 'Em aberto' }] }));

    const resultado = await adapter().cancelarPedidoVenda('26764331138');

    if (resultado._tag !== 'BlingFailed') throw new Error('esperava falha');
    expect(resultado.failure.message).toMatch(/na conta do Bling/iu);
    // E dá o que confirmar, em vez de mandar procurar às cegas.
    expect(resultado.failure.message).toMatch(/Em aberto/u);
    // Não chegou a tentar o PATCH.
    expect(caminhos()).toHaveLength(2);
  });

  it('não acusa a conta quando o que falhou foi a leitura', async () => {
    fake.programar(json(503, { error: { type: 'SERVICE_UNAVAILABLE', description: 'Em manutenção' } }));

    const resultado = await adapter().cancelarPedidoVenda('26764331138');

    if (resultado._tag !== 'BlingFailed') throw new Error('esperava falha');
    // A frase antiga era a mesma para os dois casos, e foi ela que mandou o
    // proprietário procurar uma configuração inexistente em 02/09/2026.
    expect(resultado.failure.message).not.toMatch(/situação de venda chamada/iu);
    expect(resultado.failure.message).not.toMatch(/na conta do Bling/iu);
    expect(resultado.failure.status).toBe(503);
  });

  it('propaga a recusa do Bling ao aplicar a situação', async () => {
    fake.programar(
      json(200, MODULOS),
      json(200, SITUACOES),
      json(400, { error: { type: 'VALIDATION_ERROR', description: 'Transição não permitida' } }),
    );

    const resultado = await adapter().cancelarPedidoVenda('26764331138');

    if (resultado._tag !== 'BlingFailed') throw new Error('esperava falha');
    expect(resultado.failure.status).toBe(400);
    expect(resultado.failure.message).toMatch(/transição não permitida/iu);
  });
});
