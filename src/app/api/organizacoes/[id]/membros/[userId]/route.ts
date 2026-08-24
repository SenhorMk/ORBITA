import { NextResponse } from 'next/server';
import { verifySessionAndRole } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabaseServer';
import { revokeOrgMember } from '@/lib/invitationService';

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; userId: string }> }
) {
  const session = await verifySessionAndRole(req);
  if (!session) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  const { id: orgId, userId: targetUserId } = await params;

  try {
    const success = await revokeOrgMember(supabaseServer, orgId, targetUserId);
    return NextResponse.json({ success });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro ao revogar membro';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
