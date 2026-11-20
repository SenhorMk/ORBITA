import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { describe, expect, it } from 'vitest';
import { combinarProvedoresHaux, lerProvedoresHaux } from './provedoresHaux';
import { criarModeloHauxPorAiSdk } from './respostaAutomaticaHaux';
import { gerarResposta } from './gerarResposta';

const decisao = { acao: 'responder', abertura: 'boa_tarde', pergunta: 'como_ajudar' };
const contexto = async () => ({ marca: '1', intencao: 'outro', mensagens: [{ conteudo: 'Olá!', criadaEm: '2026-11-19T12:00:00Z' }] });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const groqOk = (valor: unknown = decisao) => json({ id: 'fixture', created: 1, model: 'openai/gpt-oss-20b',
  choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(valor) }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } });
const googleOk = () => json({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(decisao) }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 30, totalTokenCount: 50 } });

function rota(fetchGroq: typeof fetch, fetchGoogle: typeof fetch, parada?: AbortSignal, prazoTentativaMs = 1000) {
  return combinarProvedoresHaux(
    { provedor: 'groq', modelo: createGroq({ apiKey: 'fixture-key', fetch: fetchGroq })('openai/gpt-oss-20b') },
    { provedor: 'google', modelo: createGoogleGenerativeAI({ apiKey: 'fixture-key', fetch: fetchGoogle })('gemini-3.8-flash') },
    { parada, prazoTentativaMs });
}
const responder = (modelo: ReturnType<typeof rota>) => gerarResposta(contexto, criarModeloHauxPorAiSdk(modelo, 'groq+google'));

describe('roteamento Haux por contratos HTTP explícitos, sem chamadas externas', () => {
  it('usa uma chamada no principal com JSON Schema estrito e não chama fallback', async () => {
    let chamadas = 0;
    const modelo = rota(async (_url, init) => {
      chamadas++;
      const body = JSON.parse(String(init?.body));
      expect(body.response_format.json_schema.strict).toBe(true);
      expect(body.max_tokens ?? body.max_completion_tokens).toBe(160);
      return groqOk();
    }, async () => { throw new Error('Fallback indevido'); });
    expect(await responder(modelo)).toMatchObject({ estado: 'rascunho', texto: expect.stringContaining('Atendimento automatizado') });
    expect(chamadas).toBe(1);
  });
  it.each([401, 403, 404, 429, 503])('usa uma única alternativa após HTTP %s', async (status) => {
    const chamadas: string[] = [];
    const modelo = rota(async () => { chamadas.push('groq'); return json({ error: { message: 'fixture', type: 'fixture' } }, status); },
      async () => { chamadas.push('google'); return googleOk(); });
    expect(await responder(modelo)).toMatchObject({ estado: 'rascunho' });
    expect(chamadas).toEqual(['groq', 'google']);
  });
  it('encerra após dois provedores falharem, sem retry oculto', async () => {
    let chamadas = 0;
    const falhar = async () => { chamadas++; return json({ error: { message: 'fixture', status: 'UNAVAILABLE' } }, 503); };
    expect(await responder(rota(falhar, falhar))).toMatchObject({ estado: 'resposta_invalida' });
    expect(chamadas).toBe(2);
  });
  it('não tenta contornar uma requisição inválida com outro provedor', async () => {
    let fallback = 0;
    const modelo = rota(async () => json({ error: { message: 'fixture', type: 'invalid_request_error' } }, 400),
      async () => { fallback++; return googleOk(); });
    expect(await responder(modelo)).toMatchObject({ estado: 'resposta_invalida' });
    expect(fallback).toBe(0);
  });
  it('parada anterior e pedido comercial impedem qualquer chamada', async () => {
    let chamadas = 0;
    const contar = async () => { chamadas++; return groqOk(); };
    const parada = new AbortController();
    parada.abort();
    expect(await responder(rota(contar, contar, parada.signal))).toMatchObject({ estado: 'resposta_invalida' });
    const comercial = async () => ({ ...(await contexto()), mensagens: [{ conteudo: 'Qual o preço do produto?', criadaEm: '2026-11-19T12:00:00Z' }] });
    expect(await gerarResposta(comercial, criarModeloHauxPorAiSdk(rota(contar, contar), 'groq+google'))).toMatchObject({ estado: 'resposta_invalida' });
    expect(chamadas).toBe(0);
  });
  it.each([decisao, { ...decisao, acao: 'humano' }, { ...decisao, texto: 'Cura doenças e custa 10 reais.' }])(
    'não tenta outro modelo após decisão válida, handoff ou violação do schema: %j', async (valor) => {
      let fallback = 0;
      const resultado = await responder(rota(async () => groqOk(valor), async () => { fallback++; return googleOk(); }));
      expect(resultado.estado).toBe(valor === decisao ? 'rascunho' : 'resposta_invalida');
      expect(fallback).toBe(0);
    });
  it('não chama fallback se o desligamento acontecer durante o principal', async () => {
    const parada = new AbortController();
    let fallback = 0;
    const modelo = rota(async () => { parada.abort(); throw new DOMException('fixture', 'AbortError'); },
      async () => { fallback++; return googleOk(); }, parada.signal);
    expect(await responder(modelo)).toMatchObject({ estado: 'resposta_invalida' });
    expect(fallback).toBe(0);
  });
  it('timeout individual permite fallback dentro do prazo total', async () => {
    let fallback = 0;
    const modelo = rota(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }), async () => { fallback++; return googleOk(); }, undefined, 30);
    expect(await responder(modelo)).toMatchObject({ estado: 'rascunho' });
    expect(fallback).toBe(1);
  });
  it('configura dois provedores reais e aceita o nome de chave provisionado pelo titular', () => {
    const env = { GOOGLE_GENERATIVE_AI_API_KEY: 'fixture-google-not-a-secret', GROQ_AI_API_KEY: 'fixture-groq-not-a-secret', SAC_RESPOSTA_MODELO: 'gemini-3.8-flash' };
    expect(lerProvedoresHaux(env)).toMatchObject({ success: true, data: { HAUX_AI_PRIMARY: 'groq', GROQ_MODELO: 'openai/gpt-oss-20b' } });
    expect(lerProvedoresHaux({ ...env, GROQ_AI_API_KEY: '' }).success).toBe(false);
    expect(lerProvedoresHaux({ ...env, GROQ_MODELO: 'modelo-inventado' }).success).toBe(false);
  });
});
