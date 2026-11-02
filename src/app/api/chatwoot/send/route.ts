import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ChatwootAdapter } from '../../../../services/chatwoot/chatwootAdapter';
import { supabaseServer } from '../../../../lib/supabaseServer';
import { organizationContextStatus } from '../../../../lib/organizationAuthorization';
import { resolveActiveRequestOrganizationContext } from '../../../../lib/requestOrganizationContext';
import { outboxService } from '../../../../services/outboxService';
import { organizationContextToScope } from '../../../../lib/verifiedOrganizationScope';
import { gravarMensagem, type EscopoDeEscritaChatwoot } from '../../../../services/chatwoot/espelhoChatwoot';
import { criarEspelhoChatwootSupabase } from '../../../../services/chatwoot/espelhoChatwootSupabase';
import { resolverPorIdLocal, type FalhaDeIdentidadeChatwoot } from '../../../../services/chatwoot/identidadeChatwoot';

export const dynamic = 'force-dynamic';

function resolveMessageType(rawType: unknown): 'incoming' | 'outgoing' | 'system' | 'template' {
  if (rawType === 'incoming' || rawType === 0 || rawType === '0') return 'incoming';
  if (rawType === 'system' || rawType === 2 || rawType === '2') return 'system';
  if (rawType === 'template' || rawType === 3 || rawType === '3') return 'template';
  return 'outgoing';
}

function resolveSenderType(senderType?: string | null): string {
  if (senderType && ['contact', 'user', 'agent'].includes(senderType)) {
    return senderType;
  }
  return 'user';
}

interface ChatwootApiMessageResponse {
  id: number;
  message_type?: string | number;
  sender?: {
    name?: string;
    id?: number;
    type?: string;
  };
  created_at?: string;
}

/** O navegador referencia a conversa só pelo UUID local; id remoto não é aceito. */
const EnvioSchema = z.object({
  conversaId: z.string().uuid(),
  content: z.string().trim().min(1),
});

const espelho = criarEspelhoChatwootSupabase(supabaseServer);

/**
 * Status HTTP de uma referência que não pôde ser traduzida para esta
 * organização. 422, e não 409: na tela, 409 significa integração indisponível.
 */
function statusDaFalha(falha: FalhaDeIdentidadeChatwoot): number {
  if (falha === 'IdentidadeNaoEncontrada') return 404;
  if (falha === 'StoreIndisponivel') return 503;
  return 422;
}

/** A mensagem enviada entra no espelho pelo UUID local, ligada à conversa desta conexão. */
async function saveMessageLocally(
  rawMsg: ChatwootApiMessageResponse,
  escopo: EscopoDeEscritaChatwoot,
  conversa: { readonly idLocal: string; readonly idExterno: number },
  content: string,
): Promise<string> {
  const mensagemIdLocal = await gravarMensagem(espelho, escopo, {
    idExterno: rawMsg.id,
    conversaIdExterno: conversa.idExterno,
    conteudo: content,
    tipo: resolveMessageType(rawMsg.message_type),
    remetenteNome: rawMsg.sender?.name || 'Atendente Orbita',
    remetenteId: rawMsg.sender?.id || null,
    remetenteTipo: resolveSenderType(rawMsg.sender?.type),
    criadaEm: rawMsg.created_at || new Date().toISOString(),
  }, 'preservar');
  await espelho.atualizar('conversa', escopo, conversa.idLocal, { updated_at: new Date().toISOString() });
  return mensagemIdLocal;
}

export async function POST(request: Request) {
  try {
    const contextResult = await resolveActiveRequestOrganizationContext(request);
    if (contextResult._tag !== 'OrganizationContextResolved') {
      const status = organizationContextStatus(contextResult);
      return NextResponse.json(
        { success: false, error: status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado' },
        { status },
      );
    }

    const parsed = EnvioSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Parâmetros conversaId (UUID local) e content são obrigatórios.' },
        { status: 400 },
      );
    }
    const { conversaId, content } = parsed.data;

    const scope = organizationContextToScope(contextResult.context);

    // Organização da sessão; conexão e id remoto da própria conversa, no servidor.
    const conversa = await resolverPorIdLocal(espelho, scope.organizationId, 'conversa', conversaId);
    if (conversa._tag === 'IdLocalNaoTraduzido') {
      return NextResponse.json(
        { success: false, error: conversa.falha === 'IdentidadeNaoEncontrada' ? 'Conversa não encontrada' : 'Conversa sem identidade Chatwoot resolvida', motivo: conversa.falha },
        { status: statusDaFalha(conversa.falha) },
      );
    }
    const escopo = { ...conversa.escopo, atorId: scope.actorId };

    const idempotencyKey = `chatwoot_msg_${conversaId}_${Date.now()}`;
    const outboxRecord = await outboxService.enqueue(supabaseServer, scope, {
      idempotencyKey,
      destination: 'chatwoot',
      eventType: 'message.send',
      payload: { conversaIdLocal: conversaId, conexaoId: escopo.conexaoId, content },
    });

    // Envio síncrono inline (não passa por reivindicar_lote_outbox/lease):
    // o identificador de worker é fixo e só serve para auditoria — o evento
    // nunca está em `processing` neste caminho, então a checagem de posse de
    // lease em `concluir_evento_outbox` não se aplica aqui.
    const INLINE_SEND_WORKER_ID = 'chatwoot-http-inline-send';

    // O adapter é o da conexão da conversa: credenciais de outra instalação nunca.
    const adapter = await ChatwootAdapter.forScope(scope, escopo.conexaoId);
    if (!adapter) {
      await outboxService.markFailed(supabaseServer, scope, INLINE_SEND_WORKER_ID, outboxRecord.eventoId, 'Chatwoot não configurado para esta organização', 0);
      return NextResponse.json({ success: false, error: 'Integração Chatwoot não configurada' }, { status: 409 });
    }

    const sendResult = await adapter.sendMessage(conversa.idExterno, content);
    if (sendResult._tag !== 'ChatwootSuccess') {
      await outboxService.markFailed(supabaseServer, scope, INLINE_SEND_WORKER_ID, outboxRecord.eventoId, sendResult.message || sendResult.reason, 0);
      return NextResponse.json(
        { success: false, error: sendResult.message || `Falha ao enviar mensagem no Chatwoot (${sendResult.reason})` },
        { status: sendResult.status || 502 },
      );
    }

    const rawMsg: ChatwootApiMessageResponse = sendResult.data;
    await outboxService.markSent(supabaseServer, scope, INLINE_SEND_WORKER_ID, outboxRecord.eventoId, {
      id: rawMsg.id,
      created_at: rawMsg.created_at,
    });

    const mensagemIdLocal = await saveMessageLocally(rawMsg, escopo, { idLocal: conversaId, idExterno: conversa.idExterno }, content);

    // A resposta ao navegador carrega só o UUID local.
    return NextResponse.json({
      success: true,
      message: {
        id_local: mensagemIdLocal,
        conversa_id_local: conversaId,
        content,
        message_type: resolveMessageType(rawMsg.message_type),
        sender_name: rawMsg.sender?.name || 'Atendente Orbita',
        created_at: rawMsg.created_at || new Date().toISOString(),
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro ao enviar mensagem';
    console.error('❌ Erro na API de envio de mensagem do Chatwoot:', error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
