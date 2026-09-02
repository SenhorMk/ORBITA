import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { z } from 'zod';

import { BlingFake } from './__testkit__/blingFake';
import { moduloSistemaSchema, situacaoSchema } from '../lib/integrations/bling/situacoesContract';

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

/**
 * As capturas são lidas com schema, não com `as`.
 *
 * Um `as` sobre `JSON.parse` afirma uma forma que ninguém conferiu: se a
 * captura mudar de formato, o teste quebra num `undefined` obscuro em vez de
 * dizer que o catálogo mudou. Como o assunto deste arquivo é justamente
 * "afirmar forma sem conferir", usar `as` aqui seria o mesmo erro de novo.
 */
const catalogoDeRotasSchema = z.object({ paths: z.array(z.string()) });

const schemaOficialSchema = z.object({
  obrigatorios: z.array(z.string()),
  campos: z.record(z.string(), z.object({ tipo: z.string() }).loose()),
});

const catalogoDeSchemasSchema = z.object({
  schemas: z.record(z.string(), schemaOficialSchema),
  capturasAdicionais: z
    .array(z.object({ capturadoEm: z.string(), url: z.string(), schemas: z.array(z.string()) }))
    .optional(),
});

function lerCaptura<T>(arquivo: string, schema: z.ZodType<T>): T {
  const bruto: unknown = JSON.parse(readFileSync(path.join(RAIZ, arquivo), 'utf8'));
  const lido = schema.safeParse(bruto);
  if (!lido.success) {
    throw new Error(`captura ${arquivo} não tem a forma esperada: ${lido.error.message}`);
  }
  return lido.data;
}

const rotasOficiais = lerCaptura('docs/integrations/bling-v3-paths.json', catalogoDeRotasSchema).paths;
const catalogo = lerCaptura('docs/integrations/bling-v3-schemas.json', catalogoDeSchemasSchema);

/** Um DTO oficial pelo nome, falhando com o nome quando ele sumir da captura. */
function schemaOficial(nome: string) {
  const encontrado = catalogo.schemas[nome];
  if (!encontrado) throw new Error(`schema oficial ausente na captura: ${nome}`);
  return encontrado;
}

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

/**
 * Conferir só o **caminho** não teria pego o defeito original: a rota
 * `/situacoes/modulos` existe, e era chamada. O que não existia era o campo
 * `situacoes` **dentro** de cada módulo. A guarda que faltava é sobre a forma
 * da resposta, e é esta.
 */
