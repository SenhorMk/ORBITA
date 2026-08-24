import { NextResponse } from 'next/server';
import { supabaseServer } from '../../../../lib/supabaseServer';
import { verifySessionAndRole } from '../../../../lib/auth';
import { resolveActiveOrganization } from '../../../../lib/organizationContext';
import { outboxService } from '../../../../services/outboxService';
import { verifyOrganizationScope } from '../../../../lib/verifiedOrganizationScope';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }

    const preferredOrgId = request.headers.get('cookie')?.match(/orbita_active_org=([^;]+)/)?.[1];
    const activeOrg = await resolveActiveOrganization(supabaseServer, session.actorId, preferredOrgId);
    const orgId = activeOrg?.organizacao.id ?? session.tenant.id;

    const scopeResult = await verifyOrganizationScope(supabaseServer, {
      organizationId: orgId,
      actorId: session.actorId,
    });
    if (scopeResult._tag !== 'OrganizationScopeVerified') {
      const unavailable = scopeResult._tag === 'OrganizationScopeStoreUnavailable';
      return NextResponse.json(
        { success: false, error: unavailable ? 'Serviço de autorização indisponível' : 'Escopo organizacional inválido' },
        { status: unavailable ? 503 : 403 },
      );
    }

    const healthList = await outboxService.getIntegrationsHealth(supabaseServer, scopeResult.scope);

    return NextResponse.json({
      success: true,
      organizacao_id: orgId,
      conexoes: healthList,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro interno';
    console.error('❌ /api/integracoes/saude GET:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
