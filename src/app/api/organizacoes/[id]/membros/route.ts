import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseServer } from '@/lib/supabaseServer';
import { papelMembroSchema } from '@/lib/organizationContext';
import { authorizeRequestOrganizationCapability } from '@/lib/requestOrganizationContext';
import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';

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
    registrarFalhaInterna('organizacoes.membros.listar', error, {
      organizacaoId: authorization.scope.organizationId,
      atorId: authorization.scope.actorId,
    });
    return NextResponse.json({ error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }

  // A lista inteira é parseada, e uma linha inválida derruba a resposta.
  //
  // Antes as linhas que falhavam no Zod eram descartadas em silêncio e a rota
  // respondia 200. Isso era inerte enquanto a rota negava todo mundo com 401;
  // alcançável, é pior que uma falha: a tela conclui que o membro *não existe*
  // — some da lista, some da contagem, e a revogação parece já ter acontecido.
  // Um membro persistido que o servidor não sabe ler é falha do servidor, e é
  // assim que ela é dita (Ticket 20).
  const lista = membroRowSchema.array().safeParse(data ?? []);
  if (!lista.success) {
    registrarFalhaInterna('organizacoes.membros.listar', lista.error, {
      organizacaoId: authorization.scope.organizationId,
      atorId: authorization.scope.actorId,
    });
    return NextResponse.json({ error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }

  const membros: OrganizationMemberRow[] = lista.data;
  return NextResponse.json({ membros });
}
