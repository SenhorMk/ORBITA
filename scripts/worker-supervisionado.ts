/**
 * Processo de um worker em container (MSG-020A): `node dist-worker/worker-supervisionado.js <inbox|envio>`.
 * O mesmo laço de `worker:inbox` e `worker:envio`, com supervisão: sai com erro
 * se travar, e fica de pé (parado) com o kill switch desligado. Os kill switches
 * continuam desligados por padrão. Ver docs/operations/msg-020a-runbook.md.
 */
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { logger } from '../src/lib/observability/logger';
import { criarPortaDoConsumidorEnvio } from '../src/services/chatwoot/consumidorEnvioChatwootSupabase';
import { criarPortaDoConsumidorInbox } from '../src/services/chatwoot/consumidorInboxChatwootSupabase';
import { executarWorkerEnvio, lerConfiguracaoDoWorkerEnvio } from '../src/services/chatwoot/workerEnvioChatwoot';
import { executarWorkerInbox, lerConfiguracaoDoWorkerInbox } from '../src/services/chatwoot/workerInboxChatwoot';
import { criarVigia, manterNoAr } from '../src/services/worker/supervisao';

const SupervisaoSchema = z.object({
  // Maior que uma passada inteira: lote × timeout do provedor, com folga.
  WORKER_WATCHDOG_SECONDS: z.coerce.number().int().min(5).max(3_600).default(300),
});

const tipo = process.argv[2];
if (tipo !== 'inbox' && tipo !== 'envio') {
  console.error('Uso: worker-supervisionado <inbox|envio>');
  process.exit(2);
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !chave) {
  console.error(`Worker ${tipo}: configuração do Supabase ausente.`);
  process.exit(1);
}

const { WORKER_WATCHDOG_SECONDS: limite } = SupervisaoSchema.parse(process.env);
const supabase = createClient(url, chave, { auth: { persistSession: false, autoRefreshToken: false } });
const rodar = tipo === 'inbox'
  ? ((configuracao) => (sinal: AbortSignal, bater: () => void) =>
      executarWorkerInbox(criarPortaDoConsumidorInbox(supabase), configuracao, sinal, bater))(lerConfiguracaoDoWorkerInbox(process.env))
  : ((configuracao) => (sinal: AbortSignal, bater: () => void) =>
      executarWorkerEnvio(criarPortaDoConsumidorEnvio(supabase), configuracao, sinal, bater))(lerConfiguracaoDoWorkerEnvio(process.env));

const parada = new AbortController();
process.on('SIGINT', () => parada.abort());
process.on('SIGTERM', () => parada.abort());

const vigia = criarVigia(limite * 1_000, () => {
  // Sair é o que libera a lease: quem supervisiona reinicia o processo.
  logger.error('worker.travado', { subsystem: 'queue', worker: tipo, limiteSegundos: limite });
  process.exit(1);
});

void manterNoAr(rodar, parada.signal, vigia, Math.min(30_000, Math.floor((limite * 1_000) / 3)))
  .then((fim) => {
    vigia.parar();
    logger.info('worker.encerrado', { subsystem: 'queue', worker: tipo, fim });
  })
  .catch(() => {
    console.error(`Worker ${tipo}: encerrado por falha.`);
    process.exit(1);
  });
