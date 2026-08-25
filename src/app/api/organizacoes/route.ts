import { NextResponse } from 'next/server';
import { resolveAuthenticatedIdentity } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabaseServer';
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
  const identity = await resolveAuthenticatedIdentity(req);
  if (identity._tag !== 'IdentityVerified') {
    const status = identity._tag === 'IdentityProviderUnavailable' ? 503 : 401;
    return NextResponse.json({ error: status === 503 ? 'Serviço de autenticação indisponível' : 'Não autorizado' }, { status });
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

    const newOrg = await createOrganizationAtomic(supabaseServer, validatedInput.data);

    return NextResponse.json({ organizacao: newOrg }, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro ao criar organização';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
