import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';
import { authorizeRequestOrganizationCapability } from '@/lib/requestOrganizationContext';
import { getOrganizationEntitlements } from '@/services/entitlementsService';

function authorizationFailureResponse(status: 401 | 403 | 503) {
  const error = status === 503
    ? 'Servico de autorizacao indisponivel'
    : status === 401
      ? 'Não autorizado'
      : 'Acesso nao autorizado a organizacao';
  return NextResponse.json({ error }, { status });
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
  const { id: orgId } = await params;

  // Ticket 20 — o atalho de sessão negava com 401 até quem era dono da
  // organização. Ler o plano exige vínculo, e nada além dele.
  const authorization = await authorizeRequestOrganizationCapability(req, orgId, 'organization:access');
  if (authorization._tag !== 'OrganizationCapabilityAuthorized') {
    return authorizationFailureResponse(authorization.status);
  }

  try {
    const entitlements = await getOrganizationEntitlements(supabaseServer, authorization.scope.organizationId);
    return NextResponse.json({ entitlements });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro ao consultar plano da organização';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
