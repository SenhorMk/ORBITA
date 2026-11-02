import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { BlingFake } from './__testkit__/blingFake';
import type { BlingPort } from './blingPort';

/**
 * Guarda de **payload de escrita** contra o schema oficial do Bling.
 *
 * `bling-schemas.test.ts` cuida do sentido da leitura: o tipo que declaramos
 * contra o que o Bling devolve. Esta cuida do outro sentido, que é o perigoso —
 * **o Bling aceita requisição com campo que não existe e descarta sem
 * reclamar**. Não há erro, não há aviso: o dado simplesmente não chega.
 *
 * Já aconteceu três vezes:
 *
 * | Enviado | Correto | Efeito |
 * |---|---|---|
 * | `codigo` (query) | `codigos[]` | filtro ignorado, e o PUT seguinte sobrescreveu produto não relacionado |
 * | `fone` (corpo) | `telefone` | contato criado sem telefone |
 * | `contribuinte` (corpo) | `indicadorIe` | contato criado sem indicador de IE |
 *
 * O payload conferido aqui **não é fixture**: é o que sai pelo fio. O adapter
 * real serializa contra um servidor HTTP real, e a guarda inspeciona a
 * requisição capturada. Uma fixture montada no teste provaria apenas que o
 * teste concorda consigo mesmo.
 *
 * Corpo, caminho e query são conferidos separadamente — `codigos[]` é query, e
 * cobrá-lo no corpo teria deixado exatamente aquele defeito passar.
 */

const RAIZ = path.resolve(__dirname, '..', '..');

interface CampoOficial {
  readonly tipo: string;
  readonly formato?: string;
  readonly ref?: string;
  /** DTO dos elementos, quando a lista é de objetos. */
  readonly itens?: string;
  /** Tipo primitivo dos elementos, quando a lista não é de objetos. */
  readonly tipoDosItens?: string;
  readonly somenteLeitura?: boolean;
  readonly nulavel?: boolean;
}

interface SchemaOficial {
  readonly obrigatorios: readonly string[];
  readonly campos: Readonly<Record<string, CampoOficial>>;
}

const catalogo = JSON.parse(
  readFileSync(path.join(RAIZ, 'docs/integrations/bling-v3-schemas.json'), 'utf8'),
) as {
  schemas: Record<string, SchemaOficial>;
  /** Composição do corpo de cada endpoint de escrita: o `allOf` do `requestBody`. */
  escrita: Record<string, readonly string[]>;
  origem?: { url: string; capturadoEm: string };
};

type Motivo = 'inexistente' | 'somente-leitura' | 'tipo' | 'nulo' | 'obrigatorio-ausente';

/** Divergência entre o que enviamos e o que o schema oficial declara. */
interface Divergencia {
  readonly campo: string;
  readonly motivo: Motivo;
  readonly detalhe: string;
}

/** Campos e obrigatórios da composição oficial de um endpoint de escrita. */
function contratoDoEndpoint(endpoint: string): SchemaOficial {
  const dtos = catalogo.escrita[endpoint];
  if (!dtos) throw new Error(`endpoint de escrita ausente no catálogo: ${endpoint}`);
  const campos: Record<string, CampoOficial> = {};
  const obrigatorios = new Set<string>();
  for (const dto of dtos) {
    const schema = catalogo.schemas[dto];
    if (!schema) throw new Error(`schema oficial ausente no catálogo: ${dto}`);
    Object.assign(campos, schema.campos);
    schema.obrigatorios.forEach((o) => obrigatorios.add(o));
  }
  return { campos, obrigatorios: [...obrigatorios].sort() };
}

/**
 * Obrigatórios que valem para **enviar**, e não para receber.
 *
 * A regra é do próprio OpenAPI: uma propriedade `readOnly` marcada como
 * `required` é obrigatória apenas na **resposta**, e não deve ser enviada na
 * requisição. É o caso de `id` em `POST /contatos` — obrigatório no recurso,
 * proibido no corpo de criação.
 *
 * Excluir `readOnly` aqui é ler o contrato, não abrir exceção. Só o que sobra
 * depois disso é obrigação de envio de verdade.
 */
