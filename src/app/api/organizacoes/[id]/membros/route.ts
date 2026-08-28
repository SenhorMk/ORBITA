import { NextResponse } from 'next/server';
import { z } from 'zod';
import { verifySessionAndRole } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabaseServer';
import { papelMembroSchema } from '@/lib/organizationContext';
import { verifyOrganizationScope } from '@/lib/verifiedOrganizationScope';

const membroRowSchema = z.object({
  user_id: z.string().uuid(),
  papel: papelMembroSchema,
  created_at: z.string(),
});
export type OrganizationMemberRow = z.infer<typeof membroRowSchema>;

function organizationScopeFailureResponse(unavailable: boolean) {
  return NextResponse.json(
    { error: unavailable ? 'Servico de autorizacao indisponivel' : 'Acesso nao autorizado a organizacao' },
    { status: unavailable ? 503 : 403 },
  );
}

/**
 * Lista os membros ativos da organização (`user_id`, `papel`, `created_at`).
 * Reusa exatamente o mesmo padrão de autorização de
 * `src/app/api/organizacoes/[id]/convites/route.ts`: sessão verificada +
 * `verifyOrganizationScope` antes de qualquer leitura privilegiada.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await verifySessionAndRole(req);
  if (!session) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  const { id: orgId } = await params;

  const scopeResult = await verifyOrganizationScope(supabaseServer, {
    organizationId: orgId,
    actorId: session.actorId,
  });
  if (scopeResult._tag !== 'OrganizationScopeVerified') {
    return organizationScopeFailureResponse(scopeResult._tag === 'OrganizationScopeStoreUnavailable');
  }

  const { data, error } = await supabaseServer
    .from('membros_organizacao')
    .select('user_id, papel, created_at')
    .eq('organizacao_id', scopeResult.scope.organizationId)
    .order('created_at', { ascending: true });

  if (error) {
    return NextResponse.json({ error: 'Erro ao listar membros' }, { status: 500 });
  }

  const membros: OrganizationMemberRow[] = [];
  for (const item of data ?? []) {
    const parsed = membroRowSchema.safeParse(item);
    if (parsed.success) {
      membros.push(parsed.data);
    }
  }

  return NextResponse.json({ membros });
}
