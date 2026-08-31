import { NextResponse } from 'next/server';
import { readBearerToken } from '@/lib/bearer-token';
import { createActorScopedSupabaseClient } from '@/lib/supabaseActorClient';
import { logger } from '@/lib/observability/logger';
import { revokeOrgMember } from '@/lib/invitationService';
import { authorizeRequestOrganizationCapability } from '@/lib/requestOrganizationContext';

function authorizationFailureResponse(status: 401 | 403 | 503) {
  const error = status === 503
    ? 'Servico de autorizacao indisponivel'
    : status === 401
      ? 'Não autorizado'
      : 'Acesso nao autorizado a organizacao';
  return NextResponse.json({ error }, { status });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; userId: string }> }
) {
  const { id: orgId, userId: targetUserId } = await params;

  // Revogar membro é ação de gestão. Antes do Ticket 20 a rota só perguntava
  // "há sessão?" pelo atalho de compatibilidade, que responde `null` tanto para
  // "sem sessão" quanto para "sem vínculo" — e as duas viravam 401, inclusive
  // para o dono da organização.
  const authorization = await authorizeRequestOrganizationCapability(req, orgId, 'organization:manage');
  if (authorization._tag !== 'OrganizationCapabilityAuthorized') {
    return authorizationFailureResponse(authorization.status);
  }

  const bearerResult = readBearerToken(req);
  if (bearerResult._tag !== 'BearerTokenFound') {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  // `revogar_membro_organizacao` verifica o papel do próprio chamador por
  // `auth.uid()`; a service_role key não carrega sujeito (Ticket 26).
  const actorClientResult = createActorScopedSupabaseClient(bearerResult.token);
  if (actorClientResult._tag !== 'ActorScopedClientCreated') {
    logger.error('organizacoes.membros.actor_client_unavailable', {
      subsystem: 'app',
      variable: actorClientResult.variable,
    });
    return NextResponse.json({ error: 'Serviço de autenticação indisponível' }, { status: 503 });
  }

  try {
    const success = await revokeOrgMember(
      actorClientResult.client,
      authorization.scope.organizationId,
      targetUserId,
    );
    return NextResponse.json({ success });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro ao revogar membro';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
