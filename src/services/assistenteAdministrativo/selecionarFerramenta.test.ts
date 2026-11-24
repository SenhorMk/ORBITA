import { afterEach, expect, it, vi } from 'vitest';
import { selecionarFerramenta } from './selecionarFerramenta';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each([
  ['Quanto temos do SKU X?', { acao: 'consultar_estoque', referencia: 'X' }],
  ['Defina o estoque de todos os rapés para 5', {
    acao: 'editar_produtos', campo: 'estoque', selecao: 'todos', por: 'categoria', referencia: 'rapé', valor: 5,
  }],
])('envia à Groq um contrato compatível para %s', async (pergunta, ferramenta) => {
  vi.stubEnv('GROQ_API_KEY', 'fixture-do-contrato-groq');
  const capturadas: unknown[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const corpo = JSON.parse(String(init.body));
    const { schema, strict } = corpo.response_format.json_schema;
    capturadas.push(schema);
    if (strict && JSON.stringify(schema).includes('"oneOf"')) {
      return Response.json({ error: { message: 'Composição não suportada na fixture.' } }, { status: 400 });
    }
    return Response.json({
      id: 'chatcmpl-fixture', created: 1, model: 'openai/gpt-oss-20b',
      choices: [{ index: 0, finish_reason: 'stop', message: {
        role: 'assistant', content: JSON.stringify({ ferramenta }),
      } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });
  });
  await expect(selecionarFerramenta(pergunta, '2026-11-24', new AbortController().signal)).resolves.toEqual(ferramenta);
  expect(capturadas).toHaveLength(1);
  expect(JSON.stringify(capturadas[0])).toContain('"anyOf"');
});
