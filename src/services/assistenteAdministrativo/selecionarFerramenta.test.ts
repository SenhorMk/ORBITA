import { afterEach, describe, expect, it, vi } from 'vitest';
import { aplicarTravaDeEstoqueRelativo, selecionarFerramenta } from './selecionarFerramenta';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Esquema = { anyOf?: Esquema[]; oneOf?: Esquema[]; properties?: Record<string, Esquema>; items?: Esquema; const?: unknown; enum?: unknown[] };

/**
 * Regra que a Groq aplica a cada `anyOf` no modo estrito (erro real em 24/11:
 * "anyOf disambiguation failed: discriminator: multiple candidate properties"):
 * precisa existir UMA propriedade, presente em todas as alternativas, cujos
 * valores (const/enum) não se repetem entre elas. A fixture abaixo recusa o
 * esquema quando isso falha, em vez de recusar só `oneOf`.
 */
function anyOfSemDiscriminador(esquema: Esquema, caminho = '$'): string[] {
  const falhas: string[] = [];
  if (esquema.anyOf) {
    const valores = (alt: Esquema, p: string) => {
      const prop = alt.properties?.[p];
      if (!prop) return null;
      if ('const' in prop) return [prop.const];
      return prop.enum ?? null;
    };
    const candidatas = Object.keys(esquema.anyOf[0]?.properties ?? {}).filter((p) => {
      const listas = esquema.anyOf!.map((alt) => valores(alt, p));
      if (listas.some((l) => l === null)) return false;
      const todos = listas.flat();
      return new Set(todos.map((v) => JSON.stringify(v))).size === todos.length;
    });
    if (candidatas.length !== 1) falhas.push(`${caminho}/anyOf (${candidatas.length} discriminadores)`);
    esquema.anyOf.forEach((alt, i) => falhas.push(...anyOfSemDiscriminador(alt, `${caminho}/anyOf/${i}`)));
  }
  for (const [nome, sub] of Object.entries(esquema.properties ?? {})) falhas.push(...anyOfSemDiscriminador(sub, `${caminho}/properties/${nome}`));
  if (esquema.items) falhas.push(...anyOfSemDiscriminador(esquema.items, `${caminho}/items`));
  return falhas;
}

function groqFalsa(respostaDoModelo: unknown, capturadas: Esquema[], corpos: { model: string; messages: { role: string; content: unknown }[] }[] = []) {
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const corpo = JSON.parse(String(init.body));
    corpos.push(corpo);
    const { schema, strict } = corpo.response_format.json_schema;
    capturadas.push(schema);
    const falhas = anyOfSemDiscriminador(schema);
    if (strict && (JSON.stringify(schema).includes('"oneOf"') || falhas.length > 0)) {
      return Response.json({ error: { message: 'invalid JSON schema for response_format: ' + falhas.join(', ') } }, { status: 400 });
    }
    return Response.json({
      id: 'chatcmpl-fixture', created: 1, model: 'openai/gpt-oss-20b',
      choices: [{ index: 0, finish_reason: 'stop', message: {
        role: 'assistant', content: JSON.stringify({ ferramenta: respostaDoModelo }),
      } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });
  });
}

