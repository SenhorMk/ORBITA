/**
 * Os modelos que a triagem (MSG-013) pode usar.
 *
 * - `criarModeloPorAiSdk`: qualquer modelo de linguagem do AI SDK, com saída
 *   estruturada pelo schema da triagem. Traduz os erros do provedor para as
 *   respostas do domínio: 429 é limite, prazo vencido é timeout, filtro de
 *   conteúdo é recusa, JSON fora do schema é inválido. Não repete chamadas:
 *   quem repete é a fila, com orçamento.
 * - `criarModeloGemini`: o caminho inicial, Gemini pela API do Google.
 * - `criarModeloFalso`: declarado como falso (`provedor: 'fake'`) e sempre
 *   manda o caso ao atendente. Serve para ligar o fluxo sem chave; nunca se
 *   passa por IA real.
 */
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { APICallError, generateText, NoObjectGeneratedError, Output, type LanguageModel } from 'ai';

import { TriagemV1Schema, type TriagemV1 } from '../../../lib/integrations/contratoDaTriagem';

import type { ModeloDeTriagem, RespostaDoModelo, UsoDoModelo } from './triagemDoCaso';

/**
 * Modelos aprovados para a triagem: só os de texto da família Flash do Gemini,
 * estáveis (`gemini-2.5-flash`), com revisão (`-001`) ou prévia
 * (`-preview`, `-preview-09-2025`). Variantes de imagem, voz e áudio
 * (`-image`, `-tts`, `-native-audio-*`) não geram o objeto da triagem e ficam
 * fora. Outro modelo exige mudar o código.
 */
export const MODELO_GEMINI_APROVADO = /^gemini-[0-9]+(?:\.[0-9]+)?-flash(?:-lite)?(?:-[0-9]{3}|-preview(?:-[0-9]{2}-[0-9]{4})?)?$/u;

interface UsoDoAiSdk {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
}

const usoDe = (uso: UsoDoAiSdk | undefined): UsoDoModelo => ({
  entrada: typeof uso?.inputTokens === 'number' ? uso.inputTokens : null,
  saida: typeof uso?.outputTokens === 'number' ? uso.outputTokens : null,
});

function segundosDoRetryAfter(erro: APICallError): number | null {
  const valor = erro.responseHeaders?.['retry-after'];
  const segundos = valor === undefined ? Number.NaN : Number(valor);
  return Number.isFinite(segundos) && segundos >= 0 ? Math.min(segundos, 3600) : null;
}

function respostaDoErro(erro: unknown, sinal: AbortSignal): RespostaDoModelo {
  if (NoObjectGeneratedError.isInstance(erro)) {
    return erro.finishReason === 'content-filter' ? { _tag: 'Recusa', uso: usoDe(erro.usage) } : { _tag: 'Invalido', uso: usoDe(erro.usage) };
  }
  if (APICallError.isInstance(erro)) {
    if (erro.statusCode === 429) return { _tag: 'Limite', repetirEmSegundos: segundosDoRetryAfter(erro) };
    if (erro.statusCode === 408 || erro.statusCode === 504) return { _tag: 'Timeout' };
    return { _tag: 'ErroDoProvedor' };
  }
  if (sinal.aborted || (erro instanceof Error && (erro.name === 'TimeoutError' || erro.name === 'AbortError'))) return { _tag: 'Timeout' };
  return { _tag: 'ErroDoProvedor' };
}

export function criarModeloPorAiSdk(modelo: LanguageModel, identificacao: { readonly provedor: string; readonly modelo: string }): ModeloDeTriagem {
  return {
    ...identificacao,
    async gerar({ instrucoes, conteudo, sinal }) {
      try {
        const resultado = await generateText({
          model: modelo,
          system: instrucoes,
          prompt: conteudo,
          output: Output.object({ schema: TriagemV1Schema }),
          temperature: 0,
          maxRetries: 0,
          maxOutputTokens: 640,
          abortSignal: sinal,
        });
        if (resultado.finishReason === 'content-filter') return { _tag: 'Recusa', uso: usoDe(resultado.usage) };
        return { _tag: 'Objeto', valor: resultado.output, uso: usoDe(resultado.usage) };
      } catch (erro: unknown) {
        return respostaDoErro(erro, sinal);
      }
    },
  };
}

export function criarModeloGemini(configuracao: { readonly chave: string; readonly modelo: string }): ModeloDeTriagem {
  if (!MODELO_GEMINI_APROVADO.test(configuracao.modelo)) {
    throw new Error('Modelo de triagem fora da lista aprovada.');
  }
  const google = createGoogleGenerativeAI({ apiKey: configuracao.chave });
  return criarModeloPorAiSdk(google(configuracao.modelo), { provedor: 'google', modelo: configuracao.modelo });
}

const TRIAGEM_DO_MODELO_FALSO: TriagemV1 = {
  versao: 1,
  intencao: 'outro',
  motivo: 'Triagem feita pelo modelo falso: nenhuma IA real está configurada.',
  confianca: 'baixa',
  numeroDoPedido: null,
  resolucaoPedida: 'nao_informada',
  entidades: [],
  informacoesFaltando: [],
  proximaPergunta: null,
  precisaDeHumano: true,
  motivoDoHumano: 'Modelo falso: o atendente precisa ler a conversa.',
};

export function criarModeloFalso(): ModeloDeTriagem {
  return {
    provedor: 'fake',
    modelo: 'falso-v1',
    async gerar() {
      return { _tag: 'Objeto', valor: TRIAGEM_DO_MODELO_FALSO, uso: { entrada: 0, saida: 0 } };
    },
  };
}
