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
  readonly itens?: string;
  readonly somenteLeitura?: boolean;
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

/** Divergência entre o que enviamos e o que o schema oficial declara. */
interface Divergencia {
  readonly campo: string;
  readonly motivo: 'inexistente' | 'somente-leitura' | 'tipo';
  readonly detalhe: string;
}

/**
 * Campos oficiais do corpo de um endpoint de escrita.
 *
 * O `requestBody` do Bling é um `allOf` de dois DTOs — base mais extensão — e
 * conferir só contra o primeiro reprovaria metade do payload legítimo. A
 * composição vem do catálogo, extraída do próprio spec, e não de palpite.
 */
function camposDoEndpoint(endpoint: string): Readonly<Record<string, CampoOficial>> {
  const dtos = catalogo.escrita[endpoint];
  if (!dtos) throw new Error(`endpoint de escrita ausente no catálogo: ${endpoint}`);
  const unido: Record<string, CampoOficial> = {};
  for (const dto of dtos) {
    const schema = catalogo.schemas[dto];
    if (!schema) throw new Error(`schema oficial ausente no catálogo: ${dto}`);
    Object.assign(unido, schema.campos);
  }
  return unido;
}

function obrigatoriosDoEndpoint(endpoint: string): readonly string[] {
  const dtos = catalogo.escrita[endpoint];
  if (!dtos) throw new Error(`endpoint de escrita ausente no catálogo: ${endpoint}`);
  return [...new Set(dtos.flatMap((dto) => catalogo.schemas[dto]!.obrigatorios))];
}

function tipoDoValor(valor: unknown): string {
  if (Array.isArray(valor)) return 'array';
  if (valor === null) return 'null';
  return typeof valor === 'object' ? 'object' : typeof valor;
}

function tipoCompativel(valor: unknown, oficial: CampoOficial): boolean {
  const nosso = tipoDoValor(valor);
  if (nosso === 'null') return true; // ausência declarada explicitamente
  if (oficial.tipo === 'integer' || oficial.tipo === 'number') return nosso === 'number';
  if (oficial.tipo === 'boolean') return nosso === 'boolean';
  if (oficial.tipo === 'string') return nosso === 'string';
  if (oficial.tipo === 'array') return nosso === 'array';
  if (oficial.tipo === 'object') return nosso === 'object';
  return true;
}

/**
 * Confere um objeto enviado contra um conjunto de campos oficiais.
 *
 * Devolve a lista de divergências em vez de lançar, para o teste nomear todas
 * de uma vez em vez de uma por execução.
 */
export function conferirCampos(
  enviado: Record<string, unknown>,
  oficiais: Readonly<Record<string, CampoOficial>>,
  rotulo: string,
  prefixo = '',
): Divergencia[] {
  const divergencias: Divergencia[] = [];

  for (const [chave, valor] of Object.entries(enviado)) {
    const caminho = prefixo ? `${prefixo}.${chave}` : chave;
    const oficial = oficiais[chave];

    if (!oficial) {
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
        detalhe: `é readOnly no schema oficial; o Bling descarta o que enviarmos`,
      });
      continue;
    }

    if (!tipoCompativel(valor, oficial)) {
      divergencias.push({
        campo: caminho,
        motivo: 'tipo',
        detalhe: `enviado \`${tipoDoValor(valor)}\`, oficial \`${oficial.tipo}\``,
      });
      continue;
    }

    // Aninhados só são conferidos quando o schema nomeia o DTO filho; sem isso
    // a checagem viraria adivinhação.
    if (oficial.ref && valor && typeof valor === 'object' && !Array.isArray(valor)) {
      const filho = catalogo.schemas[oficial.ref];
      if (filho) divergencias.push(...conferirCampos(valor as Record<string, unknown>, filho.campos, oficial.ref, caminho));
    }
    if (oficial.itens && Array.isArray(valor)) {
      const filho = catalogo.schemas[oficial.itens];
      if (filho) {
        valor.forEach((item, i) => {
          if (item && typeof item === 'object') {
            divergencias.push(...conferirCampos(item as Record<string, unknown>, filho.campos, oficial.itens!, `${caminho}[${i}]`));
          }
        });
      }
    }
  }

  return divergencias;
}

