import crypto from 'node:crypto';
import { z } from 'zod';
import { logger, sanitizeErrorForLog } from '../../lib/observability/logger';
import { consumirEnviosUmaVez, type PortaDoConsumidorEnvio } from './consumidorEnvioChatwoot';
import { esperar } from './workerInboxChatwoot';

/**
 * Configuração do processo que despacha os envios ao Chatwoot (MSG-008). O
 * kill switch começa desligado: sem `CHATWOOT_SEND_WORKER_ENABLED=true` nada é
 * reivindicado, e o cockpit continua registrando intenções, que ficam
 * pendentes. Ligado, exige o corte: envio registrado antes dele fica parado até
 * existir inventário e autorização. O envio inline não existe mais, então não há
 * dois modos de envio ativos para o mesmo tenant.
 */
const ConfiguracaoSchema = z.object({
  CHATWOOT_SEND_WORKER_ENABLED: z.enum(['true', 'false']).default('false'),
  CHATWOOT_SEND_WORKER_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  CHATWOOT_SEND_WORKER_IDLE_MAX_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  // Maior que o timeout do adapter (10 s), com folga para gravar o desfecho.
  CHATWOOT_SEND_WORKER_LEASE_SECONDS: z.coerce.number().int().min(30).max(300).default(60),
  CHATWOOT_SEND_WORKER_BATCH: z.coerce.number().int().min(1).max(50).default(10),
  // Vazio (como no .env de modelo) é ausência: o worker desligado tem de subir.
  CHATWOOT_SEND_WORKER_BACKLOG_DESDE: z.preprocess((v) => (v === '' ? undefined : v), z.string().datetime({ offset: true }).optional()),
});

export interface ConfiguracaoDoWorkerEnvio {
  readonly ligado: boolean;
  readonly criadosDesde: string | null;
  readonly pollMs: number;
  readonly ociosoMaxMs: number;
  readonly leaseSegundos: number;
  readonly lote: number;
}

export function lerConfiguracaoDoWorkerEnvio(ambiente: Readonly<Record<string, string | undefined>>): ConfiguracaoDoWorkerEnvio {
  const lido = ConfiguracaoSchema.parse(ambiente);
  const ligado = lido.CHATWOOT_SEND_WORKER_ENABLED === 'true';
  if (ligado && !lido.CHATWOOT_SEND_WORKER_BACKLOG_DESDE) {
    throw new Error('Worker de envio ligado sem CHATWOOT_SEND_WORKER_BACKLOG_DESDE: envio antigo exige autorização.');
  }
  return {
    ligado,
    criadosDesde: lido.CHATWOOT_SEND_WORKER_BACKLOG_DESDE ?? null,
    pollMs: lido.CHATWOOT_SEND_WORKER_POLL_MS,
    ociosoMaxMs: Math.max(lido.CHATWOOT_SEND_WORKER_IDLE_MAX_MS, lido.CHATWOOT_SEND_WORKER_POLL_MS),
    leaseSegundos: lido.CHATWOOT_SEND_WORKER_LEASE_SECONDS,
    lote: lido.CHATWOOT_SEND_WORKER_BATCH,
  };
}

/**
 * O laço do processo, como o da inbox: polling com trabalho, recuo até
 * `ociosoMaxMs` sem trabalho ou com o banco fora. A parada termina o envio em
 * curso e não pega lote novo.
 */
export async function executarWorkerEnvio(
  porta: PortaDoConsumidorEnvio,
  configuracao: ConfiguracaoDoWorkerEnvio,
  sinal: AbortSignal,
  /** Chamado a cada volta do laço: é o sinal de vida para a supervisão (MSG-020A). */
  aoBater: () => void = () => {},
): Promise<void> {
  const { criadosDesde } = configuracao;
  if (!configuracao.ligado || criadosDesde === null) {
    logger.warn('chatwoot.envio.worker_desligado', { subsystem: 'queue' });
    return;
  }

  const workerId = `envio-worker_${crypto.randomUUID()}`;
  logger.info('chatwoot.envio.worker_iniciado', { subsystem: 'queue', workerId });
  let espera = configuracao.pollMs;
  while (!sinal.aborted) {
    aoBater();
    try {
      const resumo = await consumirEnviosUmaVez(porta, {
        workerId,
        limite: configuracao.lote,
        leaseSegundos: configuracao.leaseSegundos,
        criadosDesde,
        deveParar: () => sinal.aborted,
      });
      espera = resumo.reivindicados > 0 ? configuracao.pollMs : Math.min(espera * 2, configuracao.ociosoMaxMs);
      if (resumo.reivindicados > 0 || resumo.reaped > 0) logger.info('chatwoot.envio.passada', { subsystem: 'queue', workerId, ...resumo });
    } catch (error: unknown) {
      espera = configuracao.ociosoMaxMs;
      logger.error('chatwoot.envio.passada_falhou', { subsystem: 'queue', workerId, erro: sanitizeErrorForLog(error) });
    }
    await esperar(espera, sinal);
  }
  logger.info('chatwoot.envio.worker_parado', { subsystem: 'queue', workerId });
}
