import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ChatwootAdapter } from '../src/services/chatwoot/chatwootAdapter';
import { criarCanalAiFirst } from '../src/services/chatwoot/canalAiFirst';
import { executarWorkerAiFirst } from '../src/services/chatwoot/workerAiFirst';
import { modeloDaResposta } from '../src/services/sac/modeloDaResposta';
import { verifyOrganizationScope } from '../src/lib/verifiedOrganizationScope';

async function iniciar() {
  // This executable is limited to a separately authorized synthetic rehearsal.
  // The default startup performs no I/O and the model never uses external AI.
  if (process.env.CHATWOOT_AI_FIRST_ENABLED !== 'true' || process.env.CHATWOOT_AI_FIRST_ENSAIO_SINTETICO !== 'true') return;
  const cfg = z.object({
    NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    CHATWOOT_AI_FIRST_ORGANIZACAO: z.string().uuid(),
    CHATWOOT_AI_FIRST_CONEXAO: z.string().uuid(),
    CHATWOOT_AI_FIRST_EXECUTOR: z.string().uuid(),
    CHATWOOT_AI_FIRST_INBOX: z.coerce.number().int().positive(),
    CHATWOOT_AI_FIRST_ADMIN_ID: z.coerce.number().int().positive(),
    CHATWOOT_AI_FIRST_ORIGEM: z.string().url(),
  }).safeParse(process.env);
  if (!cfg.success) throw new Error('Configuração de ensaio incompleta.');
  const c = cfg.data;
  const url = new URL(c.NEXT_PUBLIC_SUPABASE_URL);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Use somente Supabase local descartável.');
  const origem = new URL(c.CHATWOOT_AI_FIRST_ORIGEM);
  const loopback = origem.hostname === '127.0.0.1' && origem.protocol === 'http:';
  if (!loopback && origem.protocol !== 'https:') throw new Error('Origem de ensaio do Chatwoot inválida.');
  const supabase = createClient(c.NEXT_PUBLIC_SUPABASE_URL, c.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const escopo = { p_org: c.CHATWOOT_AI_FIRST_ORGANIZACAO, p_conexao: c.CHATWOOT_AI_FIRST_CONEXAO,
    p_executor: c.CHATWOOT_AI_FIRST_EXECUTOR };
  const canal = criarCanalAiFirst({
    escopo, inbox: c.CHATWOOT_AI_FIRST_INBOX, tecnico: c.CHATWOOT_AI_FIRST_ADMIN_ID,
    async resolver() {
      const r = await verifyOrganizationScope(supabase, { organizationId: escopo.p_org, actorId: escopo.p_executor });
      if (r._tag !== 'OrganizationScopeVerified') return null;
      const adapter = await ChatwootAdapter.forScope(r.scope, escopo.p_conexao);
      return adapter?.correspondeAOrigemDaProjecao(origem.origin) ? adapter : null;
    },
  });
  const parada = new AbortController();
  process.once('SIGINT', () => parada.abort());
  process.once('SIGTERM', () => parada.abort());
  await executarWorkerAiFirst({ escopo, canal, banco: supabase, habilitado: true,
    modelo: modeloDaResposta({ SAC_RESPOSTA_PROVEDOR: 'fake' }) }, parada.signal);
}

void iniciar().catch(() => {
  console.error('Worker AI-first: falha ao iniciar o ensaio.');
  process.exitCode = 1;
});
