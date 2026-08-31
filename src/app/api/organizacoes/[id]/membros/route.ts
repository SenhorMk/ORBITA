import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseServer } from '@/lib/supabaseServer';
import { papelMembroSchema } from '@/lib/organizationContext';
import { authorizeRequestOrganizationCapability } from '@/lib/requestOrganizationContext';

const membroRowSchema = z.object({
  user_id: z.string().uuid(),
  papel: papelMembroSchema,
  created_at: z.string(),
});
export type OrganizationMemberRow = z.infer<typeof membroRowSchema>;

function authorizationFailureResponse(status: 401 | 403 | 503) {
  const error = status === 503
    ? 'Servico de autorizacao indisponivel'
    : status === 401
      ? 'Não autorizado'
      : 'Acesso nao autorizado a organizacao';
  return NextResponse.json({ error }, { status });
}

/**
 * Lista os membros ativos da organização (`user_id`, `papel`, `created_at`).
 * Reusa exatamente o mesmo padrão de autorização de
 * `src/app/api/organizacoes/[id]/convites/route.ts`: identidade verificada +
 * vínculo persistido antes de qualquer leitura privilegiada. Qualquer membro
 * enxerga a lista; o que ele não pode é agir sobre ela.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: orgId } = await params;

  const authorization = await authorizeRequestOrganizationCapability(req, orgId, 'organization:access');
  if (authorization._tag !== 'OrganizationCapabilityAuthorized') {
    return authorizationFailureResponse(authorization.status);
  }

  const { data, error } = await supabaseServer
    .from('membros_organizacao')
    .select('user_id, papel, created_at')
    .eq('organizacao_id', authorization.scope.organizationId)
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
