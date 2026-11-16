import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';

import { executarTriagem } from './triagemDoCaso';
import { criarModeloFalso, criarModeloGemini, criarModeloPorAiSdk, MODELO_GEMINI_APROVADO } from './modelosDeTriagem';

const TRIAGEM = {
  versao: 1, intencao: 'troca_ou_devolucao', motivo: 'Quer trocar o tamanho.', confianca: 'media', numeroDoPedido: null,
  resolucaoPedida: 'troca', entidades: [{ tipo: 'tamanho', valor: 'M' }], informacoesFaltando: ['número do pedido'],
  proximaPergunta: 'Qual o número do pedido?', precisaDeHumano: false, motivoDoHumano: null,
};

type Resultado = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

function resultado(texto: string, finish: 'stop' | 'content-filter' = 'stop'): Resultado {
  return {
    content: texto === '' ? [] : [{ type: 'text', text: texto }],
    finishReason: { unified: finish, raw: finish === 'stop' ? 'STOP' : 'SAFETY' },
    usage: { inputTokens: { total: 200, noCache: 200, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 60, text: 60, reasoning: 0 } },
    warnings: [],
  } as unknown as Resultado;
}

const modeloQue = (doGenerate: MockLanguageModelV4['doGenerate']) =>
  criarModeloPorAiSdk(new MockLanguageModelV4({ doGenerate }), { provedor: 'teste', modelo: 'mock' });

const pedido = () => ({ instrucoes: 'i', conteudo: 'c', sinal: AbortSignal.timeout(1000) });

describe('criarModeloPorAiSdk: o provedor traduzido para o domínio', () => {
  it('saída estruturada: objeto com o uso de tokens, pedindo JSON pelo schema da triagem', async () => {
    const mock = new MockLanguageModelV4({ doGenerate: async () => resultado(JSON.stringify(TRIAGEM)) });
    const resposta = await criarModeloPorAiSdk(mock, { provedor: 'teste', modelo: 'mock' }).gerar(pedido());
    expect(resposta).toEqual({ _tag: 'Objeto', valor: TRIAGEM, uso: { entrada: 200, saida: 60 } });
    const chamada = mock.doGenerateCalls[0];
    expect(chamada.responseFormat).toMatchObject({ type: 'json' });
    expect(JSON.stringify(chamada.responseFormat)).toContain('precisaDeHumano');
    expect(chamada.temperature).toBe(0);
  });

  it('JSON inválido ou fora do schema: inválido, com o uso gasto', async () => {
    expect(await modeloQue(async () => resultado('não sei')).gerar(pedido())).toEqual({ _tag: 'Invalido', uso: { entrada: 200, saida: 60 } });
    expect(await modeloQue(async () => resultado('{"intencao":"pizza"}')).gerar(pedido())).toMatchObject({ _tag: 'Invalido' });
  });

  it('filtro de conteúdo do provedor: recusa', async () => {
    expect(await modeloQue(async () => resultado('', 'content-filter')).gerar(pedido())).toMatchObject({ _tag: 'Recusa' });
  });

  it('429 com Retry-After: limite com o tempo pedido', async () => {
    const limite = modeloQue(async () => {
      throw new APICallError({ message: 'quota', url: 'https://x', requestBodyValues: {}, statusCode: 429, isRetryable: true,
        responseHeaders: { 'retry-after': '90' } });
    });
    expect(await limite.gerar(pedido())).toEqual({ _tag: 'Limite', repetirEmSegundos: 90 });
  });

  it('504, 500 e exceção qualquer: timeout ou erro do provedor, nunca objeto', async () => {
    const com = (status: number) => modeloQue(async () => {
      throw new APICallError({ message: 'x', url: 'https://x', requestBodyValues: {}, statusCode: status, isRetryable: true });
    });
    expect(await com(504).gerar(pedido())).toEqual({ _tag: 'Timeout' });
    expect(await com(500).gerar(pedido())).toEqual({ _tag: 'ErroDoProvedor' });
    expect(await modeloQue(async () => { throw new TypeError('rede'); }).gerar(pedido())).toEqual({ _tag: 'ErroDoProvedor' });
  });

  it('prazo vencido: timeout', async () => {
    const lento = modeloQue(async (opcoes) => new Promise((_, rejeitar) => {
      opcoes.abortSignal?.addEventListener('abort', () => rejeitar(opcoes.abortSignal?.reason));
    }));
    expect(await lento.gerar({ instrucoes: 'i', conteudo: 'c', sinal: AbortSignal.timeout(20) })).toEqual({ _tag: 'Timeout' });
  });

  it('ponta a ponta com o domínio: uma reparação e concluída', async () => {
    const respostas = [resultado('{"versao":1}'), resultado(JSON.stringify(TRIAGEM))];
    const modelo = modeloQue(async () => respostas.shift() ?? resultado(''));
    const desfecho = await executarTriagem([{ conteudo: 'Quero trocar por M', criadaEm: '2026-11-12T10:00:00Z' }], modelo, { timeoutMs: 1000 });
    expect(desfecho).toMatchObject({ status: 'concluida', reparos: 1, uso: { entrada: 400, saida: 120 } });
  });
});

describe('modelos configurados', () => {
  it('Gemini: só a família Flash aprovada', () => {
    expect(MODELO_GEMINI_APROVADO.test('gemini-2.5-flash')).toBe(true);
    expect(MODELO_GEMINI_APROVADO.test('gemini-3-flash-lite')).toBe(true);
    for (const aprovado of ['gemini-2.0-flash-001', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-preview-09-2025', 'gemini-3-flash-preview', 'gemini-3.5-flash']) {
      expect(MODELO_GEMINI_APROVADO.test(aprovado), aprovado).toBe(true);
    }
    // Da mesma família, mas não geram texto estruturado: configurá-los faria toda triagem falhar no provedor.
    for (const fora of ['gemini-2.5-flash-image', 'gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-native-audio-latest', 'gemini-3.1-flash-tts-preview']) {
      expect(MODELO_GEMINI_APROVADO.test(fora), fora).toBe(false);
    }
    expect(MODELO_GEMINI_APROVADO.test('gemini-2.5-pro')).toBe(false);
    expect(MODELO_GEMINI_APROVADO.test('gpt-5')).toBe(false);
    expect(() => criarModeloGemini({ chave: 'chave-de-teste', modelo: 'gemini-2.5-pro' })).toThrow(/fora da lista aprovada/u);
    expect(criarModeloGemini({ chave: 'chave-de-teste', modelo: 'gemini-2.5-flash' })).toMatchObject({ provedor: 'google', modelo: 'gemini-2.5-flash' });
  });

  it('o falso se declara falso e sempre manda ao atendente', async () => {
    const falso = criarModeloFalso();
    expect(falso.provedor).toBe('fake');
    const desfecho = await executarTriagem([{ conteudo: 'oi', criadaEm: '2026-11-12T10:00:00Z' }], falso, { timeoutMs: 1000 });
    expect(desfecho).toMatchObject({ status: 'concluida', triagem: { precisaDeHumano: true, confianca: 'baixa' } });
  });
});
