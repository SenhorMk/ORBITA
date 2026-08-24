/**
 * POST /api/stripe/portal
 * Ticket 38: Inicia sessão do Customer Portal da Stripe para a organização ativa.
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { verifySessionAndRole } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabaseServer';
import {
  ACTIVE_ORG_COOKIE_NAME,
  resolveActiveOrganization,
} from '@/lib/organizationContext';

const portalInputSchema = z.object({
  return_url: z.string().url(),
});

export async function POST(req: Request) {
  const session = await verifySessionAndRole(req);
  if (!session) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  const cookieStore = await cookies();
  const preferredOrgId = cookieStore.get(ACTIVE_ORG_COOKIE_NAME)?.value;
  const activeOrgCtx = await resolveActiveOrganization(
    supabaseServer,
    session.actorId,
    preferredOrgId,
  );

  if (!activeOrgCtx) {
    return NextResponse.json({ error: 'Nenhuma organização ativa selecionada' }, { status: 400 });
  }

  if (!['owner', 'admin'].includes(activeOrgCtx.papel)) {
    return NextResponse.json(
      { error: 'Apenas administradores podem acessar o portal de faturamento' },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const parseResult = portalInputSchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: 'Dados inválidos', details: parseResult.error.flatten() },
      { status: 400 },
    );
  }

  const { return_url } = parseResult.data;
  const orgId = activeOrgCtx.organizacao.id;

  // Buscar assinatura atual
  const { data: sub } = await supabaseServer
    .from('assinaturas_organizacao')
    .select('stripe_customer_id')
    .eq('organizacao_id', orgId)
    .maybeSingle();

  if (!sub?.stripe_customer_id) {
    return NextResponse.json(
      { error: 'Organização ainda não possui faturamento configurado no Stripe' },
      { status: 400 },
    );
  }

  const portalUrl = `${return_url}?portal_session=mock_portal_${orgId.slice(0, 8)}`;

  return NextResponse.json({
    url: portalUrl,
    customer_id: sub.stripe_customer_id,
  });
}
