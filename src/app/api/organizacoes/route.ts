import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifySessionAndRole } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabaseServer';
import {
  ACTIVE_ORG_COOKIE_NAME,
  createOrgInputSchema,
  createOrganizationAtomic,
  listUserOrganizations,
  resolveActiveOrganization,
} from '@/lib/organizationContext';

export async function GET(req: Request) {
  const session = await verifySessionAndRole(req);
  if (!session) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  const cookieStore = await cookies();
  const preferredOrgId = cookieStore.get(ACTIVE_ORG_COOKIE_NAME)?.value;

  const organizacoes = await listUserOrganizations(supabaseServer, session.actorId);
  const activeOrg = await resolveActiveOrganization(supabaseServer, session.actorId, preferredOrgId);

  return NextResponse.json({
    organizacoes,
    activeOrg,
  });
}

export async function POST(req: Request) {
  const session = await verifySessionAndRole(req);
  if (!session) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
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

    // Set active org cookie for the newly created organization
    const cookieStore = await cookies();
    cookieStore.set(ACTIVE_ORG_COOKIE_NAME, newOrg.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30, // 30 dias
    });

    return NextResponse.json({ organizacao: newOrg }, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro ao criar organização';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
