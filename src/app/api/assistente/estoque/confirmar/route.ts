import { z } from 'zod';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { escopoTemCapacidade } from '@/lib/verifiedOrganizationScope';
import { confirmarBaixa } from '@/services/assistenteAdministrativo/baixaDeDemonstracao';

const entrada = z.object({ chave: z.string().uuid() }).strict();

export async function POST(request: Request) {
  const sessao = await resolveVerifiedOrganizationScope(request);
  if (sessao._tag !== 'RequestScopeResolved') return sessao.response;
  if (process.env.ORBITA_BAIXA_DEMO_ENABLED !== 'true' || !escopoTemCapacidade(sessao.scope, 'organization:manage')) {
    return Response.json({ mensagem: 'Confirmação de baixa indisponível nesta sessão.' }, { status: 403 });
  }
  const pedido = entrada.safeParse(await request.json().catch(() => null));
  if (!pedido.success) return Response.json({ mensagem: 'Envie somente a chave da proposta.' }, { status: 400 });
  try {
    return await confirmarBaixa(sessao.scope, pedido.data.chave);
  } catch {
    return Response.json({ mensagem: 'Resultado ainda indisponível. Tente a mesma confirmação.' }, { status: 503 });
  }
}
