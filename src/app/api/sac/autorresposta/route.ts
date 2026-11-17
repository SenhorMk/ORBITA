import { NextResponse } from 'next/server';
import { z } from 'zod';

import { resolveAuthenticatedIdentity } from '@/lib/auth';
import { organizationContextStatus } from '@/lib/organizationAuthorization';
import { resolveActiveRequestOrganizationContext } from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

const Escopo = z.enum(['organizacao', 'global']);
const Comando = z.strictObject({
  ativa: z.boolean(),
  versaoEsperada: z.number().int().nonnegative(),
  motivo: z.string().trim().min(1).max(240),
});
const Estado = z.tuple([z.strictObject({
  ativa_global: z.boolean(),
  versao_global: z.number().int().nonnegative(),
  ativa_org: z.boolean(),
  versao_org: z.number().int().nonnegative(),
})]);

function falha(status: number, motivo: string) {
  return NextResponse.json({ success: false, motivo }, { status });
}

async function resolverEscopo(request: Request) {
  const escopo = Escopo.safeParse(new URL(request.url).searchParams.get('escopo') ?? 'organizacao');
  if (!escopo.success) return { resposta: falha(400, 'escopo_invalido') };

  if (escopo.data === 'global') {
    const identidade = await resolveAuthenticatedIdentity(request);
    if (identidade._tag === 'IdentityProviderUnavailable') return { resposta: falha(503, 'indisponivel') };
    if (identidade._tag !== 'IdentityVerified') return { resposta: falha(401, 'sessao_invalida') };
    return { atorId: identidade.user.id, organizacaoId: null };
  }

  const contexto = await resolveActiveRequestOrganizationContext(request);
  if (contexto._tag !== 'OrganizationContextResolved') {
    return { resposta: falha(organizationContextStatus(contexto), 'escopo_indisponivel') };
  }
  if (!contexto.context.capabilities.has('organization:manage')) {
    return { resposta: falha(403, 'sem_permissao') };
  }
  return { atorId: contexto.context.actorId, organizacaoId: contexto.context.organizationId };
}

export async function GET(request: Request) {
  const escopo = await resolverEscopo(request);
  if (escopo.resposta) return escopo.resposta;
  try {
    const { data, error } = await supabaseServer.rpc('ler_politica_autorresposta', {
      p_organizacao_id: escopo.organizacaoId,
      p_ator_id: escopo.atorId,
    });
    if (error?.code === '42501') return falha(403, 'sem_permissao');
    const estado = Estado.safeParse(data);
    if (error || !estado.success) return falha(503, 'indisponivel');

    const [politica] = estado.data;
    return NextResponse.json({
      success: true,
      global: { ativa: politica.ativa_global, versao: politica.versao_global },
      organizacao: escopo.organizacaoId === null
        ? null
        : { ativa: politica.ativa_org, versao: politica.versao_org },
      efetiva: escopo.organizacaoId !== null && politica.ativa_global && politica.ativa_org,
    });
  } catch {
    return falha(503, 'indisponivel');
  }
}

export async function POST(request: Request) {
  const escopo = await resolverEscopo(request);
  if (escopo.resposta) return escopo.resposta;
  const comando = Comando.safeParse(await request.json().catch(() => null));
  if (!comando.success) return falha(400, 'comando_invalido');
  try {
    const { data, error } = await supabaseServer.rpc('alterar_politica_autorresposta', {
      p_organizacao_id: escopo.organizacaoId,
      p_ator_id: escopo.atorId,
      p_ativa: comando.data.ativa,
      p_versao: comando.data.versaoEsperada,
      p_motivo: comando.data.motivo,
    });
    if (error) return falha(503, 'indisponivel');
    if (data === 'sem_permissao') return falha(403, 'sem_permissao');
    if (data === 'conflito') return falha(409, 'conflito_de_versao');
    if (data !== 'aplicado') return falha(503, 'indisponivel');
    return NextResponse.json({ success: true, versao: comando.data.versaoEsperada + 1 });
  } catch {
    return falha(503, 'indisponivel');
  }
}
