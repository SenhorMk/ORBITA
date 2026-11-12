import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseServer } from '../../../../lib/supabaseServer';
import { organizationContextStatus } from '../../../../lib/organizationAuthorization';
import { resolveActiveRequestOrganizationContext } from '../../../../lib/requestOrganizationContext';
import { escopoTemCapacidade, organizationContextToScope } from '../../../../lib/verifiedOrganizationScope';
import {
  listarEnviosDaConversa,
  registrarEnvio,
  RegistroDeEnvioIndisponivel,
} from '../../../../services/chatwoot/envioChatwoot';

export const dynamic = 'force-dynamic';

/**
 * Responder pelo cockpit é para quem acessa a organização. Uma capacidade
 * própria de atendimento (ex.: só atendentes) é decisão de produto pendente.
 */
const CAPACIDADE_DE_ENVIO = 'organization:access' as const;

/**
 * O navegador referencia a conversa só pelo UUID local e manda o `commandId`
 * que gerou antes da rede; uma repetição reusa o mesmo.
 */
const EnvioSchema = z.object({
  conversaId: z.string().uuid(),
  commandId: z.string().uuid(),
  content: z.string().trim().min(1).max(4096),
});

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
  if (!escopoTemCapacidade(scope, CAPACIDADE_DE_ENVIO)) {
    return { _tag: 'Recusado' as const, resposta: recusar('Sem permissão para responder nesta organização.', 403) };
  }
  return { _tag: 'Autorizado' as const, scope };
}

/**
 * Registra a intenção de envio e responde 202: o Chatwoot é chamado pelo
 * worker, nunca nesta requisição. A resposta nunca afirma entrega.
 */
export async function POST(request: Request) {
  const sessao = await escopoDaSessao(request);
  if (sessao._tag === 'Recusado') return sessao.resposta;

  const parsed = EnvioSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return recusar('Parâmetros conversaId e commandId (UUID) e content são obrigatórios.', 400);
  }
  const { conversaId, commandId, content } = parsed.data;

  try {
    const registro = await registrarEnvio(supabaseServer, sessao.scope, { conversaId, commandId, conteudo: content });
    switch (registro._tag) {
      case 'Registrado':
        return NextResponse.json({ success: true, envio: registro.envio }, { status: 202 });
      case 'Conflito':
        return recusar('Este envio já foi registrado com outro conteúdo.', 409, { motivo: 'comando_divergente' });
      case 'ConversaNaoEncontrada':
        return recusar('Conversa não encontrada', 404);
      case 'ConexaoIndisponivel':
        return recusar('Integração Chatwoot indisponível para esta conversa.', 409, { motivo: 'conexao_indisponivel' });
      case 'SemVinculo':
        return recusar('Não autorizado', 403);
      case 'OutroResponsavel':
        return recusar('Esta conversa está com outro atendente. Assuma o atendimento para responder.', 409, { motivo: 'outro_responsavel' });
    }
  } catch (error: unknown) {
    if (!(error instanceof RegistroDeEnvioIndisponivel)) throw error;
    // Nada foi enviado: o registro é a única coisa que esta rota faz.
    return recusar('Não foi possível registrar o envio. Nada foi enviado.', 503);
  }
}

/** Os envios da conversa, para a tela acompanhar o desfecho e sobreviver ao reload. */
export async function GET(request: Request) {
  const sessao = await escopoDaSessao(request);
  if (sessao._tag === 'Recusado') return sessao.resposta;

  const parsed = ConsultaSchema.safeParse({ conversaId: new URL(request.url).searchParams.get('conversaId') });
  if (!parsed.success) return recusar('Parâmetro conversaId (UUID local) é obrigatório.', 400);

  try {
    const envios = await listarEnviosDaConversa(supabaseServer, sessao.scope, parsed.data.conversaId);
    return NextResponse.json({ success: true, envios });
  } catch (error: unknown) {
    if (!(error instanceof RegistroDeEnvioIndisponivel)) throw error;
    return recusar('Não foi possível consultar os envios.', 503);
  }
}
