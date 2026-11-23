import { proporBaixa } from '@/services/assistenteAdministrativo/baixaDeDemonstracao';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { escopoTemCapacidade } from '@/lib/verifiedOrganizationScope';
import { logger } from '@/lib/observability/logger';
import { supabaseServer } from '@/lib/supabaseServer';
import { lerSaldoDoProduto } from '@/repositories/leituraDeEstoqueAdministrativo';
import { interpretarPerguntaDeEstoque, pedidoDeEstoque } from '@/services/assistenteAdministrativo/interpretarEstoque';
import { responderConsultaDeEstoque } from '@/services/assistenteAdministrativo/responderConsultaDeEstoque';

export async function POST(request: Request) {
  const sessao = await resolveVerifiedOrganizationScope(request);
  if (sessao._tag !== 'RequestScopeResolved') return sessao.response;
  if (!escopoTemCapacidade(sessao.scope, 'organization:access')) {
    return Response.json({ mensagem: 'Acesso ao estoque não autorizado.' }, { status: 403 });
  }
  const entrada = pedidoDeEstoque.safeParse(await request.json().catch(() => null));
  if (!entrada.success) return Response.json({ mensagem: 'Escreva uma pergunta de até 240 caracteres.' }, { status: 400 });
  try {
    const intencao = await interpretarPerguntaDeEstoque(entrada.data.pergunta, request.signal);
    if (intencao.acao === 'baixar_uma' && process.env.ORBITA_BAIXA_DEMO_ENABLED === 'true') {
      if (!escopoTemCapacidade(sessao.scope, 'organization:manage')) {
        return Response.json({ mensagem: 'A baixa exige gestão da organização.' }, { status: 403 });
      }
      const pedido = entrada.data;
      if (!intencao.produto && pedido.produtoConsultado) {
        return await proporBaixa(sessao.scope, pedido.produtoConsultado);
      }
      // Uma referência explícita tem precedência sobre o produto consultado.
      const busca = await responderConsultaDeEstoque({ ...intencao, acao: 'consultar' }, pedido.pergunta,
        referencia => lerSaldoDoProduto(supabaseServer, sessao.scope, referencia));
      if (busca.estado === 'ok') return await proporBaixa(sessao.scope, busca.produto.id);
      return Response.json(busca, { headers: { 'Cache-Control': 'no-store' } });
    }
    const resposta = await responderConsultaDeEstoque(intencao, entrada.data.pergunta,
      referencia => lerSaldoDoProduto(supabaseServer, sessao.scope, referencia));
    logger.info('assistente_administrativo.consulta_estoque', { resultado: resposta.estado });
    return Response.json(resposta, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    logger.warn('assistente_administrativo.consulta_estoque', { resultado: 'indisponivel' });
    return Response.json({ mensagem: 'Não foi possível consultar o estoque agora.' }, { status: 503 });
  }
}
