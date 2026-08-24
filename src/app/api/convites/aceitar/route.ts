import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifySessionAndRole } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabaseServer';
import { ACTIVE_ORG_COOKIE_NAME } from '@/lib/organizationContext';
import {
  acceptInviteInputSchema,
  acceptOrgInvite,
} from '@/lib/invitationService';

export async function POST(req: Request) {
  const session = await verifySessionAndRole(req);
  if (!session) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
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

    const { organizacaoId } = await acceptOrgInvite(supabaseServer, validatedInput.data.token);

    // Set active org cookie to the newly joined organization
    const cookieStore = await cookies();
    cookieStore.set(ACTIVE_ORG_COOKIE_NAME, organizacaoId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30, // 30 dias
    });

    return NextResponse.json({
      success: true,
      organizacaoId,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro ao aceitar convite';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
