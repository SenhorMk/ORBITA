import { checkRateLimit, DEFAULT_RATE_LIMIT_POLICIES, rateLimitDenialStatus } from '@/lib/rateLimit';
import { createSupabaseRateLimitStore } from '@/lib/rateLimitStore';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import { escopoTemCapacidade } from '@/lib/verifiedOrganizationScope';
import { lerSaldoDoProduto } from '@/repositories/leituraDeEstoqueAdministrativo';
import { IntervaloComMuitosRegistros, leiturasDoAssistente } from '@/repositories/leiturasDoAssistenteOrbita';
import { consultarAssistente } from '@/services/assistenteAdministrativo/consultarAssistenteOrbita';
import { pedidoAssistente, type RespostaAssistente } from '@/services/assistenteAdministrativo/contratoAssistenteOrbita';
import { selecionarFerramenta } from '@/services/assistenteAdministrativo/selecionarFerramenta';
import { bling } from '@/services/bling';
import { edicoesDeProdutosDoAssistente } from '@/services/assistenteAdministrativo/adaptadorDeEdicao';
import { criarEdicaoDeProdutos } from '@/services/assistenteAdministrativo/editarProdutos';
import { proporEstoqueEmLote } from '@/services/assistenteAdministrativo/estoqueEmLote';

/** Lotes possuem leituras e escritas sequenciais com limite por chamada. */
export const maxDuration = 300;

const dataDeSaoPaulo = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' });

function responder(resposta: RespostaAssistente, status = 200) {
  return Response.json(resposta, { status, headers: { 'Cache-Control': 'no-store' } });
}

function pedeDadosPessoais(pergunta: string) {
  return /\b(?:cpf|cnpj|telefone|celular|email|e-mail|endere[cç]o|documento pessoal|whatsapp)\b/iu.test(pergunta)
    || /[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b|\(\d{2}\)\s*\d{4,5}[- ]?\d{4}/iu.test(pergunta);
}

export async function POST(request: Request) {
  const sessao = await resolveVerifiedOrganizationScope(request);
  if (sessao._tag !== 'RequestScopeResolved') return sessao.response;
  const { scope } = sessao;
  if (!escopoTemCapacidade(scope, 'organization:access')) return responder({ mensagem: 'Acesso ao assistente não autorizado.' }, 403);
  if (process.env.ORBITA_ASSISTENTE_ADMIN_ENABLED !== 'true') {
    return responder({ mensagem: 'O Assistente ORBITA ainda não foi habilitado neste ambiente.' }, 503);
  }
  const entrada = pedidoAssistente.safeParse(await request.json().catch(() => null));
  if (!entrada.success) return responder({ mensagem: 'Escreva um pedido de até 4500 caracteres.' }, 400);
  if (entrada.data.organizacaoEsperada !== scope.organizationId) return responder({
    mensagem: 'A organização ativa mudou. Abra o assistente na organização atual.',
  }, 409);

  const { pergunta } = entrada.data;
  if (pedeDadosPessoais(pergunta)) return responder({
    mensagem: 'Consulte dados pessoais na área de clientes com as permissões da sua conta. Aqui posso consultar vendas, estoque e pedidos.',
  });

  const limite = await checkRateLimit(createSupabaseRateLimitStore(supabaseServer), 'assistente_orbita',
    scope.organizationId + ':' + scope.actorId, DEFAULT_RATE_LIMIT_POLICIES.assistente_orbita);
  if (limite._tag !== 'RateLimitAllowed') return responder({
    mensagem: limite._tag === 'RateLimitBlocked' ? 'Limite de perguntas atingido. Tente novamente em um minuto.'
      : 'O assistente está indisponível. Tente novamente em instantes.',
  }, rateLimitDenialStatus(limite));

  const hoje = dataDeSaoPaulo.format(new Date());
  const sinal = AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]);
  try {
    const ferramenta = await selecionarFerramenta(pergunta, hoje, sinal);
    if (ferramenta.acao === 'editar_produtos' || ferramenta.acao === 'estoque_em_lote') {
      if (!escopoTemCapacidade(scope, 'organization:manage')) return responder({ mensagem: 'A alteração de produtos exige permissão de gestão.' }, 403);
      if (process.env.ORBITA_ASSISTENTE_EDICAO_PRODUTOS_ENABLED !== 'true') return responder({ mensagem: 'A edição de produtos pelo assistente ainda não está habilitada neste ambiente.' }, 503);
      const portas = edicoesDeProdutosDoAssistente(supabaseServer, bling.forVerifiedOrganization(scope));
      return responder(ferramenta.acao === 'estoque_em_lote'
        ? await proporEstoqueEmLote(portas, scope, ferramenta, pergunta)
        : await criarEdicaoDeProdutos(portas).propor(scope, ferramenta, pergunta));
    }
    const resposta = await consultarAssistente(ferramenta, pergunta, hoje, {
      leituras: leiturasDoAssistente(supabaseServer, scope, sinal),
      estoque: referencia => lerSaldoDoProduto(supabaseServer, scope, referencia),
      detalheBling: id => bling.forVerifiedOrganization(scope).getPedido(id, sinal),
    });
    return responder(resposta);
  } catch (erro) {
    if (erro instanceof IntervaloComMuitosRegistros) {
      return responder({ mensagem: 'A consulta tem registros demais para calcular com segurança. Use um período menor ou o painel correspondente.' });
    }
    return responder({ mensagem: 'Não consegui consultar os dados agora. Tente novamente em instantes.' }, 503);
  }
}
