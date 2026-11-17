import { NextResponse } from 'next/server';
import { z } from 'zod';

import { organizationContextStatus } from '@/lib/organizationAuthorization';
import { checkRateLimit, DEFAULT_RATE_LIMIT_POLICIES, rateLimitDenialStatus } from '@/lib/rateLimit';
import { createSupabaseRateLimitStore } from '@/lib/rateLimitStore';
import { resolveActiveRequestOrganizationContext } from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import { organizationContextToScope } from '@/lib/verifiedOrganizationScope';
import { lerContextoDaResposta } from '@/services/sac/contextoDaResposta';
import { gerarResposta } from '@/services/sac/gerarResposta';
import { modeloDaResposta } from '@/services/sac/modeloDaResposta';

const responder = (estado: string, status: number) =>
  NextResponse.json({ estado }, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: Request) {
  try {
    const contexto = await resolveActiveRequestOrganizationContext(request);
    if (contexto._tag !== 'OrganizationContextResolved') return responder('sem_autorizacao', organizationContextStatus(contexto));
    if (!contexto.context.capabilities.has('organization:access')) return responder('sem_autorizacao', 403);

    const conversa = z.string().uuid().safeParse(new URL(request.url).searchParams.get('conversaId'));
    if (!conversa.success) return responder('conversa_invalida', 400);
    const modelo = modeloDaResposta(process.env);
    if (!modelo) return responder('desligada', 503);

    const scope = organizationContextToScope(contexto.context);
    const limite = await checkRateLimit(createSupabaseRateLimitStore(supabaseServer), 'sac_rascunho',
      scope.organizationId, DEFAULT_RATE_LIMIT_POLICIES.sac_rascunho);
    if (limite._tag !== 'RateLimitAllowed') return responder('limite_indisponivel', rateLimitDenialStatus(limite));

    const resultado = await gerarResposta(() => lerContextoDaResposta(supabaseServer, scope, conversa.data), modelo);
    return NextResponse.json(resultado, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return responder('indisponivel', 503);
  }
}
