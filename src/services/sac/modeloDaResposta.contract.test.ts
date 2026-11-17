import { expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  select: vi.fn((modelo: string) => modelo),
  generate: vi.fn(async () => ({ output: { texto: 'Resposta sintética da prova de contrato.' } })),
}));

vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: () => sdk.select }));
vi.mock('ai', () => ({
  generateText: sdk.generate,
  Output: { object: (valor: unknown) => valor },
  NoObjectGeneratedError: { isInstance: () => false },
}));

import { gerarResposta } from './gerarResposta';
import { modeloDaResposta } from './modeloDaResposta';

it('seleciona o modelo Flash explicitamente e chama o SDK com prazo, schema e limite de saída', async () => {
  const modelo = modeloDaResposta({
    SAC_RESPOSTA_PROVEDOR: 'google', SAC_RESPOSTA_MODELO: 'gemini-2.5-flash',
    SAC_RESPOSTA_GEMINI_AUTORIZADO: 'true', GOOGLE_GENERATIVE_AI_API_KEY: 'fixture-local',
  });
  if (!modelo) throw new Error('Modelo de contrato não inicializado.');
  const c = { marca: 'versao-1', intencao: 'outro', mensagens: [{ conteudo: 'Olá', criadaEm: '2026-11-17T10:00:00Z' }] };
  await expect(gerarResposta(async () => c, modelo)).resolves.toMatchObject({ estado: 'rascunho', provedor: 'google' });
  expect(sdk.select).toHaveBeenCalledExactlyOnceWith('gemini-2.5-flash');
  expect(sdk.generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    model: 'gemini-2.5-flash', maxRetries: 0, maxOutputTokens: 640,
    output: { schema: expect.any(Object) }, abortSignal: expect.any(AbortSignal),
  }));
});
