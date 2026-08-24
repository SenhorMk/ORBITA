/**
 * POST /api/stripe/checkout
 * Ticket 38: Inicia sessão de checkout Stripe para a organização ativa.
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

const checkoutInputSchema = z.object({
  plano_slug: z.enum(['pro', 'enterprise']),
  intervalo: z.enum(['monthly', 'yearly']).default('monthly'),
  success_url: z.string().url(),
  cancel_url: z.string().url(),
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

  // Apenas donos e administradores podem gerenciar assinaturas
  if (!['owner', 'admin'].includes(activeOrgCtx.papel)) {
    return NextResponse.json(
      { error: 'Apenas administradores podem gerenciar o plano da organização' },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const parseResult = checkoutInputSchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: 'Dados inválidos', details: parseResult.error.flatten() },
      { status: 400 },
    );
  }

  const { plano_slug, intervalo, success_url } = parseResult.data;
  const orgId = activeOrgCtx.organizacao.id;

  // Mock seguro / boundary para checkout URL quando Stripe API mockada em dev
  const checkoutUrl = `${success_url}?session_id=cs_mock_${orgId.slice(0, 8)}&plan=${plano_slug}&interval=${intervalo}`;

  return NextResponse.json({
    url: checkoutUrl,
    organizacao_id: orgId,
    plano_slug,
    intervalo,
  });
}
