import { z } from 'zod';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { supabaseServer } from '@/lib/supabaseServer';

const recibo = z.object({
  chave: z.string().uuid(), auditoriaId: z.string().uuid(), produto: z.string(),
  quantidade: z.number().int(), saldoDisponivel: z.number().int(),
});
const proposta = recibo.omit({ auditoriaId: true }).extend({ expiraEm: z.string() });

export type PropostaDeBaixa = z.infer<typeof proposta>;
export type ReciboDeBaixa = z.infer<typeof recibo>;

export async function proporBaixa(escopo: VerifiedOrganizationScope, produto: string) {
  const { data, error } = await supabaseServer.rpc('propor_baixa_estoque_demo', {
    p_org: escopo.organizationId, p_ator: escopo.actorId, p_produto: produto, p_quantidade: 1,
  });
  if (error) return respostaDaFalha(error.code);
  return Response.json({ estado: 'proposta', proposta: proposta.parse(data) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function confirmarBaixa(escopo: VerifiedOrganizationScope, chave: string) {
  const { data, error } = await supabaseServer.rpc('confirmar_baixa_estoque_demo', {
    p_org: escopo.organizationId, p_ator: escopo.actorId, p_chave: chave,
  });
  if (error) return respostaDaFalha(error.code);
  return Response.json({ estado: 'baixado', recibo: recibo.parse(data) }, { headers: { 'Cache-Control': 'no-store' } });
}

function respostaDaFalha(codigo: string) {
  switch (codigo) {
    case '42501': return Response.json({ mensagem: 'Baixa restrita a gestores e produtos habilitados da demonstração.' }, { status: 403 });
    case 'P0002': return Response.json({ mensagem: 'Proposta não localizada para esta sessão.' }, { status: 404 });
    case '22023': return Response.json({ mensagem: 'Proposta expirada ou inválida. Solicite uma nova.' }, { status: 409 });
    case '23514': return Response.json({ mensagem: 'Saldo disponível insuficiente. Consulte o produto novamente.' }, { status: 409 });
    default: return Response.json({ mensagem: 'Resultado ainda indisponível. Se confirmou, tente a mesma confirmação.' }, { status: 503 });
  }
}
