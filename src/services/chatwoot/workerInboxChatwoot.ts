import crypto from 'node:crypto';
import { z } from 'zod';
import { logger, sanitizeErrorForLog } from '../../lib/observability/logger';
import { consumirInboxUmaVez, type PortaDoConsumidorInbox } from './consumidorInboxChatwoot';

/**
 * Configuração do processo worker. O kill switch começa desligado: sem
 * `CHATWOOT_INBOX_WORKER_ENABLED=true` o processo não reivindica nada, e a
 * recepção continua gravando na inbox. Ligado, exige o corte do backlog: evento mais
 * antigo que ele fica parado até existir inventário e autorização.
 */
const ConfiguracaoSchema = z.object({
  CHATWOOT_INBOX_WORKER_ENABLED: z.enum(['true', 'false']).default('false'),
  CHATWOOT_INBOX_WORKER_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  CHATWOOT_INBOX_WORKER_IDLE_MAX_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  CHATWOOT_INBOX_WORKER_LEASE_SECONDS: z.coerce.number().int().min(5).max(300).default(60),
  CHATWOOT_INBOX_WORKER_BATCH: z.coerce.number().int().min(1).max(50).default(10),
  // Vazio (como no .env de modelo) é ausência: o worker desligado tem de subir.
  CHATWOOT_INBOX_WORKER_BACKLOG_DESDE: z.preprocess((v) => (v === '' ? undefined : v), z.string().datetime({ offset: true }).optional()),
});

export interface ConfiguracaoDoWorkerInbox {
  readonly ligado: boolean;
  readonly recebidosDesde: string | null;
  readonly pollMs: number;
  readonly ociosoMaxMs: number;
  readonly leaseSegundos: number;
  readonly lote: number;
}

export function lerConfiguracaoDoWorkerInbox(ambiente: Readonly<Record<string, string | undefined>>): ConfiguracaoDoWorkerInbox {
  const lido = ConfiguracaoSchema.parse(ambiente);
  const ligado = lido.CHATWOOT_INBOX_WORKER_ENABLED === 'true';
  if (ligado && !lido.CHATWOOT_INBOX_WORKER_BACKLOG_DESDE) {
    throw new Error('Worker da inbox ligado sem CHATWOOT_INBOX_WORKER_BACKLOG_DESDE: o backlog antigo exige autorização.');
  }
  return {
    ligado,
    recebidosDesde: lido.CHATWOOT_INBOX_WORKER_BACKLOG_DESDE ?? null,
    pollMs: lido.CHATWOOT_INBOX_WORKER_POLL_MS,
    ociosoMaxMs: Math.max(lido.CHATWOOT_INBOX_WORKER_IDLE_MAX_MS, lido.CHATWOOT_INBOX_WORKER_POLL_MS),
    leaseSegundos: lido.CHATWOOT_INBOX_WORKER_LEASE_SECONDS,
    lote: lido.CHATWOOT_INBOX_WORKER_BATCH,
  };
}

/** Espera `ms` ou até o sinal de parada. */
export function esperar(ms: number, sinal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (sinal.aborted) {
      resolve();
      return;
    }
    const fim = () => {
      clearTimeout(timer);
      sinal.removeEventListener('abort', fim);
      resolve();
    };
    const timer = setTimeout(fim, ms);
    sinal.addEventListener('abort', fim);
  });
}

/**
 * O laço do processo: polling de `pollMs` com trabalho, recuo dobrando até
 * `ociosoMaxMs` sem trabalho ou com o banco fora. A parada não pega lote novo e
 * termina o evento em curso; o resto do lote fica para a lease vencer.
 */
export async function executarWorkerInbox(
  porta: PortaDoConsumidorInbox,
  configuracao: ConfiguracaoDoWorkerInbox,
  sinal: AbortSignal,
  /** Chamado a cada volta do laço: é o sinal de vida para a supervisão (MSG-020A). */
  aoBater: () => void = () => {},
): Promise<void> {
  const { recebidosDesde } = configuracao;
  if (!configuracao.ligado || recebidosDesde === null) {
    logger.warn('chatwoot.inbox.worker_desligado', { subsystem: 'queue' });
    return;
  }

  const workerId = `inbox-worker_${crypto.randomUUID()}`;
  logger.info('chatwoot.inbox.worker_iniciado', { subsystem: 'queue', workerId });
  let espera = configuracao.pollMs;
  while (!sinal.aborted) {
    aoBater();
    try {
      const resumo = await consumirInboxUmaVez(porta, {
        workerId,
        limite: configuracao.lote,
        leaseSegundos: configuracao.leaseSegundos,
        recebidosDesde,
        deveParar: () => sinal.aborted,
      });
      espera = resumo.reivindicados > 0 ? configuracao.pollMs : Math.min(espera * 2, configuracao.ociosoMaxMs);
      if (resumo.reivindicados > 0) logger.info('chatwoot.inbox.passada', { subsystem: 'queue', workerId, ...resumo });
    } catch (error: unknown) {
      espera = configuracao.ociosoMaxMs;
      logger.error('chatwoot.inbox.claim_falhou', { subsystem: 'queue', workerId, erro: sanitizeErrorForLog(error) });
    }
    await esperar(espera, sinal);
  }
  logger.info('chatwoot.inbox.worker_parado', { subsystem: 'queue', workerId });
}
