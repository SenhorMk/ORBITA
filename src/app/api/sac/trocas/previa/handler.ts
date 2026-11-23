import { getCorrelationId } from '@/lib/observability/correlation';
import { logger } from '@/lib/observability/logger';
import { SolicitacaoDeTrocaSchema } from '@/lib/integrations/contratoDaPropostaDeTroca';
import type { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { escopoTemCapacidade } from '@/lib/verifiedOrganizationScope';
import { prepararPreviaDaTroca, type LeiturasDaPreviaDeTroca } from '@/services/sac/previaDaTroca';

export function criarRotaDaPrevia(
  resolver: typeof resolveVerifiedOrganizationScope, leituras: LeiturasDaPreviaDeTroca,
) {
  return async function post(request: Request): Promise<Response> {
    const sessao = await resolver(request);
    if (sessao._tag !== 'RequestScopeResolved') return sessao.response;
    if (!escopoTemCapacidade(sessao.scope, 'organization:access')) {
      return Response.json({ erro: 'Sem permissão de atendimento.' }, { status: 403 });
    }
    const entrada = SolicitacaoDeTrocaSchema.safeParse(await request.json().catch(() => null));
    if (!entrada.success) return Response.json({ erro: 'Confira os dados da solicitação.' }, { status: 400 });
    const campos = {
      correlationId: getCorrelationId(request), organizacaoId: sessao.scope.organizationId,
      actorId: sessao.scope.actorId, conversaId: entrada.data.conversaId,
    };
    try {
      const resultado = await prepararPreviaDaTroca(sessao.scope, entrada.data, leituras);
      logger.info('sac.troca.previa', { ...campos, outcome: resultado.estado });
      if (resultado.estado !== 'ok') return Response.json({ erro: 'Caso, pedido ou item indisponível nesta conversa.' }, { status: 404 });
      return Response.json(resultado.previa, { headers: { 'Cache-Control': 'no-store' } });
    } catch {
      logger.warn('sac.troca.previa', { ...campos, outcome: 'indisponivel' });
      return Response.json({ erro: 'Não foi possível preparar a proposta agora.' }, { status: 503 });
    }
  };
}
