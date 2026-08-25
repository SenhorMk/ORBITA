import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';
import { organizationContextStatus } from '@/lib/organizationAuthorization';
import { resolveActiveRequestOrganizationContext } from '@/lib/requestOrganizationContext';
import { listAuditEvents } from '@/services/auditService';
import { getCorrelationId } from '@/lib/observability/correlation';
import { organizationContextToScope } from '@/lib/verifiedOrganizationScope';

export async function GET(req: NextRequest) {
  const correlationId = getCorrelationId(req);

  try {
    const contextResult = await resolveActiveRequestOrganizationContext(req);
    if (contextResult._tag !== 'OrganizationContextResolved') {
      const status = organizationContextStatus(contextResult);
      return NextResponse.json(
        { error: status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado' },
        { status, headers: { 'x-correlation-id': correlationId } },
      );
    }

    // Apenas Admins e Owners têm acesso à trilha de auditoria
    if (!contextResult.context.capabilities.has('organization:manage')) {
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

    const result = await listAuditEvents(supabaseServer, organizationContextToScope(contextResult.context), {
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
