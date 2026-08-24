import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifySessionAndRole } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabaseServer';
import {
  ACTIVE_ORG_COOKIE_NAME,
  resolveActiveOrganization,
  switchOrgInputSchema,
} from '@/lib/organizationContext';

export async function POST(req: Request) {
  const session = await verifySessionAndRole(req);
  if (!session) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  try {
    const rawBody = await req.json();
    const validatedInput = switchOrgInputSchema.safeParse(rawBody);
    if (!validatedInput.success) {
      return NextResponse.json(
        { error: 'ID de organização inválido', details: validatedInput.error.format() },
        { status: 400 }
      );
    }

    const orgContext = await resolveActiveOrganization(
      supabaseServer,
      session.actorId,
      validatedInput.data.organizacao_id
    );

    if (!orgContext || orgContext.organizacao.id !== validatedInput.data.organizacao_id) {
      return NextResponse.json(
        { error: 'Você não tem permissão para acessar esta organização' },
        { status: 403 }
      );
    }

    const cookieStore = await cookies();
    cookieStore.set(ACTIVE_ORG_COOKIE_NAME, orgContext.organizacao.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30, // 30 dias
    });

    return NextResponse.json({
      success: true,
      activeOrg: orgContext,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro ao alternar organização';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