/** Confere o corpo enviado contra a composição oficial do endpoint. */
function conferirCorpo(enviado: Record<string, unknown>, endpoint: string): Divergencia[] {
  return conferirCampos(enviado, camposDoEndpoint(endpoint), endpoint);
}

/** Campos obrigatórios do endpoint que o payload não trouxe. */
function obrigatoriosAusentes(enviado: Record<string, unknown>, endpoint: string): string[] {
  return obrigatoriosDoEndpoint(endpoint).filter((campo) => enviado[campo] === undefined);
}

/**
 * Campos que o spec marca `required` e que o ORBITA **não** envia na criação.
 *
 * A lista `required` deste spec não descreve o corpo de criação: ela descreve o
 * recurso. A prova está em `POST /contatos`, que exige **`id`** — num endpoint
 * cuja função é justamente criar o contato e receber o id de volta. E o pedido
 * `26735988980` foi criado de verdade na conta do proprietário sem
 * `dataPrevista`, `dataSaida` nem `parcelas`.
 *
 * Por isso a ausência de obrigatório **não reprova** a guarda: reprovaria o
 * código que funciona. Fica registrada aqui, explícita, para a omissão ser
 * decisão e não descuido — e para uma omissão nova aparecer no diff.
 *
 * O que reprova é o que já custou defeito de verdade: campo que não existe,
 * campo `readOnly` e tipo divergente.
 */
const OMISSOES_CONHECIDAS: Readonly<Record<string, readonly string[]>> = {
  'POST /pedidos/vendas': ['dataPrevista', 'dataSaida', 'parcelas'],
  // `createContato` manda `situacao` e `tipo`; so `id` fica de fora — e `id`
  // num endpoint de criacao e o proprio argumento de que esta lista e do
  // recurso, nao do corpo.
  'POST /contatos': ['id'],
  'POST /produtos': ['formato', 'situacao', 'tipo'],
};

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

describe('prova negativa — a guarda reprova os campos falsos históricos', () => {
  it('`fone` no corpo do contato: o campo oficial é `telefone`', () => {
    const divergencias = conferirCorpo({ nome: 'Cliente', fone: '11999998888' }, 'POST /contatos');

    expect(divergencias.map((d) => d.campo)).toContain('fone');
    expect(divergencias.find((d) => d.campo === 'fone')?.motivo).toBe('inexistente');
  });

  it('`contribuinte` no corpo do contato: o campo oficial é `indicadorIe`', () => {
    const divergencias = conferirCorpo({ nome: 'Cliente', contribuinte: 1 }, 'POST /contatos');

    expect(divergencias.map((d) => d.campo)).toContain('contribuinte');
  });

  it('os nomes corretos passam — senão a guarda reprovaria tudo e não valeria nada', () => {
    const divergencias = conferirCorpo(
      { nome: 'Cliente', telefone: '11999998888', indicadorIe: 1 },
      'POST /contatos',
    );

    expect(divergencias).toEqual([]);
  });

  it('campo inventado no pedido de venda é reprovado', () => {
    const divergencias = conferirCorpo({ contato: { id: 1 }, valorunitario: 10 }, 'POST /pedidos/vendas');

    expect(divergencias.map((d) => d.campo)).toContain('valorunitario');
  });

  it('campo inventado dentro de objeto aninhado também é alcançado', () => {
    const divergencias = conferirCorpo({ contato: { id: 1, apelido: 'Zé' } }, 'POST /pedidos/vendas');

    expect(divergencias.map((d) => d.campo)).toContain('contato.apelido');
  });

  it('tipo divergente é reprovado, não só nome desconhecido', () => {
    const divergencias = conferirCorpo({ contato: { id: '1' } }, 'POST /pedidos/vendas');

    expect(divergencias.find((d) => d.campo === 'contato.id')?.motivo).toBe('tipo');
  });

  it('campo `readOnly` é reprovado: o Bling descarta o que enviarmos', () => {
    // Foi o caso de `situacao` em contas a pagar: a despesa marcada como paga
    // continuava aberta no ERP, sem erro nenhum.
    const somenteLeitura = Object.entries(camposDoEndpoint('POST /produtos'))
      .find(([, campo]) => campo.somenteLeitura)?.[0];

    if (!somenteLeitura) {
      // Se o spec deixar de ter campo readOnly aqui, o caso perde o objeto — e
      // é melhor dizer isso do que passar em silêncio.
      expect(somenteLeitura, 'nenhum campo readOnly em POST /produtos para exercitar').toBeUndefined();
      return;
    }

    const divergencias = conferirCorpo({ [somenteLeitura]: 'x' }, 'POST /produtos');
    expect(divergencias.find((d) => d.campo === somenteLeitura)?.motivo).toBe('somente-leitura');
  });

  it('obrigatório ausente é detectado', () => {
    const obrigatorio = obrigatoriosDoEndpoint('POST /pedidos/vendas')[0];

    expect(obrigatorio, 'o endpoint precisa ter ao menos um obrigatório').toBeDefined();
    expect(obrigatoriosAusentes({}, 'POST /pedidos/vendas')).toContain(obrigatorio);
  });

  it('a lista `required` do spec não descreve o corpo de criação', () => {
    // `POST /contatos` exige `id` — num endpoint cuja função é criar o contato
    // e devolver o id. E o pedido real foi criado sem `dataPrevista`,
    // `dataSaida` e `parcelas`. Por isso a ausência de obrigatório é
    // informativa aqui, e não reprovação: reprovaria o código que funciona.
    expect(obrigatoriosDoEndpoint('POST /contatos')).toContain('id');
  });
});

