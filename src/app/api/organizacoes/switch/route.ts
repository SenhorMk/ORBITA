import { NextResponse } from 'next/server';
import {
  ACTIVE_ORG_COOKIE_NAME,
  switchOrgInputSchema,
} from '@/lib/organizationContext';
import {
  organizationContextStatus,
  parseOrganizationId,
  type OrganizationActorId,
  type OrganizationContextResult,
  type OrganizationId,
  type OrganizationSwitchResult,
  type OrganizationSelection,
} from '@/lib/organizationAuthorization';

interface OrganizationSwitchDependencies {
  readonly resolveContext: (
    request: Request,
    selection: OrganizationSelection,
  ) => Promise<OrganizationContextResult>;
  readonly switchActiveOrganization: (
    actorId: OrganizationActorId,
    organizationId: OrganizationId,
    expectedVersion: number,
  ) => Promise<OrganizationSwitchResult>;
  readonly setActiveOrganization: (organizationId: string) => Promise<void>;
}

/**
 * `POST /api/organizacoes/switch` — troca a organização ativa do ator.
 *
 * Fluxo: valida o corpo → confirma o vínculo com a organização pedida
 * (`ExactOrganization`) → aplica a troca por CAS com a versão que a tela viu →
 * só então espelha a seleção no cookie.
 *
 * O `organizacao_id` do corpo apenas escolhe qual vínculo conferir; quem é
 * gravado vem do contexto resolvido. Se a versão enviada já estiver velha
 * (outra aba trocou antes), a resposta é 409 e nada é sobrescrito.
 */
export function createOrganizationSwitchHandler(dependencies: OrganizationSwitchDependencies) {
  return async function organizationSwitchHandler(req: Request) {

  try {
    const rawBody = await req.json();
    const validatedInput = switchOrgInputSchema.safeParse(rawBody);
    if (!validatedInput.success) {
      return NextResponse.json(
        { error: 'ID de organização inválido', details: validatedInput.error.format() },
        { status: 400 }
      );
    }

    const targetOrganizationId = parseOrganizationId(validatedInput.data.organizacao_id);
    if (!targetOrganizationId) {
      return NextResponse.json({ error: 'ID de organização inválido' }, { status: 400 });
    }
    const result = await dependencies.resolveContext(req, {
      _tag: 'ExactOrganization',
      organizationId: targetOrganizationId,
    });
    if (result._tag !== 'OrganizationContextResolved') {
      const status = organizationContextStatus(result);
      return NextResponse.json(
        { error: status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado' },
        { status },
      );
    }

    const switchResult = await dependencies.switchActiveOrganization(
      result.context.actorId,
      result.context.organizationId,
      validatedInput.data.expected_version,
    );
    if (switchResult._tag === 'OrganizationSwitchStale') {
      return NextResponse.json({ error: 'Contexto de organização desatualizado' }, { status: 409 });
    }
    if (switchResult._tag === 'OrganizationSwitchDenied') {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 403 });
    }
    if (switchResult._tag === 'MembershipStoreUnavailable') {
      return NextResponse.json({ error: 'Serviço de autorização indisponível' }, { status: 503 });
    }

    await dependencies.setActiveOrganization(result.context.organizationId);

    return NextResponse.json({
      success: true,
      activeOrg: {
        organizacao: result.context.organization,
        papel: result.context.role,
      },
      selectionVersion: switchResult.version,
    });
  } catch (error: unknown) {
    console.error('/api/organizacoes/switch: falha interna classificada.', error instanceof Error ? error.name : 'unknown');
    return NextResponse.json({ error: 'Erro ao alternar organização' }, { status: 500 });
  }
  };
}

/** Production organization-switch route. */
export async function POST(req: Request) {
  const { cookies } = await import('next/headers');
  const { resolveRequestOrganizationContext } = await import('@/lib/requestOrganizationContext');
  const { supabaseServer } = await import('@/lib/supabaseServer');
  const { SupabaseOrganizationMemberships } = await import('@/repositories/organizationMembershipRepository');
  const memberships = new SupabaseOrganizationMemberships(supabaseServer);
  const handler = createOrganizationSwitchHandler({
    resolveContext: resolveRequestOrganizationContext,
    switchActiveOrganization: (actorId, organizationId, expectedVersion) => memberships.switchActiveOrganization(
      actorId,
      organizationId,
      expectedVersion,
    ),
    setActiveOrganization: async (organizationId) => {
      (await cookies()).set(ACTIVE_ORG_COOKIE_NAME, organizationId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 30,
      });
    },
  });
  return handler(req);
}