function obrigatoriosDeEnvio(contrato: SchemaOficial): readonly string[] {
  return contrato.obrigatorios.filter((campo) => !contrato.campos[campo]?.somenteLeitura);
}

function tipoDoValor(valor: unknown): string {
  if (Array.isArray(valor)) return 'array';
  if (valor === null) return 'null';
  return typeof valor === 'object' ? 'object' : typeof valor;
}

/** O valor bate com o tipo declarado? `integer` exige inteiro, não só número. */
function tipoCompativel(valor: unknown, tipo: string): boolean {
  const nosso = tipoDoValor(valor);
  if (tipo === 'integer') return typeof valor === 'number' && Number.isInteger(valor);
  if (tipo === 'number') return nosso === 'number';
  if (tipo === 'boolean') return nosso === 'boolean';
  if (tipo === 'string') return nosso === 'string';
  if (tipo === 'array') return nosso === 'array';
  if (tipo === 'object') return nosso === 'object';
  return true;
}

/** Confere um elemento de lista: objeto conhecido, primitivo declarado, ou nada. */
function conferirElemento(valor: unknown, oficial: CampoOficial, caminho: string): Divergencia[] {
  if (valor === null) {
    return [{ campo: caminho, motivo: 'nulo', detalhe: 'elemento nulo numa lista que não declara nulos' }];
  }

  if (oficial.itens) {
    const filho = catalogo.schemas[oficial.itens];
    if (!filho) return [];
    if (typeof valor !== 'object' || Array.isArray(valor)) {
      return [{
        campo: caminho,
        motivo: 'tipo',
        detalhe: `enviado \`${tipoDoValor(valor)}\`, oficial \`${oficial.itens}\` (objeto)`,
      }];
    }
    return conferirObjeto(valor as Record<string, unknown>, filho, oficial.itens, caminho);
  }

  if (oficial.tipoDosItens && !tipoCompativel(valor, oficial.tipoDosItens)) {
    return [{
      campo: caminho,
      motivo: 'tipo',
      detalhe: `enviado \`${tipoDoValor(valor)}\`, oficial \`${oficial.tipoDosItens}\``,
    }];
  }

  return [];
}

/**
 * Confere um objeto enviado contra um schema oficial, recursivamente.
 *
 * Devolve a lista de divergências em vez de lançar, para o teste nomear todas
 * de uma vez em vez de uma por execução.
 */
