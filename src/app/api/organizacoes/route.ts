import { NextResponse } from 'next/server';
import { resolveAuthenticatedIdentity } from '@/lib/auth';
import { readBearerToken } from '@/lib/bearer-token';
import { supabaseServer } from '@/lib/supabaseServer';
import { createActorScopedSupabaseClient } from '@/lib/supabaseActorClient';
import { logger } from '@/lib/observability/logger';
import {
  createOrgInputSchema,
  createOrganizationAtomic,
  listUserOrganizations,
} from '@/lib/organizationContext';
import { organizationContextStatus } from '@/lib/organizationAuthorization';
import { resolveActiveRequestOrganizationContext } from '@/lib/requestOrganizationContext';

export async function GET(req: Request) {
  const contextResult = await resolveActiveRequestOrganizationContext(req);
  if (contextResult._tag !== 'OrganizationContextResolved') {
    const status = organizationContextStatus(contextResult);
    return NextResponse.json({ error: status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado' }, { status });
  }
  const organizacoes = await listUserOrganizations(supabaseServer, contextResult.context.actorId);
  const activeOrg = {
    organizacao: contextResult.context.organization,
    papel: contextResult.context.role,
  };

  return NextResponse.json({
    organizacoes,
    activeOrg,
    selectionVersion: contextResult.context.selectionVersion,
  });
}

export async function POST(req: Request) {
  const bearerResult = readBearerToken(req);
  const identity = await resolveAuthenticatedIdentity(req);
  if (identity._tag !== 'IdentityVerified' || bearerResult._tag !== 'BearerTokenFound') {
    const status = identity._tag === 'IdentityProviderUnavailable' ? 503 : 401;
    return NextResponse.json({ error: status === 503 ? 'Serviço de autenticação indisponível' : 'Não autorizado' }, { status });
  }

  // `criar_organizacao_atomica` é `security definer` e resolve o dono por
  // `auth.uid()`. A service_role key não carrega sujeito de usuário, então
  // `auth.uid()` seria NULL e a função abortaria (defeito do Ticket 26). A RPC
  // precisa viajar com o JWT já verificado do próprio usuário.
  const actorClientResult = createActorScopedSupabaseClient(bearerResult.token);
  if (actorClientResult._tag !== 'ActorScopedClientCreated') {
    logger.error('organizacoes.actor_client_unavailable', {
      subsystem: 'app',
      variable: actorClientResult.variable,
    });
    return NextResponse.json({ error: 'Serviço de autenticação indisponível' }, { status: 503 });
  }

  try {
    const rawBody = await req.json();
    const validatedInput = createOrgInputSchema.safeParse(rawBody);
    if (!validatedInput.success) {
      return NextResponse.json(
        { error: 'Dados inválidos', details: validatedInput.error.format() },
        { status: 400 }
      );
    }

    const newOrg = await createOrganizationAtomic(actorClientResult.client, validatedInput.data);

    return NextResponse.json({ organizacao: newOrg }, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro ao criar organização';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
