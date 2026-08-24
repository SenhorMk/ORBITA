import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { supabaseServer } from '@/lib/supabaseServer';
import { verifySessionAndRole } from '@/lib/auth';
import {
  ACTIVE_ORG_COOKIE_NAME,
  resolveActiveOrganization,
} from '@/lib/organizationContext';
import { listAuditEvents } from '@/services/auditService';
import { getCorrelationId } from '@/lib/observability/correlation';

export async function GET(req: NextRequest) {
  const correlationId = getCorrelationId(req);

  try {
    const session = await verifySessionAndRole(req);
    if (!session) {
      return NextResponse.json({ error: 'Nao autenticado' }, { status: 401, headers: { 'x-correlation-id': correlationId } });
    }

    const cookieStore = await cookies();
    const preferredOrgId = cookieStore.get(ACTIVE_ORG_COOKIE_NAME)?.value;
    const activeOrgCtx = await resolveActiveOrganization(
      supabaseServer,
      session.actorId,
      preferredOrgId,
    );

    if (!activeOrgCtx) {
      return NextResponse.json(
        { error: 'Nenhuma organizacao ativa selecionada' },
        { status: 403, headers: { 'x-correlation-id': correlationId } },
      );
    }

    // Apenas Admins e Owners têm acesso à trilha de auditoria
    if (activeOrgCtx.papel !== 'owner' && activeOrgCtx.papel !== 'admin') {
      return NextResponse.json(
        { error: 'Acesso restrito a administradores' },
        { status: 403, headers: { 'x-correlation-id': correlationId } },
      );
    }

    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const acao = url.searchParams.get('acao') || undefined;
    const actorId = url.searchParams.get('actorId') || undefined;

    const result = await listAuditEvents(supabaseServer, {
      organizacaoId: activeOrgCtx.organizacao.id,
      limit,
      offset,
      acao,
      actorId,
    });

    return NextResponse.json(result, {
      status: 200,
      headers: {
        'x-correlation-id': correlationId,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erro interno ao consultar auditoria';
    return NextResponse.json(
      { error: message },
      { status: 500, headers: { 'x-correlation-id': correlationId } },
    );
  }
}