describe('o payload que sai pelo fio bate com o schema oficial', () => {
  it('POST /pedidos/vendas', async () => {
    fake.programar({ status: 201, body: JSON.stringify({ data: { id: 99 } }) });

    await adapter().criarPedidoVenda({
      contato: { id: 1234 },
      data: '2026-08-31',
      itens: [{ descricao: 'Produto', quantidade: 1, valor: 10, produto: { id: 55 } }],
    } as Parameters<BlingPort['criarPedidoVenda']>[0]);

    const url = urlEnviada();
    expect(url.pathname).toBe('/pedidos/vendas');
    expect([...url.searchParams.keys()], 'criação não leva filtro na query').toEqual([]);

    const corpo = corpoEnviado();
    expect(conferirCorpo(corpo, 'POST /pedidos/vendas')).toEqual([]);
    // Omissao nova aparece aqui; as conhecidas estao registradas com o motivo.
    expect(obrigatoriosAusentes(corpo, 'POST /pedidos/vendas').sort())
      .toEqual([...OMISSOES_CONHECIDAS['POST /pedidos/vendas']!].sort());
  });

  it('POST /contatos', async () => {
    fake.programar({ status: 201, body: JSON.stringify({ data: { id: 77 } }) });

    await adapter().criarContatoParaVenda({
      nome: 'Cliente Sintético',
      email: 'cliente@exemplo.test',
      telefone: '11999998888',
      documento: '12345678909',
    });

    expect(urlEnviada().pathname).toBe('/contatos');

    const corpo = corpoEnviado();
    expect(conferirCorpo(corpo, 'POST /contatos')).toEqual([]);
    expect(obrigatoriosAusentes(corpo, 'POST /contatos').sort())
      .toEqual([...OMISSOES_CONHECIDAS['POST /contatos']!].sort());
  });

  it('POST /produtos', async () => {
    fake.programar({ status: 201, body: JSON.stringify({ data: { id: 88 } }) });

    await adapter().criarProduto({
      nome: 'Produto Sintético',
      codigo: 'SKU-1',
      preco: 10,
    } as Parameters<BlingPort['criarProduto']>[0]);

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

  it('a atualização de produto leva o id no caminho, não no corpo', async () => {
    fake.programar({ status: 200, body: JSON.stringify({ data: { id: 88 } }) });

    await adapter().atualizarProduto('88', {
      nome: 'Produto Sintético',
      codigo: 'SKU-1',
      preco: 12,
    } as Parameters<BlingPort['atualizarProduto']>[1]);

    const url = urlEnviada();
    expect(url.pathname).toBe('/produtos/88');
    expect(url.searchParams.has('id'), 'o id vai no caminho, não na query').toBe(false);
    expect(corpoEnviado().id, 'o id vai no caminho, não no corpo').toBeUndefined();
  });
});
