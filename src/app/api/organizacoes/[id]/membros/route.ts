import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseServer } from '@/lib/supabaseServer';
import { papelMembroSchema } from '@/lib/organizationContext';
import { authorizeRequestOrganizationCapability } from '@/lib/requestOrganizationContext';
import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';
import {
  identidadeDeExibicao,
  type IdentidadeDeExibicao,
  type UsuarioDoAuth,
} from '@/lib/organizacao/identidadeDoMembro';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

const membroRowSchema = z.object({
  user_id: z.string().uuid(),
  papel: papelMembroSchema,
  created_at: z.string(),
});
type MembroPersistido = z.infer<typeof membroRowSchema>;

/**
 * A linha que a interface recebe: o vínculo, mais como chamar a pessoa.
 *
 * `user_id` continua vindo — ele é a chave das ações (remover é
 * `DELETE .../membros/[userId]`) —, mas deixou de ser a identidade que a tela
 * imprime. Ver `src/lib/organizacao/identidadeDoMembro.ts` para o porquê de
 * `origem_do_nome` existir.
 */
export type OrganizationMemberRow = MembroPersistido & IdentidadeDeExibicao;

/**
 * Lê do Auth os dois campos que a interface pode mostrar deste usuário.
 *
 * Devolve `null` quando a leitura não deu certo — e `null` é propagado como
 * `origem_do_nome: 'indisponivel'`, nunca como "esta pessoa não tem nome".
 *
 * A falha de identidade **não** derruba a lista. O vínculo é o dado desta rota
 * e ele foi lido com sucesso; deixar a tela de membros inutilizável porque o
 * Auth engasgou ao resolver um nome trocaria uma decoração ausente por uma tela
 * de autoridade fora do ar. O que não se pode é mentir sobre o motivo, e não se
 * mente: o desfecho chega nomeado.
 */
async function lerUsuarioDoAuth(
  userId: string,
  scope: VerifiedOrganizationScope,
): Promise<UsuarioDoAuth | null> {
  const { data, error } = await supabaseServer.auth.admin.getUserById(userId);
  if (error || !data?.user) {
    registrarFalhaInterna('organizacoes.membros.identidade', error ?? new Error('usuário sem retorno'), {
      organizacaoId: scope.organizationId,
      atorId: scope.actorId,
    });
    return null;
  }
  // Só a metadata, e dela só o nome sai (ver `identidadeDeExibicao`). O e-mail
  // nem é lido: o que não entra aqui não tem como vazar daqui.
  return { user_metadata: data.user.user_metadata };
}


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
  // respondia 200. Isso era inerte enquanto a rota negava o chamador com 401;
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

  // Em paralelo: a lista é pequena por construção (o limite de assentos do
  // plano), e resolvê-la em série somaria uma ida ao Auth por membro no tempo
  // de resposta de uma tela que abre em toda troca de organização.
  const membros: OrganizationMemberRow[] = await Promise.all(
    lista.data.map(async (membro) => ({
      ...membro,
      // A mesma resposta para owner, admin e member: nome do cadastro, ou a
      // ausência dele dita em voz alta. Não há política de exposição para
      // acertar ou errar — ver `identidadeDoMembro.ts`.
      ...identidadeDeExibicao(await lerUsuarioDoAuth(membro.user_id, authorization.scope)),
    })),
  );

  return NextResponse.json({ membros });
}