export function conferirObjeto(
  enviado: Record<string, unknown>,
  contrato: SchemaOficial,
  rotulo: string,
  prefixo = '',
  obrigatoriosEsperados: readonly string[] = obrigatoriosDeEnvio(contrato),
): Divergencia[] {
  const divergencias: Divergencia[] = [];
  const caminhoDe = (chave: string) => (prefixo ? `${prefixo}.${chave}` : chave);

  for (const chave of obrigatoriosEsperados) {
    if (enviado[chave] === undefined) {
      divergencias.push({
        campo: caminhoDe(chave),
        motivo: 'obrigatorio-ausente',
        detalhe: `${rotulo} exige este campo no envio`,
      });
    }
  }

  for (const [chave, valor] of Object.entries(enviado)) {
    const caminho = caminhoDe(chave);
    const oficial = contrato.campos[chave];

    if (!oficial) {
      // O spec do Bling é internamente inconsistente em pelo menos um ponto:
      // `VendasItemDTO` lista `valorLista` em `required` e **não o declara** em
      // `properties`. O campo é real — o contrato do ORBITA o envia e o pedido
      // 26735988980 foi criado com ele. Um campo nomeado pelo próprio schema
      // não pode ser tratado como inventado; o que não dá é conferir o tipo.
      if (contrato.obrigatorios.includes(chave)) continue;

      divergencias.push({
        campo: caminho,
        motivo: 'inexistente',
        detalhe: `${rotulo} não declara este campo; o Bling o descarta em silêncio`,
      });
      continue;
    }

    if (oficial.somenteLeitura) {
      divergencias.push({
        campo: caminho,
        motivo: 'somente-leitura',
        detalhe: 'é readOnly no schema oficial; o Bling descarta o que enviarmos',
      });
      continue;
    }

    if (valor === null) {
      // Nenhum campo do catálogo é `nullable`. Aceitar `null` de graça era
      // permissividade, não tolerância a contrato.
      if (!oficial.nulavel) {
        divergencias.push({ campo: caminho, motivo: 'nulo', detalhe: 'o schema não declara este campo como nullable' });
      }
      continue;
    }

    if (!tipoCompativel(valor, oficial.tipo)) {
      divergencias.push({
        campo: caminho,
        motivo: 'tipo',
        detalhe: `enviado \`${tipoDoValor(valor)}\`, oficial \`${oficial.tipo}\``,
      });
      continue;
    }

    if (oficial.ref && typeof valor === 'object' && !Array.isArray(valor)) {
      const filho = catalogo.schemas[oficial.ref];
      if (filho) {
        divergencias.push(...conferirObjeto(valor as Record<string, unknown>, filho, oficial.ref, caminho));
      }
    }

    if (Array.isArray(valor)) {
      valor.forEach((item, i) => {
        divergencias.push(...conferirElemento(item, oficial, `${caminho}[${i}]`));
      });
    }
  }

  return divergencias;
}

/**
 * Obrigatórios de envio que o ORBITA deliberadamente **não** manda, por
 * endpoint e por campo, cada um com a evidência que sustenta a exceção.
 *
 * Não é generalização: `readOnly` já sai por leitura do contrato, e o que resta
 * aqui é omissão real, aceita caso a caso. Uma omissão nova aparece no diff.
 */
const OMISSOES_JUSTIFICADAS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'POST /pedidos/vendas': {
    dataPrevista: 'o pedido 26735988980 foi criado na conta real sem este campo (evidência do ticket 01)',
    dataSaida: 'idem — criado sem este campo',
    parcelas: 'idem — a venda manual não parcela; o Bling aceitou sem a lista',
  },
  'POST /contatos': {},
  'POST /produtos': {},
};

/** Divergências que não estão justificadas para aquele endpoint. */
function naoJustificadas(divergencias: readonly Divergencia[], endpoint: string): Divergencia[] {
  const justificadas = OMISSOES_JUSTIFICADAS[endpoint] ?? {};
  return divergencias.filter(
    (d) => !(d.motivo === 'obrigatorio-ausente' && d.campo in justificadas),
  );
}

/** Confere o corpo enviado contra a composição oficial do endpoint. */
function conferirCorpo(enviado: Record<string, unknown>, endpoint: string): Divergencia[] {
  return conferirObjeto(enviado, contratoDoEndpoint(endpoint), endpoint);
}

const fake = new BlingFake();
const ORG = '11111111-1111-4111-8111-111111111111';
let BlingClient: typeof import('./bling').BlingClient;

function adapter() {
  const cliente = BlingClient.forOrganization(`${ORG}-${Math.random()}`);
  Object.defineProperty(cliente, 'getAccessToken', {
    value: async () => 'token-de-teste',
    configurable: true,
  });
  return cliente;
}

/** Corpo da última requisição que saiu pelo fio, já desserializado. */
function corpoEnviado(): Record<string, unknown> {
  const ultima = fake.recebidas.at(-1);
  if (!ultima) throw new Error('nenhuma requisição capturada');
  return JSON.parse(ultima.body) as Record<string, unknown>;
}