describe('a forma que o código espera bate com os schemas oficiais', () => {
  const moduloBase = schemaOficial('SituacoesModuloBaseDTO');
  const modulo = schemaOficial('SituacoesModuloDTO');
  const situacao = schemaOficial('SituacoesDTO');

  const camposDoModulo = { ...moduloBase.campos, ...modulo.campos };

  it('o campo `situacoes` NÃO existe no módulo — é o defeito original, virado guarda', () => {
    // A versão antiga procurava `modulo.situacoes` e recebia `undefined` em
    // toda conta. Se o Bling um dia acrescentar esse campo, este teste cai e
    // avisa que a descoberta em dois passos pode ser simplificada.
    expect(Object.keys(camposDoModulo)).not.toContain('situacoes');
  });

  it('os campos que a busca do módulo usa são declarados no contrato', () => {
    // `encontrarModuloDePedidosDeVenda` decide por `descricao` e `nome`.
    // Depender de campo que o contrato não declara foi exatamente o defeito.
    expect(camposDoModulo.id?.tipo).toBe('integer');
    expect(camposDoModulo.nome?.tipo).toBe('string');
    expect(camposDoModulo.descricao?.tipo).toBe('string');
  });

  it('o schema local exige o que o oficial marca como obrigatório na situação', () => {
    expect(situacao.obrigatorios).toEqual(['id', 'nome']);
    expect(situacaoSchema.safeParse({ id: 15 }).success).toBe(false);
    expect(situacaoSchema.safeParse({ nome: 'Cancelado' }).success).toBe(false);
    expect(situacaoSchema.safeParse({ id: 15, nome: 'Cancelado' }).success).toBe(true);
  });

  it('o schema local respeita os tipos oficiais da situação', () => {
    expect(situacao.campos.id?.tipo).toBe('integer');
    expect(situacao.campos.nome?.tipo).toBe('string');
    // `integer`, não `number`: um id fracionário não é id.
    expect(situacaoSchema.safeParse({ id: 15.5, nome: 'Cancelado' }).success).toBe(false);
    expect(situacaoSchema.safeParse({ id: '15', nome: 'Cancelado' }).success).toBe(false);
    expect(situacaoSchema.safeParse({ id: 15, nome: 42 }).success).toBe(false);
  });

  it('o schema local do módulo exige o `id`, que é o que a segunda chamada usa', () => {
    expect(moduloBase.obrigatorios).toContain('id');
    expect(moduloSistemaSchema.safeParse({ nome: 'Vendas' }).success).toBe(false);
    expect(moduloSistemaSchema.safeParse({ id: 7 }).success).toBe(true);
  });

  it('`nome` e `descricao` ficam opcionais no schema local, e isso é deliberado', () => {
    // O oficial marca os dois como obrigatórios. O local afrouxa de propósito:
    // um módulo sem rótulo não pode derrubar a leitura da lista inteira — ele
    // só deixa de casar com a busca. Afrouxar o que **não** é usado como chave
    // é diferente de depender de campo inexistente.
    expect(modulo.obrigatorios).toEqual(['criarSituacoes', 'descricao', 'nome']);
    expect(moduloSistemaSchema.safeParse({ id: 7 }).success).toBe(true);
  });

  it('a captura registra origem e data', () => {
    const captura = catalogo.capturasAdicionais?.find((c) => c.schemas.includes('SituacoesDTO'));
    expect(captura?.url).toMatch(/developer\.bling\.com\.br.*openapi.*\.json/u);
    expect(captura?.capturadoEm).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
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
    // A razão do provedor NAO sai: a frase e montada so a partir do status.
    expect(resultado.failure.message).not.toMatch(/requisição inválida/iu);
    expect(resultado.failure.message).toMatch(/HTTP 400/u);
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
    expect(resultado.failure.message).toMatch(/Conectar APIs/iu);
    expect(resultado.failure.message).not.toMatch(/situação de venda chamada/iu);
  });

  it('a mensagem do erro lançado NÃO sai na resposta', async () => {
    // Aqui dentro cai o que o cofre de credenciais e o Postgres lançam, e
    // `descreverErro` de um erro do Postgres carrega `details` e `hint` — valor
    // de linha (CWE-209). A resposta é fixa; o diagnóstico vai para o log.
    fake.programar(json(401, { error: { type: 'UNAUTHORIZED', description: 'Token inválido' } }));

    const resultado = await adapter().obterSituacoesDePedidoDeVenda();

    if (resultado._tag !== 'BlingFailed') throw new Error('esperava falha');
    // A exceção real diz "Nenhuma conexao Bling encontrada para esta
    // organizacao" e traz o status HTTP — nada disso pode aparecer.
    expect(resultado.failure.message).not.toMatch(/conexao Bling encontrada/iu);
    expect(resultado.failure.message).not.toMatch(/HTTP \d{3}/u);
    expect(resultado.failure.message).toBe(
      'Não foi possível falar com o Bling para ler as situações de venda. '
        + 'Confira a conexão em "Conectar APIs" e tente de novo.',
    );
  });

  it('uma falha HTTP não publica o corpo que o Bling mandou', async () => {
    // Este é o caminho que faltava: `BlingFailed` vindo de resposta HTTP, não
    // de exceção. `parseBlingFailure` monta a mensagem a partir do corpo —
    // `description`, os `fields[]` que ecoam o que foi enviado, e até 300
    // caracteres crus quando o corpo não é o envelope da v3. Nada disso pode
    // chegar à resposta pública.
    fake.programar(
      json(400, {
        error: {
          type: 'VALIDATION_ERROR',
          description: 'Falha ao consultar interno-db-01.bling.local com token abc123',
          fields: [{ code: 1, msg: 'valor recusado: 4111111111111111', element: 'cartao' }],
        },
      }),
    );

    const resultado = await adapter().obterSituacoesDePedidoDeVenda();

    if (resultado._tag !== 'BlingFailed') throw new Error('esperava falha');
    expect(resultado.failure.message).not.toMatch(/interno-db-01/u);
    expect(resultado.failure.message).not.toMatch(/abc123/u);
    expect(resultado.failure.message).not.toMatch(/4111111111111111/u);
    expect(resultado.failure.message).not.toMatch(/VALIDATION_ERROR/u);
    // O status sobrevive: é número, e é o que correlaciona a queixa com o log.
    expect(resultado.failure.message).toMatch(/HTTP 400/u);
    expect(resultado.failure.status).toBe(400);
  });

  it('nem quando o corpo não é o envelope da v3', async () => {
    // O ramo mais perigoso do `parseBlingFailure`: corpo que não casa com o
    // envelope vira os primeiros 300 caracteres crus como mensagem. Uma página
    // de erro de proxy entraria inteira na resposta.
    fake.programar({ status: 502, body: '<html>nginx: upstream 10.0.3.14:8080 falhou</html>' });

    const resultado = await adapter().obterSituacoesDePedidoDeVenda();

    if (resultado._tag !== 'BlingFailed') throw new Error('esperava falha');
    expect(resultado.failure.message).not.toMatch(/nginx|10\.0\.3\.14|html/iu);
    expect(resultado.failure.message).toMatch(/indisponível/iu);
  });

  it('lista inteira descartada não vira sucesso vazio', async () => {
    // O contrário faria a compensação dizer "a conta não tem Cancelado" para
    // uma resposta que o ORBITA simplesmente não soube ler.
    fake.programar(json(200, MODULOS), json(200, { data: [{ situacao: 'Cancelado' }] }));

    const resultado = await adapter().obterSituacoesDePedidoDeVenda();

    if (resultado._tag !== 'BlingFailed') throw new Error('esperava falha');
    expect(resultado.failure.message).toMatch(/formato/iu);
    expect(resultado.failure.message).not.toMatch(/na conta do Bling/iu);
  });

  it('o teto vale para a operação inteira, não só para o `fetch`', async () => {
    // O achado da revisão: `AbortSignal` de `fetch` não limita a leitura da
    // credencial, a fila do rate limit, o backoff de 429 nem a renovação de
    // token — que faz *polling* de até 30 s. Aqui **nenhum** `fetch` é lento:
    // quem demora é o passo anterior a ele. Se o prazo valesse só para o
    // `fetch`, isto esperaria a demora inteira.
    const original = BlingClient.TEMPO_LIMITE_SITUACOES_MS;
    Object.defineProperty(BlingClient, 'TEMPO_LIMITE_SITUACOES_MS', { value: 60, configurable: true });
    fake.programar(json(200, MODULOS), json(200, SITUACOES));

    const cliente = BlingClient.forOrganization(`${ORG}-${Math.random()}`);
    Object.defineProperty(cliente, 'getAccessToken', {
      value: async () => {
        await new Promise((r) => setTimeout(r, 2000));
        return 'token-de-teste';
      },
      configurable: true,
    });

    try {
      const comecou = Date.now();
      const resultado = await cliente.obterSituacoesDePedidoDeVenda();
      const decorrido = Date.now() - comecou;

      if (resultado._tag !== 'BlingFailed') throw new Error('esperava falha');
      expect(decorrido).toBeLessThan(1000);
      expect(fake.recebidas).toHaveLength(0);
    } finally {
      Object.defineProperty(BlingClient, 'TEMPO_LIMITE_SITUACOES_MS', { value: original, configurable: true });
    }
  });

  it('tem teto de tempo: um Bling que não responde vira falha, não espera', async () => {
    const original = BlingClient.TEMPO_LIMITE_SITUACOES_MS;
    // O teto real é de 20 s. O teste não espera 20 s para provar que ele existe.
    Object.defineProperty(BlingClient, 'TEMPO_LIMITE_SITUACOES_MS', { value: 60, configurable: true });
    fake.programar({ status: 200, body: JSON.stringify(MODULOS), atrasoMs: 400 });

    try {
      const comecou = Date.now();
      const resultado = await adapter().obterSituacoesDePedidoDeVenda();
      const decorrido = Date.now() - comecou;

      if (resultado._tag !== 'BlingFailed') throw new Error('esperava falha');
      expect(resultado.failure.message).toMatch(/Conectar APIs/iu);
      // Sem esta asserção o teste passaria mesmo sem teto nenhum: bastaria o
      // servidor responder depois e a leitura falhar por outro motivo. O que
      // prova o teto é ter desistido **antes** de a resposta chegar.
      expect(decorrido).toBeLessThan(300);
    } finally {
      Object.defineProperty(BlingClient, 'TEMPO_LIMITE_SITUACOES_MS', { value: original, configurable: true });
    }
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
    expect(resultado.failure.message).not.toMatch(/transição não permitida/iu);
    expect(resultado.failure.message).toMatch(/cancelar o pedido/iu);
  });
});
