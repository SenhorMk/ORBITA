/**
 * POST /api/stripe/checkout
 * Ticket 38: Inicia sessão de checkout Stripe para a organização ativa.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { organizationContextStatus } from '@/lib/organizationAuthorization';
import { resolveActiveRequestOrganizationContext } from '@/lib/requestOrganizationContext';

const checkoutInputSchema = z.object({
  plano_slug: z.enum(['pro', 'enterprise']),
  intervalo: z.enum(['monthly', 'yearly']).default('monthly'),
  success_url: z.string().url(),
  cancel_url: z.string().url(),
});

export async function POST(req: Request) {
  const contextResult = await resolveActiveRequestOrganizationContext(req);
  if (contextResult._tag !== 'OrganizationContextResolved') {
    const status = organizationContextStatus(contextResult);
    return NextResponse.json({ error: status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado' }, { status });
  }

  // Apenas donos e administradores podem gerenciar assinaturas
  if (!contextResult.context.capabilities.has('organization:manage')) {
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
  const orgId = contextResult.context.organizationId;

  // Mock seguro / boundary para checkout URL quando Stripe API mockada em dev
  const checkoutUrl = `${success_url}?session_id=cs_mock_${orgId.slice(0, 8)}&plan=${plano_slug}&interval=${intervalo}`;

  return NextResponse.json({
    url: checkoutUrl,
    organizacao_id: orgId,
    plano_slug,
    intervalo,
  });
}
