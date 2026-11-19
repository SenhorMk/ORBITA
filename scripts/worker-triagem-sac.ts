/**
 * Processo do worker de triagem por IA (MSG-013): `npm run worker:triagem`.
 * Separado do Next, sem rota. Ver docs/operations/msg-013-runbook.md.
 */
import { createClient } from '@supabase/supabase-js';
import { criarPortaDoConsumidorTriagem } from '../src/services/sac/triagem/consumidorTriagemSupabase';
import { executarWorkerTriagem, lerConfiguracaoDoWorkerTriagem } from '../src/services/sac/triagem/workerTriagem';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !chave) {
  console.error('Worker de triagem: configuração do Supabase ausente.');
  process.exit(1);
}

const parada = new AbortController();
process.on('SIGINT', () => parada.abort());
process.on('SIGTERM', () => parada.abort());

const supabase = createClient(url, chave, { auth: { persistSession: false, autoRefreshToken: false } });

void executarWorkerTriagem(criarPortaDoConsumidorTriagem(supabase), lerConfiguracaoDoWorkerTriagem(process.env), parada.signal)
  .catch(() => {
    console.error('Worker de triagem: encerrado por falha.');
    process.exitCode = 1;
  });
