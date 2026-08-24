import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseServer } from '@/lib/supabaseServer';
import { verifySessionAndRole } from '@/lib/auth';
import {
  suspendOrganization,
  reactivateOrganization,
  scheduleOrganizationDeletion,
  cancelOrganizationDeletion,
} from '@/services/organizationLifecycleService';
import { verifyOrganizationScope } from '@/lib/verifiedOrganizationScope';

function organizationScopeFailureResponse(unavailable: boolean) {
  return NextResponse.json(
    { error: unavailable ? 'Servico de autorizacao indisponivel' : 'Acesso nao autorizado a organizacao' },
    { status: unavailable ? 503 : 403 },
  );
}

const lifecycleActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('suspend'),
    motivo: z.string().min(3).max(500),
  }),
  z.object({
    action: z.literal('reactivate'),
    motivo: z.string().min(3).max(500),
  }),
  z.object({
    action: z.literal('schedule_deletion'),
    motivo: z.string().min(3).max(500),
    diasRetencao: z.number().int().min(1).max(365).optional().default(30),
  }),
  z.object({
    action: z.literal('cancel_deletion'),
  }),
]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await verifySessionAndRole(req);
    if (!session) {
      return NextResponse.json({ error: 'Nao autenticado' }, { status: 401 });
    }
    const { id: orgId } = await params;

    const scopeResult = await verifyOrganizationScope(supabaseServer, {
      organizationId: orgId,
      actorId: session.actorId,
    });
    if (scopeResult._tag !== 'OrganizationScopeVerified') {
      return organizationScopeFailureResponse(scopeResult._tag === 'OrganizationScopeStoreUnavailable');
    }

    const { data: org, error: orgErr } = await supabaseServer
      .from('organizacoes')
      .select('id, nome, slug, status, suspenso_em, motivo_suspensao, exclusao_agendada_para, encerrado_em')
      .eq('id', orgId)
      .single();

    if (orgErr || !org) {
      return NextResponse.json({ error: 'Organizacao nao encontrada' }, { status: 404 });
    }

    const { data: historico } = await supabaseServer
      .from('historico_ciclo_vida_organizacao')
      .select('id, acao, motivo, autor_user_id, metadata, created_at')
      .eq('organizacao_id', orgId)
      .order('created_at', { ascending: false })
      .limit(50);

    return NextResponse.json({
      organization: org,
      history: historico || [],
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erro interno ao consultar ciclo de vida';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await verifySessionAndRole(req);
    if (!session) {
      return NextResponse.json({ error: 'Nao autenticado' }, { status: 401 });
    }
    const { id: orgId } = await params;

    const body = await req.json();
    const parsed = lifecycleActionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Parametros invalidos para acao de ciclo de vida', details: parsed.error.format() },
        { status: 400 },
      );
    }

    const scopeResult = await verifyOrganizationScope(supabaseServer, {
      organizationId: orgId,
      actorId: session.actorId,
    });
    if (scopeResult._tag !== 'OrganizationScopeVerified') {
      return organizationScopeFailureResponse(scopeResult._tag === 'OrganizationScopeStoreUnavailable');
    }

    const actionData = parsed.data;
    const scope = scopeResult.scope;
    const userRole = scope.role;

    if (actionData.action === 'suspend') {
      if (userRole !== 'owner' && userRole !== 'admin') {
        return NextResponse.json({ error: 'Apenas administradores podem suspender a organizacao' }, { status: 403 });
      }
      await suspendOrganization(supabaseServer, scope, actionData.motivo);
      return NextResponse.json({ success: true, status: 'suspended' });
    }

    if (actionData.action === 'reactivate') {
      if (userRole !== 'owner' && userRole !== 'admin') {
        return NextResponse.json({ error: 'Apenas administradores podem reativar a organizacao' }, { status: 403 });
      }
      await reactivateOrganization(supabaseServer, scope, actionData.motivo);
      return NextResponse.json({ success: true, status: 'active' });
    }

    if (actionData.action === 'schedule_deletion') {
      if (userRole !== 'owner') {
        return NextResponse.json({ error: 'Apenas o Owner pode agendar o encerramento da organizacao' }, { status: 403 });
      }
      const scheduledDate = await scheduleOrganizationDeletion(
        supabaseServer,
        scope,
        actionData.motivo,
        actionData.diasRetencao,
      );
      return NextResponse.json({ success: true, status: 'pending_deletion', exclusaoAgendadaPara: scheduledDate });
    }

    if (actionData.action === 'cancel_deletion') {
      if (userRole !== 'owner') {
        return NextResponse.json({ error: 'Apenas o Owner pode cancelar o encerramento da organizacao' }, { status: 403 });
      }
      await cancelOrganizationDeletion(supabaseServer, scope);
      return NextResponse.json({ success: true, status: 'active' });
    }

    return NextResponse.json({ error: 'Acao desconhecida' }, { status: 400 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erro ao processar ciclo de vida';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
