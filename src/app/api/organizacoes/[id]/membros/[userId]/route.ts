import { NextResponse } from 'next/server';
import { verifySessionAndRole } from '@/lib/auth';
import { readBearerToken } from '@/lib/bearer-token';
import { createActorScopedSupabaseClient } from '@/lib/supabaseActorClient';
import { logger } from '@/lib/observability/logger';
import { revokeOrgMember } from '@/lib/invitationService';

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; userId: string }> }
) {
  const bearerResult = readBearerToken(req);
  const session = await verifySessionAndRole(req);
  if (!session || bearerResult._tag !== 'BearerTokenFound') {
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

  const { id: orgId, userId: targetUserId } = await params;

  try {
    const success = await revokeOrgMember(actorClientResult.client, orgId, targetUserId);
    return NextResponse.json({ success });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro ao revogar membro';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
