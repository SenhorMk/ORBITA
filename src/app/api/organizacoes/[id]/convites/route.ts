import { NextResponse } from 'next/server';
import { readBearerToken } from '@/lib/bearer-token';
import { supabaseServer } from '@/lib/supabaseServer';
import { createActorScopedSupabaseClient } from '@/lib/supabaseActorClient';
import { logger } from '@/lib/observability/logger';
import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';
import {
  createInviteInputSchema,
  createOrgInvite,
  listOrgInvites,
} from '@/lib/invitationService';
import { authorizeRequestOrganizationCapability } from '@/lib/requestOrganizationContext';
import { EntitlementDeniedError } from '@/services/authorizeEntitlement';

/**
 * Convites são a superfície administrativa da organização: quem os lê e quem os
 * cria precisa de `organization:manage`. A tela já só mostra o formulário para
 * owner/admin, e a listagem falha em silêncio para quem não pode vê-la.
 */
function authorizationFailureResponse(status: 401 | 403 | 503) {
  const error = status === 503
    ? 'Servico de autorizacao indisponivel'
    : status === 401
      ? 'Não autorizado'
      : 'Acesso nao autorizado a organizacao';
  return NextResponse.json({ error }, { status });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: orgId } = await params;

  // A listagem privilegiada rodava sem nenhuma verificação de escopo: bastava
  // uma sessão para ler os convites de qualquer organização. Ninguém alcançou
  // essa brecha porque o atalho de sessão já negava o chamador antes de chegar
  // aqui (Ticket 20).
  const authorization = await authorizeRequestOrganizationCapability(req, orgId, 'organization:manage');
  if (authorization._tag !== 'OrganizationCapabilityAuthorized') {
    return authorizationFailureResponse(authorization.status);
  }

  try {
    const convites = await listOrgInvites(supabaseServer, authorization.scope.organizationId);
    return NextResponse.json({ convites });
  } catch (error: unknown) {
    // CWE-209: o diagnóstico fica no servidor; o cliente recebe a frase fixa.
    registrarFalhaInterna('organizacoes.convites.listar', error, {
      organizacaoId: authorization.scope.organizationId,
      atorId: authorization.scope.actorId,
    });
    return NextResponse.json({ error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: orgId } = await params;

  const authorization = await authorizeRequestOrganizationCapability(req, orgId, 'organization:manage');
  if (authorization._tag !== 'OrganizationCapabilityAuthorized') {
    return authorizationFailureResponse(authorization.status);
  }

  const bearerResult = readBearerToken(req);
  if (bearerResult._tag !== 'BearerTokenFound') {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  // `criar_convite_organizacao` autoriza o autor por `auth.uid()`, então a RPC
  // viaja no cliente do usuário. O snapshot de entitlement continua privilegiado
  // para que a contagem de uso não dependa da visibilidade por RLS (Ticket 26).
  const actorClientResult = createActorScopedSupabaseClient(bearerResult.token);
  if (actorClientResult._tag !== 'ActorScopedClientCreated') {
    logger.error('organizacoes.convites.actor_client_unavailable', {
      subsystem: 'app',
      variable: actorClientResult.variable,
    });
    return NextResponse.json({ error: 'Serviço de autenticação indisponível' }, { status: 503 });
  }

  try {
    const rawBody = await req.json();
    const validatedInput = createInviteInputSchema.safeParse(rawBody);
    if (!validatedInput.success) {
      return NextResponse.json(
        { error: 'Dados inválidos', details: validatedInput.error.format() },
        { status: 400 }
      );
    }

    const inviteResult = await createOrgInvite(
      { privileged: supabaseServer, actor: actorClientResult.client },
      authorization.scope,
      validatedInput.data,
    );
    return NextResponse.json({ convite: inviteResult }, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof EntitlementDeniedError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 403 },
      );
    }
    registrarFalhaInterna('organizacoes.convites.criar', error, {
      organizacaoId: authorization.scope.organizationId,
      atorId: authorization.scope.actorId,
    });
    return NextResponse.json({ error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}