describe('selecionarFerramenta: contrato enviado à Groq', () => {
  it.each([
    ['Quanto temos do SKU X?', { acao: 'consultar_estoque', referencia: 'X' }, { acao: 'consultar_estoque', referencia: 'X' }],
    ['Defina o estoque de todos os rapés para 5',
      { acao: 'editar_estoque', selecao: 'todos', por: 'categoria', referencia: 'rapé', valor: 5 },
      { acao: 'editar_produtos', campo: 'estoque', selecao: 'todos', por: 'categoria', referencia: 'rapé', valor: 5 }],
    ['Mude o nome do SKU RAP-1 para Rapé Premium',
      { acao: 'editar_nome', selecao: 'um', por: 'sku', referencia: 'RAP-1', valor: 'Rapé Premium' },
      { acao: 'editar_produtos', campo: 'nome', selecao: 'um', por: 'sku', referencia: 'RAP-1', valor: 'Rapé Premium' }],
    ['Troque a descrição do Kuripe Cobra para Kuripe de bambu',
      { acao: 'editar_descricao', selecao: 'um', por: 'nome', referencia: 'Kuripe Cobra', valor: 'Kuripe de bambu' },
      { acao: 'editar_produtos', campo: 'descricao', selecao: 'um', por: 'nome', referencia: 'Kuripe Cobra', valor: 'Kuripe de bambu' }],
    ['Chegaram 5 tepis, retire 2 do RAP-1 e deixe o kuripe em 10',
      { acao: 'estoque_em_lote', itens: [
        { referencia: 'tepi', operacao: 'somar', quantidade: 5 },
        { referencia: 'RAP-1', operacao: 'subtrair', quantidade: 2 },
        { referencia: 'kuripe', operacao: 'definir', quantidade: 10 }] },
      { acao: 'estoque_em_lote', itens: [
        { referencia: 'tepi', operacao: 'somar', quantidade: 5 },
        { referencia: 'RAP-1', operacao: 'subtrair', quantidade: 2 },
        { referencia: 'kuripe', operacao: 'definir', quantidade: 10 }] }],
  ])('%s: esquema aceito e resposta convertida ao contrato interno', async (pergunta, doModelo, interno) => {
    vi.stubEnv('GROQ_API_KEY', 'fixture-do-contrato-groq');
    const capturadas: Esquema[] = [];
    groqFalsa(doModelo, capturadas);
    await expect(selecionarFerramenta(pergunta, '2026-11-24', new AbortController().signal)).resolves.toEqual(interno);
    expect(capturadas).toHaveLength(1);
    expect(anyOfSemDiscriminador(capturadas[0])).toEqual([]);
  });

  it('um lote vazio ou com mais de 20 itens devolvido pelo modelo é recusado (falha fechada)', async () => {
    vi.stubEnv('GROQ_API_KEY', 'fixture-do-contrato-groq');
    const item = { referencia: 'tepi', operacao: 'somar', quantidade: 1 };
    for (const itens of [[], Array.from({ length: 21 }, () => item)]) {
      groqFalsa({ acao: 'estoque_em_lote', itens }, []);
      await expect(selecionarFerramenta('Adicione 1 tepi', '2026-11-24', new AbortController().signal)).rejects.toThrow();
    }
  });

  it('usa o modelo maior e envia as trocas anteriores antes da pergunta atual', async () => {
    vi.stubEnv('GROQ_API_KEY', 'fixture-do-contrato-groq');
    const corpos: Parameters<typeof groqFalsa>[2] = [];
    groqFalsa({ acao: 'consultar_estoque', referencia: 'cacau' }, [], corpos);
    const historico = [{ pergunta: 'Quanto tem do tepi?', resposta: 'Tepi de Bambu tem 10 unidades disponíveis.' }];
    await selecionarFerramenta('E do cacau?', '2026-11-26', new AbortController().signal, historico);
    expect(corpos[0].model).toBe('openai/gpt-oss-120b');
    const conversa = corpos[0].messages.filter(m => m.role !== 'system').map(m => [m.role, JSON.stringify(m.content)]);
    expect(conversa).toHaveLength(3);
    expect(conversa.map(([papel]) => papel)).toEqual(['user', 'assistant', 'user']);
    expect(conversa[0][1]).toContain('Quanto tem do tepi?');
    expect(conversa[1][1]).toContain('10 unidades');
    expect(conversa[2][1]).toContain('E do cacau?');
  });

  it('o detector reproduz a recusa da Groq para uma união aninhada sem discriminador único', () => {
    const ambigua: Esquema = { anyOf: [{ anyOf: [
      { properties: { acao: { const: 'editar' }, campo: { const: 'estoque' }, por: { enum: ['sku', 'nome'] } } },
      { properties: { acao: { const: 'editar' }, campo: { const: 'nome' }, por: { enum: ['sku', 'nome'] } } },
    ], properties: {} }, { properties: { acao: { const: 'consultar' } } }] };
    expect(anyOfSemDiscriminador({ properties: { ferramenta: ambigua } })).not.toEqual([]);
  });
});

describe('trava de estoque relativo', () => {
  const editar = { acao: 'editar_produtos', campo: 'estoque', selecao: 'um', por: 'nome', referencia: 'Rapé', valor: 3 } as const;

  it.each([
    'Aumente em 3 o estoque do Rapé Sansara', 'Adicione 5 unidades ao Rapé', 'Some 2 no estoque do kuripe',
    'Diminua o estoque do Rapé em 1', 'Retire 4 do estoque', 'Baixe 2 unidades do Rapé', 'Coloque mais 3 no Rapé',
    'Reponha 10 unidades do Rapé', 'Tire 1 do estoque do Rapé',
  ])('"%s" vira esclarecer', (pergunta) => {
    expect(aplicarTravaDeEstoqueRelativo(editar, pergunta)).toEqual({ acao: 'esclarecer' });
  });

  it.each(['Defina o estoque do Rapé para 3', 'Altere o estoque do Rapé Sansara para 10 unidades', 'Zere o estoque do Rapé'])(
    '"%s" (valor absoluto) segue como edição', (pergunta) => {
      expect(aplicarTravaDeEstoqueRelativo(editar, pergunta)).toEqual(editar);
    });

  it('não interfere em nome, descrição nem consultas', () => {
    const nome = { ...editar, campo: 'nome', valor: 'Mais 3 sabores' } as const;
    expect(aplicarTravaDeEstoqueRelativo(nome, 'Mude o nome para Mais 3 sabores')).toEqual(nome);
    expect(aplicarTravaDeEstoqueRelativo({ acao: 'estoque_baixo', limite: 5 }, 'estoque baixo, aumente o limite')).toEqual({ acao: 'estoque_baixo', limite: 5 });
  });
});
