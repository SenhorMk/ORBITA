import { NextResponse } from 'next/server';

import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

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

export async function POST(request: Request): Promise<NextResponse> {
  // Ticket 22 — o portão de sessão legado saiu. Ele usava o id do *tenant* como
  // id do *ator*, e os dois só coincidiam porque um `dono` sem `tenant_id` caía
  // em `tenantId = actorId`. O ator verdadeiro vem do vínculo persistido, em
  // `scope.actorId`.
  // O escopo é resolvido aqui, uma vez, porque desde o Ticket 10b o cliente do
  // Bling exige a organização verificada. O handler recebe o mesmo escopo já
  // provado, em vez de resolvê-lo de novo.
  const scopeResult = await resolveVerifiedOrganizationScope(request);
  if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
  const { scope } = scopeResult;

  const handler = createManualOrderHandler({
    auth: authFor(scope.actorId, scope),
    ...criarManualOrderDependencies(scope),
  });

  return handler(request);
}
