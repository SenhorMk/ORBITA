import { NextResponse } from 'next/server';

import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import { getCorrelationId } from '@/lib/observability/correlation';
import { recordAuditEvent } from '@/services/auditService';
import { criarAuditoriaComercial } from '@/services/auditoriaComercial';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import { comAuditoriaDaVenda } from './auditoriaDaVenda';
import { criarManualOrderDependencies } from './dependencias';
import { createManualOrderHandler, type ManualOrderAuthPort } from './handler';

export type {
  ManualOrderBlingPort,
  ManualOrderDependencies,
  ManualOrderStorePort,
} from './handler';

/** Sessão e escopo já verificados uma única vez por requisição, reapresentados ao handler. */
function authFor(actorId: string, scope: VerifiedOrganizationScope): ManualOrderAuthPort {
  return {
    async authenticate() {
      return { actorId };
    },
    async resolveScope() {
      return { _tag: 'Resolved' as const, scope };
    },
  };
}

/**
 * `POST /api/pedidos/manual` — a FRONTEIRA HTTP da venda manual.
 *
 * VEIO DE: `useManualOrderSubmit` (navegador).
 * O QUE ACONTECE AQUI: resolve o escopo verificado e monta as dependências de
 * produção (`dependencias.ts`: Supabase e Bling).
 * PRÓXIMO PASSO: `createManualOrderHandler` em `handler.ts`, que coordena a
 * venda a partir de `prepararPedido` (`preparacao.ts`).
 */
export async function POST(request: Request): Promise<NextResponse> {
  // O escopo é resolvido aqui, uma vez: o cliente do Bling exige a organização
  // verificada, e o ator vem do vínculo persistido (`scope.actorId`), nunca do
  // id da organização. O handler recebe o mesmo escopo já provado, em vez de
  // resolvê-lo de novo.
  const scopeResult = await resolveVerifiedOrganizationScope(request);
  if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
  const { scope } = scopeResult;
  // Sem exigência de `organization:manage`: o ticket 22 decidiu que um
  // `member` vende (ver `ticket-22-fronteira-comercial.test.ts`). Isso diverge
  // de `organizationCapabilitiesForRole` ("member só acessa") e ficou como
  // decisão pendente da proprietária no inventário (PRE-006C). A trilha de
  // auditoria registra o ator de cada venda.
  const dependencias = criarManualOrderDependencies(scope);
  const auditar = criarAuditoriaComercial((s, input) => recordAuditEvent(supabaseServer, s, input));
  const handler = createManualOrderHandler({
    auth: authFor(scope.actorId, scope),
    ...dependencias,
    store: comAuditoriaDaVenda(dependencias.store, auditar, getCorrelationId(request)),
  });

  return handler(request);
}
