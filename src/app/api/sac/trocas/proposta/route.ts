import { z } from 'zod';
import { getCorrelationId } from '@/lib/observability/correlation';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import { escopoTemCapacidade, type VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { ComandoDePropostaSchema, ResultadoDaDecisaoSchema, ResultadoDaLeituraSchema, type ComandoDeProposta } from '@/lib/integrations/contratoPersistenciaDaTroca';
import { recomendarAlternativasDaTroca } from '@/services/sac/alternativasDaTroca';

type Operacao = ComandoDeProposta | { acao: 'ler'; conversaId: string };
const statusDosErros = {
  sem_permissao: 403, entrada_invalida: 400, nao_encontrado: 404, referencia_sem_prova: 403,
  operacao_divergente: 409, conflito: 409, ja_decidida: 409, vencida: 409, fatos_alterados: 409, bloqueada: 409,
} as const;
const querySchema = z.union([
  z.strictObject({ conversaId: z.string().uuid() }),
  z.strictObject({
    conversaId: z.string().uuid(), pedidoId: z.string().uuid(), itemId: z.string().uuid(),
    quantidade: z.string().regex(/^([1-9][0-9]{0,3}|10000)$/u).transform(Number),
  }),
]);

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function executar(scope: VerifiedOrganizationScope, op: Operacao, request: Request) {
  const { data, error } = await supabaseServer.rpc('sac_proposta_resolucao', {
    p_org: scope.organizationId, p_ator: scope.actorId, p_conversa: op.conversaId, p_acao: op.acao,
    p_operacao: 'operacaoId' in op ? op.operacaoId : null, p_versao: 'versao' in op ? op.versao : null,
    p_digest: 'digest' in op ? op.digest : null, p_entrada: 'entrada' in op ? op.entrada : null,
    p_correlacao: getCorrelationId(request),
  });
  if (error) return json({ estado: 'indisponivel' }, 503);
  const parsed = (op.acao === 'ler' ? ResultadoDaLeituraSchema : ResultadoDaDecisaoSchema).safeParse(data);
  if (!parsed.success) return json({ estado: 'indisponivel' }, 503);
  const { estado } = parsed.data;
  return json(parsed.data, estado === 'ok' || estado === 'sem_proposta' ? 200 : statusDosErros[estado]);
}

export async function GET(request: Request) {
  const session = await resolveVerifiedOrganizationScope(request);
  if (session._tag !== 'RequestScopeResolved') return session.response;
  if (!escopoTemCapacidade(session.scope, 'organization:access')) return json({ estado: 'sem_permissao' }, 403);
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return json({ estado: 'entrada_invalida' }, 400);
  if (!('itemId' in query.data)) return executar(session.scope, { acao: 'ler', ...query.data }, request);
  const resultado = await recomendarAlternativasDaTroca(session.scope, query.data, {
    async ler(scope, p) {
      const { data, error } = await supabaseServer.rpc('sac_fatos_ranking', {
        p_org: scope.organizationId, p_ator: scope.actorId, p_conversa: p.conversaId,
        p_pedido: p.pedidoId, p_item: p.itemId,
      });
      if (error) throw new Error('Catálogo de compatibilidade indisponível.');
      return data;
    },
  }, new Date());
  if (resultado.estado === 'ok') return json(resultado.valor);
  return json({ estado: resultado.estado }, resultado.estado === 'indisponivel' ? 503 : 409);
}

export async function POST(request: Request) {
  const session = await resolveVerifiedOrganizationScope(request);
  if (session._tag !== 'RequestScopeResolved') return session.response;
  const op = ComandoDePropostaSchema.safeParse(await request.json().catch(() => null));
  if (!op.success) return json({ estado: 'entrada_invalida' }, 400);
  const capability = op.data.acao === 'aprovar' || op.data.acao === 'rejeitar' ? 'organization:manage' : 'organization:access';
  if (!escopoTemCapacidade(session.scope, capability)) return json({ estado: 'sem_permissao' }, 403);
  return executar(session.scope, op.data, request);
}
