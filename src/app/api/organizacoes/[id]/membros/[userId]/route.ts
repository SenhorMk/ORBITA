import { NextResponse } from 'next/server';
import { readBearerToken } from '@/lib/bearer-token';
import { createActorScopedSupabaseClient } from '@/lib/supabaseActorClient';
import { logger } from '@/lib/observability/logger';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';
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

  // Revogar membro é ação de gestão: exige `organization:manage` na organização
  // da URL. A resposta distingue sem sessão (401), sem permissão (403) e
  // indisponibilidade (503).
  const authorization = await authorizeRequestOrganizationCapability(req, orgId, 'organization:manage');
  if (authorization._tag !== 'OrganizationCapabilityAuthorized') {
    return authorizationFailureResponse(authorization.status);
  }

  const bearerResult = readBearerToken(req);
  if (bearerResult._tag !== 'BearerTokenFound') {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  // `revogar_membro_organizacao` verifica o papel do próprio chamador por
  // `auth.uid()`; a service_role key não carrega sujeito, então a RPC viaja no
  // cliente do próprio ator.
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
    // CWE-209: a RPC recusa com texto do Postgres, que carrega valor de linha.
    //
    // DÍVIDA (preservada): a recusa legítima — "só o dono revoga o dono" — fica
    // indistinguível de falha de infraestrutura para quem está na tela. Mesmo
    // conserto do `convites/aceitar`: classificar as recusas em erros de
    // domínio tipados.
    registrarFalhaInterna('organizacoes.membros.revogar', error, {
      organizacaoId: authorization.scope.organizationId,
      atorId: authorization.scope.actorId,
    });
    return NextResponse.json({ error: 'Não foi possível revogar o membro' }, { status: 400 });
  }
}
