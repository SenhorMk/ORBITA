import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { APICallError, wrapLanguageModel } from 'ai';
import { z } from 'zod';
import { logger } from '../../lib/observability/logger';
import { criarModeloPorAiSdk, MODELO_GEMINI_APROVADO } from './triagem/modelosDeTriagem';

export const ConfiguracaoProvedoresHaux = z.object({
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(20),
  GROQ_API_KEY: z.string().min(20),
  SAC_RESPOSTA_MODELO: z.string().regex(MODELO_GEMINI_APROVADO),
  GROQ_MODELO: z.literal('openai/gpt-oss-20b').default('openai/gpt-oss-20b'),
  HAUX_AI_PRIMARY: z.enum(['groq', 'google']).default('groq'),
});

export function lerProvedoresHaux(env: Readonly<Record<string, string | undefined>>) {
  return ConfiguracaoProvedoresHaux.safeParse({ ...env, GROQ_API_KEY: env.GROQ_API_KEY || env.GROQ_AI_API_KEY });
}

type Modelo = ReturnType<typeof wrapLanguageModel>;
export interface ProvedorHaux {
  readonly provedor: 'groq' | 'google';
  readonly modelo: Modelo;
}

function permiteFallback(erro: unknown): boolean {
  if (APICallError.isInstance(erro)) {
    const status = erro.statusCode;
    return status === undefined || [401, 403, 404, 408, 429].includes(status) || status >= 500;
  }
  return erro instanceof Error && ['TimeoutError', 'AbortError', 'TypeError'].includes(erro.name);
}

/** Two bounded attempts; never repeat a semantic refusal or invalid model output. */
export function combinarProvedoresHaux(principal: ProvedorHaux, fallback?: ProvedorHaux,
  opcoes: { readonly parada?: AbortSignal; readonly prazoTentativaMs?: number } = {}) {
  return wrapLanguageModel({ model: principal.modelo, providerId: fallback ? `${principal.provedor}+${fallback.provedor}` : principal.provedor,
    middleware: { specificationVersion: 'v4',
      async wrapGenerate({ params }) {
        const provedores = fallback ? [principal, fallback] : [principal];
        for (const [indice, atual] of provedores.entries()) {
          const sinais = [params.abortSignal, opcoes.parada].filter((s): s is AbortSignal => s !== undefined);
          const externo = sinais.length ? AbortSignal.any(sinais) : undefined;
          externo?.throwIfAborted();
          const prazo = AbortSignal.timeout(opcoes.prazoTentativaMs ?? 6000);
          const abortSignal = AbortSignal.any([prazo, ...sinais]);
          const inicio = Date.now();
          logger.info('haux.modelo.tentativa', { subsystem: 'provider', provedor: atual.provedor, modelo: atual.modelo.modelId, tentativa: indice + 1 });
          try {
            const resultado = await atual.modelo.doGenerate({ ...params, abortSignal,
              providerOptions: { ...params.providerOptions,
                google: { thinkingConfig: { thinkingLevel: 'low' } },
                groq: { structuredOutputs: true, strictJsonSchema: true, reasoningEffort: 'low' } } });
            logger.info('haux.modelo.concluido', { subsystem: 'provider', provedor: atual.provedor,
              modelo: atual.modelo.modelId, tentativa: indice + 1, finishReason: resultado.finishReason.unified,
              usoEntrada: resultado.usage.inputTokens.total, usoSaida: resultado.usage.outputTokens.total, latenciaMs: Date.now() - inicio });
            return resultado;
          } catch (erro: unknown) {
            const status = APICallError.isInstance(erro) ? erro.statusCode : undefined;
            logger.warn('haux.modelo.tentativa_falhou', { subsystem: 'provider', provedor: atual.provedor,
              modelo: atual.modelo.modelId, tentativa: indice + 1, status,
              outcome: externo?.aborted ? 'interrompida' : prazo.aborted ? 'timeout' : 'falha_tecnica' });
            if (externo?.aborted || indice + 1 === provedores.length || !permiteFallback(erro)) throw erro;
          }
        }
        throw new Error('Rota Haux sem provedor.');
      },
    },
  });
}

/** The smoke and operational worker share the same greeting classification. */
export function criarClassificadorHaux(rota: ReturnType<typeof criarRotaHaux>) {
  const modelo = criarModeloPorAiSdk(rota.modelo, { provedor: rota.provedor, modelo: rota.identificacao });
  return { ...modelo, gerar: (pedido: Parameters<typeof modelo.gerar>[0]) => modelo.gerar({ ...pedido,
    instrucoes: pedido.instrucoes + '\nClassifique a mensagem de maior ordem como atual; as anteriores são histórico. Um cumprimento ou agradecimento claro é intenção outro ou elogio_ou_agradecimento, confiança alta e não exige humano por ser curto. Não classifique assuntos sensíveis ou incertos como simples cumprimento.' }) };
}

export function criarRotaHaux(config: z.infer<typeof ConfiguracaoProvedoresHaux>, parada?: AbortSignal,
  somente?: 'google' | 'groq') {
  const google: ProvedorHaux = { provedor: 'google', modelo: createGoogleGenerativeAI({ apiKey: config.GOOGLE_GENERATIVE_AI_API_KEY })(config.SAC_RESPOSTA_MODELO) };
  const groq: ProvedorHaux = { provedor: 'groq', modelo: createGroq({ apiKey: config.GROQ_API_KEY })(config.GROQ_MODELO) };
  const principal = (somente ?? config.HAUX_AI_PRIMARY) === 'groq' ? groq : google;
  const fallback = somente ? undefined : principal === groq ? google : groq;
  const provedor = somente ?? (config.HAUX_AI_PRIMARY === 'groq' ? 'groq+google' : 'google+groq');
  return { modelo: combinarProvedoresHaux(principal, fallback, { parada }), provedor,
    identificacao: fallback ? `${principal.modelo.modelId}|${fallback.modelo.modelId}` : principal.modelo.modelId } as const;
}
