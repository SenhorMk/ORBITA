import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseServer } from '@/lib/supabaseServer';
import { organizationContextStatus } from '@/lib/organizationAuthorization';
import { resolveActiveRequestOrganizationContext } from '@/lib/requestOrganizationContext';
import { listAuditEvents } from '@/services/auditService';
import { getCorrelationId } from '@/lib/observability/correlation';
import { organizationContextToScope, type VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';
import { papelMembroSchema } from '@/lib/organizationContext';
import { identidadeDeExibicao } from '@/lib/organizacao/identidadeDoMembro';
import {
  montarHistorico,
  origemDoHistoricoSchema,
  type PortasDoHistorico,
} from '@/lib/auditoria/historicoDeAtividades';

const consultaSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  acao: z.string().min(1).max(100).optional(),
  actorId: z.string().uuid().optional(),
  origem: origemDoHistoricoSchema.optional(),
});

const papelRowSchema = z.object({ user_id: z.string().uuid(), papel: papelMembroSchema });

/**
 * As leituras privilegiadas que identificam quem aparece na página. O papel é
 * sempre lido **nesta** organização: a service role ignora RLS, então o escopo
 * verificado é o único filtro.
 */
function portasDoHistorico(scope: VerifiedOrganizationScope): PortasDoHistorico {
  return {
    async lerPapeis(userIds) {
      const { data, error } = await supabaseServer
        .from('membros_organizacao')
        .select('user_id, papel')
        .eq('organizacao_id', scope.organizationId)
        .in('user_id', [...userIds]);
      if (error) throw error;
      const linhas = papelRowSchema.array().parse(data ?? []);
      return new Map(linhas.map((l) => [l.user_id, l.papel]));
    },
    // Como na lista de membros: só o nome sai do Auth, e uma falha vira
    // "identidade indisponível" em vez de derrubar o histórico.
    async lerIdentidade(userId) {
      const { data, error } = await supabaseServer.auth.admin.getUserById(userId);
      if (error || !data?.user) {
        registrarFalhaInterna('auditoria.historico.identidade', error ?? new Error('usuário sem retorno'), {
          organizacaoId: scope.organizationId,
          atorId: scope.actorId,
        });
        return identidadeDeExibicao(null);
      }
      return identidadeDeExibicao({ user_metadata: data.user.user_metadata });
    },
  };
}

/** Histórico de atividades da organização ativa: quem fez o quê, e quando. */
export async function GET(req: NextRequest) {
  const correlationId = getCorrelationId(req);
  const headers = { 'x-correlation-id': correlationId };

  const contextResult = await resolveActiveRequestOrganizationContext(req);
  if (contextResult._tag !== 'OrganizationContextResolved') {
    const status = organizationContextStatus(contextResult);
    return NextResponse.json(
      { error: status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado' },
      { status, headers },
    );
  }

  // Apenas Admins e Owners têm acesso à trilha de auditoria
  if (!contextResult.context.capabilities.has('organization:manage')) {
    return NextResponse.json({ error: 'Acesso restrito a administradores' }, { status: 403, headers });
  }

  const consulta = consultaSchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!consulta.success) {
    return NextResponse.json({ error: 'Filtro inválido' }, { status: 400, headers });
  }

  const scope = organizationContextToScope(contextResult.context);
  try {
    const { events, total } = await listAuditEvents(supabaseServer, scope, consulta.data);
    const atividades = await montarHistorico(events, portasDoHistorico(scope));
    return NextResponse.json({ atividades, total }, { status: 200, headers });
  } catch (err: unknown) {
    registrarFalhaInterna('auditoria.historico', err, { organizacaoId: scope.organizationId, atorId: scope.actorId });
    return NextResponse.json({ error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500, headers });
  }
}
