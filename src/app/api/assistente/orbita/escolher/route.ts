import { z } from 'zod';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { escopoTemCapacidade } from '@/lib/verifiedOrganizationScope';
import { supabaseServer } from '@/lib/supabaseServer';
import { checkRateLimit, DEFAULT_RATE_LIMIT_POLICIES, rateLimitDenialStatus } from '@/lib/rateLimit';
import { createSupabaseRateLimitStore } from '@/lib/rateLimitStore';
import { edicoesDeProdutosDoAssistente } from '@/services/assistenteAdministrativo/adaptadorDeEdicao';
import { pedidoEdicao } from '@/services/assistenteAdministrativo/edicaoDeProdutosContract';
import { criarEdicaoDeProdutos } from '@/services/assistenteAdministrativo/editarProdutos';
import { bling } from '@/services/bling';

/**
 * Depois que o ranking sugeriu candidatos, a pessoa marca um ou vários e o painel
 * pede a prévia para eles. Nada é escrito no Bling: a escrita só ocorre em
 * /confirmar, sobre a proposta persistida. Os IDs são revalidados na organização.
 */
const escolha = z.object({
  organizacaoEsperada: z.string().uuid(),
  pedido: pedidoEdicao,
  produtoIds: z.array(z.string().uuid()).min(1).max(20),
}).strict();
const headers = { 'Cache-Control': 'no-store' };

/** A prévia lê o valor atual de cada produto no Bling. */
export const maxDuration = 300;

export async function POST(request: Request) {
  const sessao = await resolveVerifiedOrganizationScope(request);
  if (sessao._tag !== 'RequestScopeResolved') return sessao.response;
  const { scope } = sessao;
  if (!escopoTemCapacidade(scope, 'organization:manage')) return Response.json({ mensagem: 'A alteração exige permissão de gestão.' }, { status: 403, headers });
  if (process.env.ORBITA_ASSISTENTE_ADMIN_ENABLED !== 'true' || process.env.ORBITA_ASSISTENTE_EDICAO_PRODUTOS_ENABLED !== 'true') {
    return Response.json({ mensagem: 'A edição pelo assistente está desabilitada.' }, { status: 503, headers });
  }
  const entrada = escolha.safeParse(await request.json().catch(() => null));
  if (!entrada.success) return Response.json({ mensagem: 'Escolha inválida. Marque de 1 a 20 produtos da lista.' }, { status: 400, headers });
  if (entrada.data.organizacaoEsperada !== scope.organizationId) return Response.json({ mensagem: 'A organização ativa mudou. Faça o pedido de novo.' }, { status: 409, headers });
  const limite = await checkRateLimit(createSupabaseRateLimitStore(supabaseServer), 'assistente_orbita',
    scope.organizationId + ':' + scope.actorId, DEFAULT_RATE_LIMIT_POLICIES.assistente_orbita);
  if (limite._tag !== 'RateLimitAllowed') return Response.json({ mensagem: 'Muitas solicitações. Tente de novo em um minuto.' }, { status: rateLimitDenialStatus(limite), headers });
  try {
    const servico = criarEdicaoDeProdutos(edicoesDeProdutosDoAssistente(supabaseServer, bling.forVerifiedOrganization(scope)));
    return Response.json(await servico.proporEscolhidos(scope, entrada.data.pedido, entrada.data.produtoIds), { headers });
  } catch {
    return Response.json({ mensagem: 'Não foi possível preparar a prévia. Nenhum comando foi enviado ao Bling.' }, { status: 503, headers });
  }
}
