import { NextResponse } from 'next/server';
import {
  activeOrganizationSelection,
  organizationContextStatus,
  type OrganizationContext,
  type OrganizationContextResult,
  type OrganizationSelection,
} from '../../../../lib/organizationAuthorization';
import type { IntegrationHealthSummary } from '../../../../services/outboxService';

export const dynamic = 'force-dynamic';

interface IntegrationHealthDependencies {
  readonly resolveContext: (
    request: Request,
    selection: OrganizationSelection | null,
  ) => Promise<OrganizationContextResult>;
  readonly getHealth: (context: OrganizationContext) => Promise<readonly IntegrationHealthSummary[]>;
}

/** Build the integration-health HTTP handler around canonical authorization seams. */
export function createIntegrationHealthHandler(dependencies: IntegrationHealthDependencies) {
  return async function integrationHealthHandler(request: Request) {
  try {
    const contextResult = await dependencies.resolveContext(
      request,
      activeOrganizationSelection(),
    );
    if (contextResult._tag !== 'OrganizationContextResolved') {
      const status = organizationContextStatus(contextResult);
      return NextResponse.json(
        { success: false, error: status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado' },
        { status },
      );
    }

    const orgId = contextResult.context.organizationId;
    const healthList = await dependencies.getHealth(contextResult.context);

    return NextResponse.json({
      success: true,
      organizacao_id: orgId,
      conexoes: healthList,
    });
  } catch (error: unknown) {
    console.error('/api/integracoes/saude: falha interna classificada.', error instanceof Error ? error.name : 'unknown');
    return NextResponse.json({ success: false, error: 'Erro interno' }, { status: 500 });
  }
  };
}

/** Production integration-health route. */
export async function GET(request: Request) {
  const { supabaseServer } = await import('../../../../lib/supabaseServer');
  const { resolveRequestOrganizationContext } = await import('../../../../lib/requestOrganizationContext');
  const { outboxService } = await import('../../../../services/outboxService');
  const { organizationContextToScope } = await import('../../../../lib/verifiedOrganizationScope');
  const handler = createIntegrationHealthHandler({
    resolveContext: resolveRequestOrganizationContext,
    getHealth: (context) => outboxService.getIntegrationsHealth(
      supabaseServer,
      organizationContextToScope(context),
    ),
  });
  return handler(request);
}
