/**
 * Processo do consumidor de envio ao Chatwoot (MSG-008): `npm run worker:envio`.
 * Separado do Next, sem rota: nenhum cliente HTTP alcança este código. Ver
 * docs/operations/msg-008-runbook.md.
 */
import { createClient } from '@supabase/supabase-js';
import { criarPortaDoConsumidorEnvio } from '../src/services/chatwoot/consumidorEnvioChatwootSupabase';
import { executarWorkerEnvio, lerConfiguracaoDoWorkerEnvio } from '../src/services/chatwoot/workerEnvioChatwoot';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !chave) {
  console.error('Worker de envio: configuração do Supabase ausente.');
  process.exit(1);
}

const parada = new AbortController();
process.on('SIGINT', () => parada.abort());
process.on('SIGTERM', () => parada.abort());

const supabase = createClient(url, chave, { auth: { persistSession: false, autoRefreshToken: false } });

void executarWorkerEnvio(criarPortaDoConsumidorEnvio(supabase), lerConfiguracaoDoWorkerEnvio(process.env), parada.signal)
  .catch(() => {
    console.error('Worker de envio: encerrado por falha.');
    process.exitCode = 1;
  });
