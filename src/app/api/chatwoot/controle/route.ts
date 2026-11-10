import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseServer } from '../../../../lib/supabaseServer';
import { organizationContextStatus } from '../../../../lib/organizationAuthorization';
import { resolveActiveRequestOrganizationContext } from '../../../../lib/requestOrganizationContext';
import {
  escopoTemCapacidade,
  organizationContextToScope,
  type VerifiedOrganizationScope,
} from '../../../../lib/verifiedOrganizationScope';
import { automacaoDoAtendimentoAtiva } from '../../../../services/chatwoot/automacaoDoAtendimento';
import {
  alterarControle,
  ControleIndisponivel,
  lerControle,
  permissoesDoControle,
  type ControleDaConversa,
} from '../../../../services/chatwoot/controleAtendimento';

export const dynamic = 'force-dynamic';

/**
 * Assumir e exigir humano: quem acessa a organização (a mesma regra de quem
 * responde). Assumir a conversa de outra pessoa é uma transferência: vale com
 * o mesmo acesso, fica registrada com o responsável anterior, e a tela pede
 * confirmação. Devolver à automação liga de novo a autorresposta: só quem
 * gerencia, e só com automação ativa (sem ela, a conversa ficaria sem
 * ninguém). O banco confere o papel outra vez.
 */
const CAPACIDADE_DE_ATENDER = 'organization:access' as const;
const CAPACIDADE_DE_DEVOLVER = 'organization:manage' as const;

const nota = z.string().trim().min(1).max(2000);

const ControleSchema = z.discriminatedUnion('acao', [
  z.object({ acao: z.literal('assumir'), nota: nota.optional() }),
  z.object({ acao: z.literal('exigir_humano'), nota: nota.optional() }),
  z.object({ acao: z.literal('devolver'), nota }),
]).and(z.object({
  conversaId: z.string().uuid(),
  commandId: z.string().uuid(),
  versaoEsperada: z.number().int().nonnegative(),
}));

const ConsultaSchema = z.object({ conversaId: z.string().uuid() });

function recusar(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ success: false, error, ...extra }, { status });
}

async function escopoDaSessao(request: Request) {
  const contextResult = await resolveActiveRequestOrganizationContext(request);
  if (contextResult._tag !== 'OrganizationContextResolved') {
    const status = organizationContextStatus(contextResult);
    return { _tag: 'Recusado' as const, resposta: recusar(status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado', status) };
  }
  const scope = organizationContextToScope(contextResult.context);
  if (!escopoTemCapacidade(scope, CAPACIDADE_DE_ATENDER)) {
    return { _tag: 'Recusado' as const, resposta: recusar('Sem permissão para atender nesta organização.', 403) };
  }
  return { _tag: 'Autorizado' as const, scope };
}

/** O controle e o que a tela pode oferecer a partir dele. */
function comPermissoes(scope: VerifiedOrganizationScope, controle: ControleDaConversa) {
  return {
    controle,
    permissoes: permissoesDoControle(controle, escopoTemCapacidade(scope, CAPACIDADE_DE_DEVOLVER), automacaoDoAtendimentoAtiva()),
  };
}

function indisponivel() {
  return recusar('Controle do atendimento indisponível. Nada foi alterado.', 503);
}

export async function POST(request: Request) {
  const sessao = await escopoDaSessao(request);
  if (sessao._tag === 'Recusado') return sessao.resposta;

  const parsed = ControleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return recusar('Informe conversaId e commandId (UUID), acao e versaoEsperada; devolver exige resumo.', 400);
  }
  const corpo = parsed.data;
  if (corpo.acao === 'devolver' && !escopoTemCapacidade(sessao.scope, CAPACIDADE_DE_DEVOLVER)) {
    return recusar('Sem permissão para devolver o atendimento à automação.', 403);
  }
  if (corpo.acao === 'devolver' && !automacaoDoAtendimentoAtiva()) {
    return recusar('A automação ainda não responde conversas: devolver deixaria a conversa sem atendente.', 409,
      { motivo: 'automacao_inativa' });
  }

  try {
    const resultado = await alterarControle(supabaseServer, sessao.scope, {
      conversaId: corpo.conversaId,
      commandId: corpo.commandId,
      acao: corpo.acao,
      versaoEsperada: corpo.versaoEsperada,
      nota: corpo.nota ?? null,
    });
    switch (resultado._tag) {
      case 'Aplicado':
        return NextResponse.json({
          success: true,
          duplicado: resultado.duplicado,
          ...comPermissoes(sessao.scope, resultado.controle),
          invalidados: resultado.invalidados,
          emVoo: resultado.emVoo,
          notaRegistrada: resultado.notaRegistrada,
        });
      case 'ConflitoDeVersao':
        return recusar('O atendimento mudou desde que você abriu a conversa.', 409, { motivo: 'conflito_versao', ...comPermissoes(sessao.scope, resultado.controle) });
      case 'TransicaoInvalida':
        return recusar('Esta ação não vale para o estado atual do atendimento.', 409, { motivo: 'transicao_invalida', ...comPermissoes(sessao.scope, resultado.controle) });
      case 'ConflitoDeComando':
        return recusar('Este comando já foi usado com outros dados.', 409, { motivo: 'conflito_comando' });
      case 'ConversaNaoEncontrada':
        return recusar('Conversa não encontrada', 404);
      case 'SemVinculo':
        return recusar('Não autorizado', 403);
      case 'SemCapacidade':
        return recusar('Sem permissão para devolver o atendimento à automação.', 403);
    }
  } catch (error: unknown) {
    if (error instanceof ControleIndisponivel) return indisponivel();
    throw error;
  }
}

export async function GET(request: Request) {
  const sessao = await escopoDaSessao(request);
  if (sessao._tag === 'Recusado') return sessao.resposta;

  const parsed = ConsultaSchema.safeParse({ conversaId: new URL(request.url).searchParams.get('conversaId') });
  if (!parsed.success) return recusar('Parâmetro conversaId (UUID) é obrigatório.', 400);

  try {
    const leitura = await lerControle(supabaseServer, sessao.scope, parsed.data.conversaId);
    if (leitura._tag === 'ConversaNaoEncontrada') return recusar('Conversa não encontrada', 404);
    return NextResponse.json({ success: true, ...comPermissoes(sessao.scope, leitura.controle) });
  } catch (error: unknown) {
    if (error instanceof ControleIndisponivel) return indisponivel();
    throw error;
  }
}
