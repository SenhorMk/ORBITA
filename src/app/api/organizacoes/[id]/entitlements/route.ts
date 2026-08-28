import { NextResponse } from 'next/server';
import { verifySessionAndRole } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabaseServer';
import { verifyOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { getOrganizationEntitlements } from '@/services/entitlementsService';

function organizationScopeFailureResponse(unavailable: boolean) {
  return NextResponse.json(
    { error: unavailable ? 'Servico de autorizacao indisponivel' : 'Acesso nao autorizado a organizacao' },
    { status: unavailable ? 503 : 403 },
  );
}

/**
 * Expõe o plano/limites reais da organização (Ticket 13) para a UI de
 * billing. Nenhum estado de assinatura é inventado aqui: os dados vêm de
 * `getOrganizationEntitlements`, que já é a única fonte de verdade usada
 * pelo servidor para aplicar limites.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await verifySessionAndRole(req);
  if (!session) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  const { id: orgId } = await params;

  const scopeResult = await verifyOrganizationScope(supabaseServer, {
    organizationId: orgId,
    actorId: session.actorId,
  });
  if (scopeResult._tag !== 'OrganizationScopeVerified') {
    return organizationScopeFailureResponse(scopeResult._tag === 'OrganizationScopeStoreUnavailable');
  }

  try {
    const entitlements = await getOrganizationEntitlements(supabaseServer, scopeResult.scope.organizationId);
    return NextResponse.json({ entitlements });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro ao consultar plano da organização';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