function urlEnviada(): URL {
  const ultima = fake.recebidas.at(-1);
  if (!ultima) throw new Error('nenhuma requisição capturada');
  return new URL(ultima.url, 'http://fake.local');
}

/** Produto representativo: todos os campos que o tipo do domínio exige. */
const PRODUTO: Parameters<BlingPort['criarProduto']>[0] = {
  nome: 'Produto Sintético',
  codigo: 'SKU-1',
  preco: 10,
  tipo: 'P',
  situacao: 'A',
  formato: 'S',
  unidade: 'UN',
  // `ProdutosCategoriaDTO`: o conferidor segue o `ref` e valida o `id` como
  // integer, então é o contrato oficial que aprova esta forma, não o teste.
  categoria: { id: 900 },
};

beforeAll(async () => {
  const baseUrl = await fake.iniciar();
  vi.stubEnv('BLING_API_BASE_URL', baseUrl);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://payload-test-000000.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'payload-test-service-role-key-000000');
  ({ BlingClient } = await import('./bling'));
});

afterEach(() => {
  fake.limpar();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await fake.parar();
});

describe('o catálogo declara sua origem e cobre a escrita', () => {
  it('registra a URL e a data de captura do OpenAPI', () => {
    // Sem isso, ninguém sabe contra qual versão a guarda compara — e o Bling
    // republica o arquivo com outro hash a cada mudança.
    expect(catalogo.origem?.url).toMatch(/developer\.bling\.com\.br.*openapi.*\.json/u);
    expect(catalogo.origem?.capturadoEm).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it('registra a composição de cada endpoint de escrita', () => {
    expect(Object.keys(catalogo.escrita).sort()).toEqual([
      'POST /contatos',
      'POST /pedidos/vendas',
      'POST /produtos',
    ]);
    // `allOf` de dois DTOs: conferir só contra o primeiro reprovaria payload bom.
    expect(catalogo.escrita['POST /pedidos/vendas']).toHaveLength(2);
  });
});

describe('`readOnly` sai dos obrigatórios de envio — é o contrato, não exceção', () => {
  it('`id` é obrigatório e readOnly em POST /contatos, logo não se envia', () => {
    // A regra é do OpenAPI: `readOnly` + `required` obriga na resposta e
    // **proíbe** na requisição. Foi por não ler isso que eu tratei a lista
    // inteira de obrigatórios como não confiável.
    const contrato = contratoDoEndpoint('POST /contatos');

    expect(contrato.obrigatorios).toContain('id');
    expect(contrato.campos.id?.somenteLeitura).toBe(true);
    expect(obrigatoriosDeEnvio(contrato)).not.toContain('id');
  });

  it('os demais obrigatórios continuam sendo cobrados', () => {
    expect(obrigatoriosDeEnvio(contratoDoEndpoint('POST /contatos')).slice().sort())
      .toEqual(['nome', 'situacao', 'tipo']);
  });

it('campo obrigatório que o spec não declara é aceito, e a inconsistência fica registrada', () => {
    // `VendasItemDTO` lista `valorLista` em `required` e não o declara em
    // `properties`. É defeito do spec do Bling, não nosso: o campo é real, o
    // contrato do ORBITA o envia e o pedido 26735988980 foi criado com ele.
    const item = catalogo.schemas.VendasItemDTO!;
    expect(item.obrigatorios).toContain('valorLista');
    expect(item.campos.valorLista, 'o spec não declara esta propriedade').toBeUndefined();

    // Enviá-lo não pode ser reprovado como campo inventado.
    const divergencias = conferirObjeto(
      { descricao: 'X', quantidade: 1, valor: 10, valorLista: 10 },
      item,
      'VendasItemDTO',
    );
    expect(divergencias).toEqual([]);
  });

    it('obrigatório ausente é reprovado', () => {
    const faltando = conferirCorpo({ nome: 'Cliente' }, 'POST /contatos');

    expect(faltando.filter((d) => d.motivo === 'obrigatorio-ausente').map((d) => d.campo).sort())
      .toEqual(['situacao', 'tipo']);
  });
});

describe('prova negativa — a guarda reprova o que já custou defeito', () => {
  const CONTATO_VALIDO = { nome: 'Cliente', situacao: 'A', tipo: 'F' };
  const PEDIDO_VALIDO = {
    contato: { id: 1 },
    data: '2026-08-31',
    itens: [{ descricao: 'X', quantidade: 1, valor: 10, valorLista: 10 }],
  };

  it('`fone` no corpo do contato: o campo oficial é `telefone`', () => {
    const divergencias = conferirCorpo({ ...CONTATO_VALIDO, fone: '11999998888' }, 'POST /contatos');

    expect(divergencias.find((d) => d.campo === 'fone')?.motivo).toBe('inexistente');
  });

  it('`contribuinte` no corpo do contato: o campo oficial é `indicadorIe`', () => {
    const divergencias = conferirCorpo({ ...CONTATO_VALIDO, contribuinte: 1 }, 'POST /contatos');

    expect(divergencias.map((d) => d.campo)).toContain('contribuinte');
  });

  it('os nomes corretos passam — senão a guarda reprovaria tudo e não valeria nada', () => {
    const divergencias = conferirCorpo(
      { ...CONTATO_VALIDO, telefone: '11999998888', indicadorIe: 1 },
      'POST /contatos',
    );

    expect(divergencias).toEqual([]);
  });

  it('campo inventado e campo em objeto aninhado são alcançados', () => {
    const campos = naoJustificadas(
      conferirCorpo({ ...PEDIDO_VALIDO, valorunitario: 10, contato: { id: 1, apelido: 'Zé' } }, 'POST /pedidos/vendas'),
      'POST /pedidos/vendas',
    ).map((d) => d.campo);

    expect(campos).toContain('valorunitario');
    expect(campos).toContain('contato.apelido');
  });

  it('`integer` fracionário é reprovado — `1.5` não é inteiro', () => {
    const divergencias = conferirCorpo({ ...PEDIDO_VALIDO, contato: { id: 1.5 } }, 'POST /pedidos/vendas');

    expect(divergencias.find((d) => d.campo === 'contato.id')?.motivo).toBe('tipo');
  });

  it('`null` é reprovado: nenhum campo do catálogo é nullable', () => {
    const divergencias = conferirCorpo({ ...CONTATO_VALIDO, nome: null }, 'POST /contatos');

    expect(divergencias.find((d) => d.campo === 'nome')?.motivo).toBe('nulo');
  });

  it.each([
    ['nulo', null, 'nulo'],
    ['número', 42, 'tipo'],
    ['texto', 'x', 'tipo'],
  ])('elemento %s numa lista de objetos é reprovado', (_nome, elemento, motivo) => {
    // Antes os elementos que não fossem objeto eram simplesmente ignorados:
    // `itens: [null, 42, "x"]` passava inteiro.
    const divergencias = conferirCorpo(
      { ...PEDIDO_VALIDO, itens: [elemento] },
      'POST /pedidos/vendas',
    );

    expect(divergencias.find((d) => d.campo === 'itens[0]')?.motivo).toBe(motivo);
  });

  it('lista mista reprova cada elemento ruim, e não só o primeiro', () => {
    const divergencias = conferirCorpo(
      { ...PEDIDO_VALIDO, itens: [null, 42, { descricao: 'ok', quantidade: 1, valor: 1, valorLista: 1 }] },
      'POST /pedidos/vendas',
    );

    expect(divergencias.filter((d) => d.campo.startsWith('itens[')).map((d) => d.campo))
      .toEqual(['itens[0]', 'itens[1]']);
  });

  it('campo `readOnly` enviado é reprovado: o Bling descarta o que mandarmos', () => {
    // Foi o caso de `situacao` em contas a pagar: a despesa marcada como paga
    // continuava aberta no ERP, sem erro nenhum.
    const divergencias = conferirCorpo({ ...CONTATO_VALIDO, id: 123 }, 'POST /contatos');

    expect(divergencias.find((d) => d.campo === 'id')?.motivo).toBe('somente-leitura');
  });
});

describe('o payload que sai pelo fio bate com o schema oficial', () => {
  it('POST /pedidos/vendas', async () => {
    fake.programar({ status: 201, body: JSON.stringify({ data: { id: 99 } }) });

    await adapter().criarPedidoVenda({
      contato: { id: 1234 },
      data: '2026-08-31',
      itens: [{ descricao: 'Produto', quantidade: 1, valor: 10, valorLista: 10, produto: { id: 55 } }],
    } as Parameters<BlingPort['criarPedidoVenda']>[0]);

    const url = urlEnviada();
    expect(url.pathname).toBe('/pedidos/vendas');
    expect([...url.searchParams.keys()], 'criação não leva filtro na query').toEqual([]);

    const divergencias = conferirCorpo(corpoEnviado(), 'POST /pedidos/vendas');
    // As três omissões justificadas ficam de fora; qualquer outra reprova.
    expect(naoJustificadas(divergencias, 'POST /pedidos/vendas')).toEqual([]);
    expect(divergencias.map((d) => d.campo).sort())
      .toEqual(Object.keys(OMISSOES_JUSTIFICADAS['POST /pedidos/vendas']!).sort());
  });

  it('POST /contatos — sem omissão nenhuma', async () => {
    fake.programar({ status: 201, body: JSON.stringify({ data: { id: 77 } }) });

    await adapter().criarContatoParaVenda({
      nome: 'Cliente Sintético',
      email: 'cliente@exemplo.test',
      telefone: '11999998888',
      documento: '12345678909',
      tipo: 'F',
      indicadorIe: 9,
    });

    expect(urlEnviada().pathname).toBe('/contatos');
    expect(conferirCorpo(corpoEnviado(), 'POST /contatos')).toEqual([]);
  });

  it('POST /produtos — com entrada representativa, sem omissão nenhuma', async () => {
    // Sem cast que esconda campo: `PRODUTO` traz tudo o que
    // `ProdutoBlingEntrada` exige. Omitir com `as` provaria só que o teste
    // concorda consigo mesmo.
    fake.programar({ status: 201, body: JSON.stringify({ data: { id: 88 } }) });

    await adapter().criarProduto(PRODUTO);

    expect(urlEnviada().pathname).toBe('/produtos');
    expect(conferirCorpo(corpoEnviado(), 'POST /produtos')).toEqual([]);
  });
});

describe('caminho e query são conferidos separadamente do corpo', () => {
  it('a busca por SKU usa `codigos[]` na query, e não `codigo`', async () => {
    // O defeito histórico: `codigo` não é filtro válido, o Bling o ignorava, a
    // resposta trazia um produto qualquer — e o PUT seguinte o sobrescrevia.
    // Cobrar isso no corpo não teria pegado nada: é query.
    fake.programar({ status: 200, body: JSON.stringify({ data: [] }) });

    await adapter().buscarProdutoPorCodigo('SKU-1');

    const chaves = [...urlEnviada().searchParams.keys()];
    expect(chaves).toContain('codigos[]');
    expect(chaves, '`codigo` no singular não existe na API').not.toContain('codigo');
  });

  it('a atualização de produto leva o id no caminho, não no corpo nem na query', async () => {
    fake.programar({ status: 200, body: JSON.stringify({ data: { id: 88 } }) });

    await adapter().atualizarProduto('88', PRODUTO);

    const url = urlEnviada();
    expect(url.pathname).toBe('/produtos/88');
    expect(url.searchParams.has('id')).toBe(false);
    expect(corpoEnviado().id).toBeUndefined();
  });
});
