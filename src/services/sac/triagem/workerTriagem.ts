import crypto from 'node:crypto';
import { z } from 'zod';

import { logger, sanitizeErrorForLog } from '../../../lib/observability/logger';
import { esperar } from '../../chatwoot/workerInboxChatwoot';

import { consumirTriagensUmaVez, type PortaDoConsumidorTriagem } from './consumidorTriagem';
import { criarModeloFalso, criarModeloGemini, MODELO_GEMINI_APROVADO } from './modelosDeTriagem';
import type { ModeloDeTriagem } from './triagemDoCaso';

/**
 * Configuração do worker de triagem (MSG-013). Começa desligado: sem
 * `SAC_TRIAGEM_WORKER_ENABLED=true` nada é reivindicado e as triagens ficam
 * na fila, visíveis como pendentes no cockpit (é a triagem manual). O limite
 * diário por organização começa em 0: ligado sem limite, todo caso fica com o
 * atendente por falta de orçamento, sem chamar o modelo. Até o MSG-021, só
 * dados sintéticos.
 */
const ConfiguracaoSchema = z.object({
  SAC_TRIAGEM_WORKER_ENABLED: z.enum(['true', 'false']).default('false'),
  SAC_TRIAGEM_PROVEDOR: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['google', 'fake']).optional()),
  SAC_TRIAGEM_MODELO: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(MODELO_GEMINI_APROVADO).optional()),
  GOOGLE_GENERATIVE_AI_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(20).optional()),
  SAC_TRIAGEM_LIMITE_DIARIO_POR_ORGANIZACAO: z.coerce.number().int().min(0).max(100_000).default(0),
  SAC_TRIAGEM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(20_000),
  // Maior que duas chamadas com timeout, com folga para gravar o desfecho.
  SAC_TRIAGEM_LEASE_SECONDS: z.coerce.number().int().min(30).max(600).default(120),
  SAC_TRIAGEM_BATCH: z.coerce.number().int().min(1).max(20).default(5),
  SAC_TRIAGEM_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(2_000),
  SAC_TRIAGEM_IDLE_MAX_MS: z.coerce.number().int().min(100).max(60_000).default(15_000),
});

export interface ConfiguracaoDoWorkerTriagem {
  readonly ligado: boolean;
  readonly modelo: ModeloDeTriagem | null;
  readonly limiteDiario: number;
  readonly timeoutMs: number;
  readonly leaseSegundos: number;
  readonly lote: number;
  readonly pollMs: number;
  readonly ociosoMaxMs: number;
}

/** Ligado exige provedor; `google` exige modelo aprovado e chave. Erro de configuração para o processo. */
export function lerConfiguracaoDoWorkerTriagem(ambiente: Readonly<Record<string, string | undefined>>): ConfiguracaoDoWorkerTriagem {
  const lido = ConfiguracaoSchema.safeParse(ambiente);
  if (!lido.success) {
    throw new Error(`Configuração do worker de triagem inválida: ${lido.error.issues.map((i) => i.path.join('.')).join(', ')}.`);
  }
  const c = lido.data;
  const ligado = c.SAC_TRIAGEM_WORKER_ENABLED === 'true';
  let modelo: ModeloDeTriagem | null = null;
  if (ligado) {
    if (c.SAC_TRIAGEM_PROVEDOR === undefined) throw new Error('Worker de triagem ligado sem SAC_TRIAGEM_PROVEDOR.');
    if (c.SAC_TRIAGEM_PROVEDOR === 'fake') {
      modelo = criarModeloFalso();
    } else {
      if (!c.SAC_TRIAGEM_MODELO || !c.GOOGLE_GENERATIVE_AI_API_KEY) {
        throw new Error('Triagem pelo Google exige SAC_TRIAGEM_MODELO e GOOGLE_GENERATIVE_AI_API_KEY.');
      }
      modelo = criarModeloGemini({ chave: c.GOOGLE_GENERATIVE_AI_API_KEY, modelo: c.SAC_TRIAGEM_MODELO });
    }
  }
  return {
    ligado,
    modelo,
    limiteDiario: c.SAC_TRIAGEM_LIMITE_DIARIO_POR_ORGANIZACAO,
    timeoutMs: c.SAC_TRIAGEM_TIMEOUT_MS,
    leaseSegundos: Math.max(c.SAC_TRIAGEM_LEASE_SECONDS, Math.ceil((2 * c.SAC_TRIAGEM_TIMEOUT_MS) / 1000) + 15),
    lote: c.SAC_TRIAGEM_BATCH,
    pollMs: c.SAC_TRIAGEM_POLL_MS,
    ociosoMaxMs: Math.max(c.SAC_TRIAGEM_IDLE_MAX_MS, c.SAC_TRIAGEM_POLL_MS),
  };
}

/** O laço do processo, como o do envio: polling com trabalho, recuo sem trabalho ou com o banco fora. */
export async function executarWorkerTriagem(
  porta: PortaDoConsumidorTriagem,
  configuracao: ConfiguracaoDoWorkerTriagem,
  sinal: AbortSignal,
  aoBater: () => void = () => {},
): Promise<void> {
  const { modelo } = configuracao;
  if (!configuracao.ligado || modelo === null) {
    logger.warn('sac.triagem.worker_desligado', { subsystem: 'queue' });
    return;
  }
  const workerId = `triagem-worker_${crypto.randomUUID()}`;
  logger.info('sac.triagem.worker_iniciado', {
    subsystem: 'queue', workerId, provedor: modelo.provedor, modelo: modelo.modelo, limiteDiario: configuracao.limiteDiario,
  });
  let espera = configuracao.pollMs;
  while (!sinal.aborted) {
    aoBater();
    try {
      const resumo = await consumirTriagensUmaVez(porta, modelo, {
        workerId,
        limite: configuracao.lote,
        leaseSegundos: configuracao.leaseSegundos,
        limiteDiario: configuracao.limiteDiario,
        timeoutMs: configuracao.timeoutMs,
        deveParar: () => { aoBater(); return sinal.aborted; },
      });
      espera = resumo.reivindicados > 0 ? configuracao.pollMs : Math.min(espera * 2, configuracao.ociosoMaxMs);
      if (resumo.reivindicados > 0 || resumo.reaped > 0) logger.info('sac.triagem.passada', { subsystem: 'queue', workerId, ...resumo });
    } catch (error: unknown) {
      espera = configuracao.ociosoMaxMs;
      logger.error('sac.triagem.passada_falhou', { subsystem: 'queue', workerId, erro: sanitizeErrorForLog(error) });
    }
    await esperar(espera, sinal);
  }
  logger.info('sac.triagem.worker_parado', { subsystem: 'queue', workerId });
}
