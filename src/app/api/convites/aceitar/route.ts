import { NextResponse } from 'next/server';
import { verifySessionAndRole } from '@/lib/auth';
import { readBearerToken } from '@/lib/bearer-token';
import { createActorScopedSupabaseClient } from '@/lib/supabaseActorClient';
import { logger } from '@/lib/observability/logger';
import { ACTIVE_ORG_COOKIE_NAME } from '@/lib/organizationContext';
import {
  acceptInviteInputSchema,
  acceptOrgInvite,
} from '@/lib/invitationService';

/**
 * Build the invite-acceptance handler around the request-scoped cookie seam.
 *
 * Only the cookie write is injected: session verification, actor-scoped client
 * construction and the RPC itself stay inside the handler so that tests
 * exercise the real caller identity instead of a stand-in for it.
 *
 * @param setActiveOrganization - Persists the newly joined organization as active.
 * @returns The `POST /api/convites/aceitar` handler.
 */
export function createAcceptInviteHandler(
  setActiveOrganization: (organizacaoId: string) => Promise<void>,
) {
  return async function acceptInviteHandler(req: Request) {
    const bearerResult = readBearerToken(req);
    const session = await verifySessionAndRole(req);
    if (!session || bearerResult._tag !== 'BearerTokenFound') {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    // `aceitar_convite_organizacao` cria a membership para `auth.uid()`; com a
    // service_role key o sujeito é NULL e a RPC aborta (Ticket 26).
    const actorClientResult = createActorScopedSupabaseClient(bearerResult.token);
    if (actorClientResult._tag !== 'ActorScopedClientCreated') {
      logger.error('convites.aceitar.actor_client_unavailable', {
        subsystem: 'app',
        variable: actorClientResult.variable,
      });
      return NextResponse.json({ error: 'Serviço de autenticação indisponível' }, { status: 503 });
    }

    try {
      const rawBody = await req.json();
      const validatedInput = acceptInviteInputSchema.safeParse(rawBody);
      if (!validatedInput.success) {
        return NextResponse.json(
          { error: 'Token inválido', details: validatedInput.error.format() },
          { status: 400 }
        );
      }

      const { organizacaoId } = await acceptOrgInvite(actorClientResult.client, validatedInput.data.token);

      await setActiveOrganization(organizacaoId);

      return NextResponse.json({
        success: true,
        organizacaoId,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Erro ao aceitar convite';
      return NextResponse.json({ error: message }, { status: 400 });
    }
  };
}

/** Production invite-acceptance route. */
export async function POST(req: Request) {
  const { cookies } = await import('next/headers');
  const handler = createAcceptInviteHandler(async (organizacaoId) => {
    (await cookies()).set(ACTIVE_ORG_COOKIE_NAME, organizacaoId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30, // 30 dias
    });
  });
  return handler(req);
}
