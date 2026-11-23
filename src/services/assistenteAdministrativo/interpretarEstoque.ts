import { generateText, Output } from 'ai';
import { createGroq } from '@ai-sdk/groq';
import { z } from 'zod';
import { combinarProvedoresHaux } from '../sac/provedoresHaux';

export const pedidoDeEstoque = z.object({ pergunta: z.string().trim().min(4).max(240) }).strict();
export const intencaoDeEstoque = z.object({
  acao: z.enum(['consultar', 'alterar', 'esclarecer']),
  produto: z.string().trim().max(120),
});

export async function interpretarPerguntaDeEstoque(pergunta: string, sinal: AbortSignal) {
  const chave = process.env.GROQ_API_KEY || process.env.GROQ_AI_API_KEY;
  if (!chave) throw new Error('Groq indisponível.');
  const modelo = createGroq({ apiKey: chave })('openai/gpt-oss-20b');
  const resultado = await generateText({
    model: combinarProvedoresHaux({ provedor: 'groq', modelo }, undefined),
    abortSignal: sinal,
    maxRetries: 0,
    maxOutputTokens: 350,
    output: Output.object({ schema: intencaoDeEstoque }),
    system: 'Interprete uma pergunta de estoque em português. consultar: pede saldo de um produto e identifica nome ou SKU. alterar: qualquer pedido de baixa, ajuste ou outra escrita, mesmo junto de consulta. esclarecer: falta produto, ou pergunta fora de estoque. Retorne somente a ação e o nome ou SKU literal citado na pergunta. Use produto vazio quando não houver referência. Nunca invente produtos.',
    prompt: pergunta,
  });
  return resultado.output;
}
