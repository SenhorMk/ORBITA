import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';
import { authorizeRequestOrganizationCapability } from '@/lib/requestOrganizationContext';
import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';
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
 * Expõe o plano/limites reais da organização para a UI de
 * billing. Nenhum estado de assinatura é inventado aqui: os dados vêm de
 * `getOrganizationEntitlements`, que já é a única fonte de verdade usada
 * pelo servidor para aplicar limites.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: orgId } = await params;

  // Ler o plano exige vínculo com a organização da URL, e nada além dele.
  const authorization = await authorizeRequestOrganizationCapability(req, orgId, 'organization:access');
  if (authorization._tag !== 'OrganizationCapabilityAuthorized') {
    return authorizationFailureResponse(authorization.status);
  }

  try {
    const entitlements = await getOrganizationEntitlements(supabaseServer, authorization.scope.organizationId);
    return NextResponse.json({ entitlements });
  } catch (error: unknown) {
    registrarFalhaInterna('organizacoes.entitlements.consultar', error, {
      organizacaoId: authorization.scope.organizationId,
      atorId: authorization.scope.actorId,
    });
    return NextResponse.json({ error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}
