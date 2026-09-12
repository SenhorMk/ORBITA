import { NextResponse } from 'next/server';

import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { financeiroRepository } from '@/repositories/financeiroRepository';
import { bling } from '@/services/bling';
import type { BlingPort } from '@/services/blingPort';

import {
  createFinanceiroSyncHandler,
  type EntidadeFinanceira,
  type FinanceiroSyncAuthPort,
  type FinanceiroSyncBlingPort,
  type FinanceiroSyncStorePort,
  type RawContaFinanceira,
} from './handler';

export type {
  FinanceiroSyncBlingPort,
  FinanceiroSyncDependencies,
  FinanceiroSyncStorePort,
} from './handler';

export const dynamic = 'force-dynamic';

/**
 * Adapter Supabase da sincronização financeira.
 *
 * O checkpoint reaproveita `sync_state`, a mesma tabela de `services/sync.ts`.
 */
function supabaseFinanceiroSyncStore(): FinanceiroSyncStorePort {
  return {
    async upsertTitulo(scope, titulo) {
      await financeiroRepository.upsertTitulo(scope, titulo);
    },

    async vincularPedidos(scope, candidatos) {
      return financeiroRepository.vincularPedidos(scope, candidatos);
    },

    async marcarCheckpoint(scope: VerifiedOrganizationScope, entidade: EntidadeFinanceira): Promise<void> {
      const agora = new Date().toISOString();
      const { error } = await supabaseServer
        .from('sync_state')
        .upsert(
          {
            organizacao_id: scope.organizationId,
            // Ator que gravou o checkpoint. `sync_state.user_id` é `NOT NULL`;
            // a identidade do checkpoint, porém, é `(organizacao_id, entidade)`
            // — é ela que resolve o conflito abaixo.
            user_id: scope.actorId,
            entidade,
            last_synced_at: agora,
            updated_at: agora,
          },
          { onConflict: 'organizacao_id, entidade' },
        );
      if (error) throw error;
    },
  };
}

/**
 * Adapter do Bling.
 *
 * `getContasPagar`/`getContasReceber` passaram a lançar `BlingLeituraError` em
 * vez de devolver `[]` — antes, um 401 virava lista vazia e a sincronização
 * terminava "com sucesso" sem ter lido nada. Este adapter só escolhe a direção.
 */
function blingFinanceiroSyncAdapter(client: BlingPort): FinanceiroSyncBlingPort {
  return {
    async lerPagina(entidade: EntidadeFinanceira, pagina: number, limite: number): Promise<readonly RawContaFinanceira[]> {
      const itens = entidade === 'financeiro_contas_pagar'
        ? await client.getContasPagar(pagina, limite)
        : await client.getContasReceber(pagina, limite);
      return itens as RawContaFinanceira[];
    },
  };
}

/** Sessão e escopo já verificados uma única vez por requisição. */
function authFor(actorId: string, scope: VerifiedOrganizationScope): FinanceiroSyncAuthPort {
  return {
    async authenticate() {
      return { actorId };
    },
    async resolveScope() {
      return { _tag: 'Resolved' as const, scope };
    },
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  // Ticket 22 — o portão de sessão legado saiu. Ele usava o id do *tenant* como
  // id do *ator*, e os dois só coincidiam porque um `dono` sem `tenant_id` caía
  // em `tenantId = actorId`. O ator verdadeiro vem do vínculo persistido, em
  // `scope.actorId`.
  const scopeResult = await resolveVerifiedOrganizationScope(request);
  if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
  const { scope } = scopeResult;

  const handler = createFinanceiroSyncHandler({
    auth: authFor(scope.actorId, scope),
    store: supabaseFinanceiroSyncStore(),
    bling: blingFinanceiroSyncAdapter(bling.forVerifiedOrganization(scope)),
  });

  return handler(request);
}
