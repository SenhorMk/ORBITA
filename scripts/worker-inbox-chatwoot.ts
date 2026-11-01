/**
 * Processo do consumidor da inbox do Chatwoot (MSG-006): `npm run worker:inbox`.
 * Separado do Next, sem rota: nenhum cliente HTTP alcança este código. Ver
 * docs/operations/msg-006-runbook.md.
 */
import { createClient } from '@supabase/supabase-js';
import { criarPortaDoConsumidorInbox } from '../src/services/chatwoot/consumidorInboxChatwootSupabase';
import { executarWorkerInbox, lerConfiguracaoDoWorkerInbox } from '../src/services/chatwoot/workerInboxChatwoot';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !chave) {
  console.error('Worker da inbox: configuração do Supabase ausente.');
  process.exit(1);
}

const parada = new AbortController();
process.on('SIGINT', () => parada.abort());
process.on('SIGTERM', () => parada.abort());

const supabase = createClient(url, chave, { auth: { persistSession: false, autoRefreshToken: false } });

void executarWorkerInbox(criarPortaDoConsumidorInbox(supabase), lerConfiguracaoDoWorkerInbox(process.env), parada.signal)
  .catch(() => {
    console.error('Worker da inbox: encerrado por falha.');
    process.exitCode = 1;
  });
