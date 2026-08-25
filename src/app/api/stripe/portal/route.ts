/**
 * POST /api/stripe/portal
 * Ticket 38: Inicia sessão do Customer Portal da Stripe para a organização ativa.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseServer } from '@/lib/supabaseServer';
import { organizationContextStatus } from '@/lib/organizationAuthorization';
import { resolveActiveRequestOrganizationContext } from '@/lib/requestOrganizationContext';

const portalInputSchema = z.object({
  return_url: z.string().url(),
});

export async function POST(req: Request) {
  const contextResult = await resolveActiveRequestOrganizationContext(req);
  if (contextResult._tag !== 'OrganizationContextResolved') {
    const status = organizationContextStatus(contextResult);
    return NextResponse.json({ error: status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado' }, { status });
  }

  if (!contextResult.context.capabilities.has('organization:manage')) {
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
  const orgId = contextResult.context.organizationId;

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
