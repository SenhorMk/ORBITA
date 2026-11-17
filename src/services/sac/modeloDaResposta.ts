import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText, NoObjectGeneratedError, Output } from 'ai';

import { RascunhoSchema, type ModeloDeResposta } from './gerarResposta';
import { MODELO_GEMINI_APROVADO } from './triagem/modelosDeTriagem';

export function modeloDaResposta(env: Readonly<Record<string, string | undefined>>): ModeloDeResposta | null {
  if (env.SAC_RESPOSTA_PROVEDOR === 'fake') {
    return {
      provedor: 'fake',
      async gerar(_instrucoes, entrada) {
        return { texto: /pedido|entrega|rastre/iu.test(entrada)
          ? 'Olá! Posso ajudar a verificar o seu pedido. Você pode me informar o número do pedido, sem incluir dados pessoais?'
          : 'Olá! Obrigado pela mensagem. Pode me contar o que aconteceu e como podemos ajudar?' };
      },
    };
  }
  const chave = env.GOOGLE_GENERATIVE_AI_API_KEY;
  const modelo = env.SAC_RESPOSTA_MODELO;
  if (env.SAC_RESPOSTA_PROVEDOR !== 'google' || env.SAC_RESPOSTA_GEMINI_AUTORIZADO !== 'true'
    || !chave || !modelo || !MODELO_GEMINI_APROVADO.test(modelo)) return null;
  const google = createGoogleGenerativeAI({ apiKey: chave });
  return {
    provedor: 'google',
    async gerar(system, prompt, abortSignal) {
      try {
        const resultado = await generateText({
          model: google(modelo), system, prompt, abortSignal,
          output: Output.object({ schema: RascunhoSchema }), maxRetries: 0, maxOutputTokens: 640,
        });
        return resultado.output;
      } catch (erro) {
        if (NoObjectGeneratedError.isInstance(erro) && erro.finishReason !== 'content-filter') return null;
        throw erro;
      }
    },
  };
}
