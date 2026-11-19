/** Durable emergency stop; does not restart or enable any worker. */
import { createClient } from '@supabase/supabase-js';
import { CONEXAO_HAUX, ORGANIZACAO_HAUX, lerConfiguracaoDeParadaHaux } from '../src/services/sac/respostaAutomaticaHaux';

async function parar() {
  const c = lerConfiguracaoDeParadaHaux(process.env);
  if (c._tag !== 'Configurada') { console.error('Configuração do desligamento incompleta.'); process.exitCode = 1; return; }
  const db = createClient(c.valor.NEXT_PUBLIC_SUPABASE_URL, c.valor.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } });
  const r = await db.rpc('desligar_runtime_ai_first', { p_org: ORGANIZACAO_HAUX,
    p_conexao: CONEXAO_HAUX, p_executor: c.valor.CHATWOOT_AI_FIRST_EXECUTOR });
  if (r.error || r.data !== true) { console.error('Desligamento não confirmado.'); process.exitCode = 1; return; }
  console.info('Bot Haux desligado no banco; novos despachos automáticos bloqueados.');
}
void parar().catch(() => { console.error('Desligamento não confirmado.'); process.exitCode = 1; });
