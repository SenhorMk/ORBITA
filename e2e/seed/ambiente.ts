import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { resolveStagingConfig } from '../../src/lib/e2e/stagingConfig';

/** Cliente e ref do projeto que a configuração autorizou nominalmente. */
export interface AmbienteAutorizado {
  readonly supabase: SupabaseClient;
  readonly projetoRef: string;
}

/**
 * Resolve o ambiente exigindo confirmação nominal do projeto e do host.
 *
 * Isto **não é isolamento**: o alvo é o ambiente de desenvolvimento
 * compartilhado, com dados reais de teste. O que a confirmação garante é que
 * ninguém aponta o seed para um destino que não escreveu — não que o destino
 * seja descartável.
 */
export function resolverAmbiente(): AmbienteAutorizado {
  const config = resolveStagingConfig(process.env);
  if (!config.supabaseUrl) {
    throw new Error('SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL é obrigatória.');
  }
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY é obrigatória (fail-closed, sem fallback).');
  }

  return {
    supabase: createClient(config.supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
    projetoRef: new URL(config.supabaseUrl).hostname.toLowerCase().split('.')[0] ?? '',
  };
}

export function caminhoDoDiario(runId: string): string {
  return resolve(process.cwd(), `e2e/.diarios/${runId}.json`);
}

/**
 * Grava o diário de forma atômica: escreve num temporário e renomeia.
 *
 * O diário é reescrito a cada operação. Uma interrupção no meio de um `write`
 * direto deixaria JSON truncado — e um diário ilegível é pior que nenhum: ele
 * some com o rastro de tudo o que já foi criado no projeto.
 */
export function gravarDiarioAtomico(runId: string, conteudo: string): void {
  const destino = caminhoDoDiario(runId);
  mkdirSync(dirname(destino), { recursive: true });
  const temporario = `${destino}.tmp`;
  writeFileSync(temporario, conteudo, 'utf8');
  renameSync(temporario, destino);
}
