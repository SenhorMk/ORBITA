import { z } from 'zod';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { escopoTemCapacidade } from '@/lib/verifiedOrganizationScope';
import { supabaseServer } from '@/lib/supabaseServer';
import { checkRateLimit, DEFAULT_RATE_LIMIT_POLICIES, rateLimitDenialStatus } from '@/lib/rateLimit';
import { createSupabaseRateLimitStore } from '@/lib/rateLimitStore';
import { edicoesDeProdutosDoAssistente } from '@/services/assistenteAdministrativo/adaptadorDeEdicao';
import { criarEdicaoDeProdutos } from '@/services/assistenteAdministrativo/editarProdutos';
import { bling } from '@/services/bling';

const confirmacao = z.object({ chave: z.string().uuid(), organizacaoEsperada: z.string().uuid() }).strict();
const headers = { 'Cache-Control': 'no-store' };

/** Executa uma proposta persistida; o corpo nunca recebe produtos nem novos valores. */
export const maxDuration = 300;

/** Confirmação exclusiva ao painel, reautenticada e vinculada ao autor da proposta. */
export async function POST(request: Request) {
  const sessao = await resolveVerifiedOrganizationScope(request);
  if (sessao._tag !== 'RequestScopeResolved') return sessao.response;
  const { scope } = sessao;
  if (!escopoTemCapacidade(scope, 'organization:manage')) return Response.json({ mensagem: 'A alteração exige permissão de gestão.' }, { status: 403, headers });
  if (process.env.ORBITA_ASSISTENTE_ADMIN_ENABLED !== 'true' || process.env.ORBITA_ASSISTENTE_EDICAO_PRODUTOS_ENABLED !== 'true') {
    return Response.json({ mensagem: 'A edição pelo assistente está desabilitada.' }, { status: 503, headers });
  }
  const entrada = confirmacao.safeParse(await request.json().catch(() => null));
  if (!entrada.success) return Response.json({ mensagem: 'Confirmação inválida.' }, { status: 400, headers });
  if (entrada.data.organizacaoEsperada !== scope.organizationId) return Response.json({ mensagem: 'A organização ativa mudou. Prepare outra prévia.' }, { status: 409, headers });
  const limite = await checkRateLimit(createSupabaseRateLimitStore(supabaseServer), 'assistente_orbita',
    scope.organizationId + ':' + scope.actorId, DEFAULT_RATE_LIMIT_POLICIES.assistente_orbita);
  if (limite._tag !== 'RateLimitAllowed') return Response.json({ mensagem: 'Não foi possível confirmar agora. Tente a mesma proposta em instantes.' }, { status: rateLimitDenialStatus(limite), headers });
  try {
    const servico = criarEdicaoDeProdutos(edicoesDeProdutosDoAssistente(supabaseServer, bling.forVerifiedOrganization(scope)));
    return Response.json(await servico.confirmar(scope, entrada.data.chave), { headers });
  } catch {
    return Response.json({ mensagem: 'A confirmação precisa de conferência. Tente consultar a mesma proposta; não crie outra operação.' }, { status: 503, headers });
  }
}
