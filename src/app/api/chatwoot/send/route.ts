import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ChatwootAdapter } from '../../../../services/chatwoot/chatwootAdapter';
import { supabaseServer } from '../../../../lib/supabaseServer';
import { organizationContextStatus } from '../../../../lib/organizationAuthorization';
import { resolveActiveRequestOrganizationContext } from '../../../../lib/requestOrganizationContext';
import { outboxService } from '../../../../services/outboxService';
import { organizationContextToScope, type VerifiedOrganizationScope } from '../../../../lib/verifiedOrganizationScope';
import { gravarMensagem, type EscopoDeEscritaChatwoot } from '../../../../services/chatwoot/espelhoChatwoot';
import { criarEspelhoChatwootSupabase } from '../../../../services/chatwoot/espelhoChatwootSupabase';
import { resolverPorIdLocal, type FalhaDeIdentidadeChatwoot } from '../../../../services/chatwoot/identidadeChatwoot';
import { desfechoDeFalhaAposDespacho, desfechoDoEnvioChatwoot, type DesfechoDoDespacho } from '../../../../services/outbox/desfechoDoEfeito';
import { recordSystemAuditEvent } from '../../../../services/auditService';

export const dynamic = 'force-dynamic';

/** Dono fixo do envio inline; a posse é provada pelo fencing token, não pelo nome. */
const INLINE_SEND_WORKER_ID = 'chatwoot-http-inline-send';

/** Rastro do efeito ambíguo, sem payload nem conteúdo. Falhar aqui não muda a resposta. */
async function registrarEfeitoDesconhecido(eventoId: string, organizationId: string, desfecho: DesfechoDoDespacho) {
  await recordSystemAuditEvent(supabaseServer, {
    organizationId,
    source: 'worker',
    acao: 'outbox.effect_unknown',
    recurso: 'outbox_evento',
    recursoId: eventoId,
    metadata: { destino: 'chatwoot', tipo: 'message.send', motivo: desfecho._tag === 'Desconhecido' ? desfecho.motivo : 'sem_recibo_gravado' },
  }).catch(() => console.error('❌ outbox: auditoria do efeito desconhecido falhou.'));
}

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
    conteudoRevisaoEm: null,
  }, 'preservar');
  await espelho.atualizar('conversa', escopo, conversa.idLocal, { updated_at: new Date().toISOString() });
  return mensagemIdLocal;
}

const JA_REGISTRADO = 'Este envio já está registrado e não pode ser repetido.';

/**
 * Envio inline com o mesmo protocolo do worker (MSG-007): reivindicar, gravar
 * `in_flight` antes da rede e concluir por compare-and-set do fencing token.
 * Só um recibo gravado confirma; o resto vira a resposta HTTP do desfecho. O
 * consumidor real, que tira este envio da requisição, é do MSG-008.
 */
async function despacharPelaOutbox(
  scope: VerifiedOrganizationScope,
  conexaoId: string,
  eventoId: string,
  conversaIdExterno: number,
  content: string,
): Promise<{ readonly _tag: 'Confirmado'; readonly mensagem: ChatwootApiMessageResponse } | { readonly _tag: 'Responder'; readonly resposta: NextResponse }> {
  const responder = (corpo: Record<string, unknown>, status: number) =>
    ({ _tag: 'Responder' as const, resposta: NextResponse.json({ success: false, ...corpo }, { status }) });

  const fencingToken = await outboxService.claimOne(supabaseServer, scope, eventoId, INLINE_SEND_WORKER_ID);
  if (fencingToken === null) return responder({ error: JA_REGISTRADO }, 409);
  const posse = { eventoId, workerId: INLINE_SEND_WORKER_ID, fencingToken };

  // O adapter é o da conexão da conversa: credenciais de outra instalação nunca.
  const adapter = await ChatwootAdapter.forScope(scope, conexaoId);
  if (!adapter) {
    await outboxService.concludeAttempt(supabaseServer, posse, {
      _tag: 'Recusado', categoria: 'permanent', codigo: 'nao_configurado', erro: 'Chatwoot não configurado para esta organização.',
    });
    return responder({ error: 'Integração Chatwoot não configurada' }, 409);
  }

  if (!(await outboxService.startDispatch(supabaseServer, eventoId, INLINE_SEND_WORKER_ID, fencingToken))) {
    return responder({ error: JA_REGISTRADO }, 409);
  }
  // Daqui em diante o pedido pode ter saído: nenhuma exceção vira 500 com
  // "tente de novo". Sem desfecho gravado, o reaper leva o evento a `unknown`.
  const sendResult = await adapter.sendMessage(conversaIdExterno, content).catch(() => null);
  const desfecho = sendResult ? desfechoDoEnvioChatwoot(sendResult) : desfechoDeFalhaAposDespacho();
  const gravado = await outboxService.concludeAttempt(supabaseServer, posse, desfecho).catch(() => null);

  if (desfecho._tag === 'Recusado' && gravado === 'dead_letter') {
    const status = sendResult?._tag === 'ChatwootFailed' && sendResult.status ? sendResult.status : 502;
    return responder({ desfecho: 'recusado', error: `O Chatwoot recusou a mensagem (${desfecho.codigo}).` }, status);
  }
  if (sendResult?._tag !== 'ChatwootSuccess' || gravado !== 'sent') {
    // Sem recibo gravado, o efeito pode ter acontecido: o navegador não pode
    // tratar como falha repetível. 202 = aceito, desfecho pendente.
    await registrarEfeitoDesconhecido(eventoId, scope.organizationId, desfecho);
    return responder({
      desfecho: 'desconhecido',
      eventoId,
      error: 'Não foi possível confirmar a entrega. A mensagem pode ter chegado: não reenvie; confira em Integrações.',
    }, 202);
  }
  return { _tag: 'Confirmado', mensagem: sendResult.data };
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

    const envio = await despacharPelaOutbox(scope, escopo.conexaoId, outboxRecord.eventoId, conversa.idExterno, content);
    if (envio._tag === 'Responder') return envio.resposta;
    const rawMsg = envio.mensagem;

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
