import { NextResponse } from 'next/server';
import { verifySessionAndRole } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabaseServer';
import {
  createInviteInputSchema,
  createOrgInvite,
  listOrgInvites,
} from '@/lib/invitationService';
import { verifyOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { EntitlementDeniedError } from '@/services/authorizeEntitlement';

function organizationScopeFailureResponse(unavailable: boolean) {
  return NextResponse.json(
    { error: unavailable ? 'Servico de autorizacao indisponivel' : 'Acesso nao autorizado a organizacao' },
    { status: unavailable ? 503 : 403 },
  );
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await verifySessionAndRole(req);
  if (!session) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  const { id: orgId } = await params;
  try {
    const convites = await listOrgInvites(supabaseServer, orgId);
    return NextResponse.json({ convites });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro ao listar convites';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await verifySessionAndRole(req);
  if (!session) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  const { id: orgId } = await params;
  try {
    const rawBody = await req.json();
    const validatedInput = createInviteInputSchema.safeParse(rawBody);
    if (!validatedInput.success) {
      return NextResponse.json(
        { error: 'Dados inválidos', details: validatedInput.error.format() },
        { status: 400 }
      );
    }

    const scopeResult = await verifyOrganizationScope(supabaseServer, {
      organizationId: orgId,
      actorId: session.actorId,
    });
    if (scopeResult._tag !== 'OrganizationScopeVerified') {
      return organizationScopeFailureResponse(scopeResult._tag === 'OrganizationScopeStoreUnavailable');
    }

    const inviteResult = await createOrgInvite(supabaseServer, scopeResult.scope, validatedInput.data);
    return NextResponse.json({ convite: inviteResult }, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof EntitlementDeniedError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 403 },
      );
    }
    const message = error instanceof Error ? error.message : 'Erro ao criar convite';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
