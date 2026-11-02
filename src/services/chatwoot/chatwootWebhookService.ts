import crypto from 'node:crypto';
import { z } from 'zod';
import { supabaseServer } from '@/lib/supabaseServer';
import { credentialsVault, redactSensitiveData } from '@/lib/integrations/credentialsVault';
import { conexaoDesligada } from '@/lib/integrations/conexaoDesligada';
import {
  chaveDoEventoChatwoot,
  chatwootInboxService,
  type AceiteDeEntregaChatwoot,
  type EntregaChatwoot,
} from '@/services/chatwootInboxService';
import { checkRateLimit, DEFAULT_RATE_LIMIT_POLICIES, rateLimitDenialStatus } from '@/lib/rateLimit';
import { createSupabaseRateLimitStore } from '@/lib/rateLimitStore';
import { parseOptionalInt } from '@/services/chatwoot/chatwootWebhookPersistence';
import { logger, sanitizeErrorForLog } from '@/lib/observability/logger';
import {
  ChatwootCredentialsPayloadSchema,
  ChatwootWebhookEventSchema,
  type ChatwootWebhookEvent,
} from '@/services/chatwoot/chatwootPort';
import { verifyOrganizationScope, type VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

/** A framework-agnostic HTTP-shaped outcome: the inbound Adapter (route handler)
 * renders this as its protocol response without knowing webhook internals. */
export interface WebhookOutcome {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface RawDelivery {
  readonly conexaoId: string;
  /** Bytes exatos recebidos: a assinatura é conferida sobre eles, antes de decodificar. */
  readonly rawBody: Uint8Array;
  readonly signatureHeader: string | null;
  readonly timestampHeader: string | null;
  readonly deliveryHeader: string | null;
}

interface AuthenticatedWebhookRequest {
  readonly conexaoId: string;
  readonly organizacaoId: string;
  readonly scope: VerifiedOrganizationScope;
  readonly payload: ChatwootWebhookEvent;
  readonly inboxId: number | null;
  readonly entrega: EntregaChatwoot;
}

/** `X-Chatwoot-Delivery` é opcional; quando vem, tem de ser um identificador simples. */
const DeliveryIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const SIGNATURE_FORMAT = /^sha256=[0-9a-f]{64}$/;
const TIMESTAMP_FORMAT = /^[0-9]{1,12}$/;

type AuthenticateWebhookResult =
  | { readonly ok: true; readonly request: AuthenticatedWebhookRequest }
  | { readonly ok: false; readonly outcome: WebhookOutcome };

const SIDE_EFFECTING_EVENTS = new Set(['message_created', 'message_updated', 'conversation_status_changed']);

const rateLimitStore = createSupabaseRateLimitStore(supabaseServer);

/** Resposta de cada recusa do aceite: nada foi gravado, nenhuma é 2xx. */
const RECUSA_DO_ACEITE: Readonly<Record<Exclude<AceiteDeEntregaChatwoot['_tag'], 'EntregaAceita'>, WebhookOutcome>> = {
  EntregaConflitante: { status: 409, body: { success: false, error: 'Entrega repetida com outro conteúdo' } },
  ConexaoRecusada: { status: 403, body: { success: false, error: 'Conexão Chatwoot recusada' } },
  EntradaRecusada: { status: 400, body: { success: false, error: 'Evento recusado pela inbox' } },
  InboxIndisponivel: { status: 503, body: { success: false, error: 'Inbox indisponível' } },
};

function denied(status: number, error: string): { ok: false; outcome: WebhookOutcome } {
  return { ok: false, outcome: { status, body: { success: false, error } } };
}

/**
 * Minimize a parsed Chatwoot webhook event before it is durably persisted in
 * the inbox, per LGPD data-minimization: keep only fields required to make
 * the event idempotently replayable, and drop avatar/thumbnail URLs which are
 * not needed for replay.
 */
function minimizePayloadForStorage(payload: ChatwootWebhookEvent): Record<string, unknown> {
  const redacted = redactSensitiveData(payload);
  const clone: Record<string, unknown> = JSON.parse(JSON.stringify(redacted));
  const stripAvatar = (obj: unknown) => {
    if (obj && typeof obj === 'object') {
      delete (obj as Record<string, unknown>).avatar_url;
      delete (obj as Record<string, unknown>).thumbnail;
    }
  };
  stripAvatar((clone.meta as Record<string, unknown> | undefined)?.sender);
  stripAvatar((clone.conversation as Record<string, unknown> | undefined)?.contact);
  return clone;
}

/** Resolve a representative actor for audit fields (`user_id`) on a webhook-originated
 * write. Never authority for `organizacao_id` — that comes from the verified connection. */
async function resolveOwnerActorId(organizacaoId: string): Promise<string | null> {
  const { data } = await supabaseServer
    .from('membros_organizacao')
    .select('user_id')
    .eq('organizacao_id', organizacaoId)
    .eq('papel', 'owner')
    .limit(1)
    .maybeSingle();
  return data?.user_id ?? null;
}

/** Verify the HMAC signature Chatwoot attaches to a signed webhook delivery,
 * over the exact `{timestamp}.{raw_body}` message, before any parse/lookup/insert. */
function verifySignedDelivery(
  rawBody: Uint8Array,
  signatureHeader: string | null,
  timestampHeader: string | null,
  webhookSecret: string,
): boolean {
  if (!signatureHeader || !timestampHeader) return false;

  const timestampSeconds = Number.parseInt(timestampHeader, 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
  if (!Number.isFinite(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > MAX_CLOCK_SKEW_SECONDS) {
    return false;
  }

  const expectedHex = crypto.createHmac('sha256', webhookSecret).update(`${timestampHeader}.`).update(rawBody).digest('hex');
  const expectedSignature = `sha256=${expectedHex}`;
  const sigBuf = Buffer.from(signatureHeader);
  const expectedBuf = Buffer.from(expectedSignature);
  return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
}

/**
 * Localiza o segredo da conexão e confere a assinatura sobre os bytes originais.
 * Só depois disto `organizacao_id` e o status lido valem alguma coisa.
 */
async function conexaoAssinada(
  conexaoId: string,
  rawBody: Uint8Array,
  signatureHeader: string,
  timestampHeader: string,
): Promise<
  | { readonly ok: true; readonly connection: { readonly organizacao_id: string; readonly status: string }; readonly storedAccountId: string }
  | { readonly ok: false; readonly outcome: WebhookOutcome }
> {
  // 1. Resolver a conexão ANTES de qualquer confiança — apenas para localizar o
  //    segredo que autentica a requisição. organizacao_id só vira autoridade
  //    depois que a assinatura for validada com o segredo desta conexão específica.
  const { data: connection } = await supabaseServer
    .from('conexoes_integracao')
    .select('id, organizacao_id, status')
    .eq('id', conexaoId)
    .eq('provedor', 'chatwoot')
    .maybeSingle();
  if (!connection) return denied(404, 'Conexão não encontrada');

  const rawCreds = await credentialsVault.getDecryptedCredentials(connection.organizacao_id, connection.id);
  const credsParsed = rawCreds ? ChatwootCredentialsPayloadSchema.safeParse(rawCreds) : null;
  if (!credsParsed?.success) {
    console.error('❌ Webhook Chatwoot: credenciais/segredo ausentes ou inválidos para a conexão.');
    return denied(500, 'Configuração inválida no servidor');
  }
  const { webhook_secret: webhookSecret, account_id: storedAccountId } = credsParsed.data;

  // 2. Validação de Assinatura HMAC OBRIGATÓRIA sobre o raw body (fail-closed),
  //    ANTES de qualquer parse, lookup adicional ou insert.
  if (!verifySignedDelivery(rawBody, signatureHeader, timestampHeader, webhookSecret)) {
    console.error('❌ Webhook Chatwoot: Assinatura inválida ou timestamp expirado.');
    return denied(401, 'Assinatura inválida');
  }

  return { ok: true, connection, storedAccountId };
}

/** Decodifica em UTF-8 estrito, valida o contrato e confere a account da conexão. */
function eventoDaConexao(
  rawBody: Uint8Array,
  storedAccountId: string,
): { readonly ok: true; readonly payload: ChatwootWebhookEvent } | { readonly ok: false; readonly outcome: WebhookOutcome } {
  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
  } catch {
    return denied(400, 'Payload JSON inválido');
  }

  const payloadParsed = ChatwootWebhookEventSchema.safeParse(rawPayload);
  if (!payloadParsed.success) return denied(400, 'Payload não corresponde ao contrato Chatwoot esperado');
  const payload = payloadParsed.data;

  // 3. Conferir account_id do payload contra o account_id persistido da conexão —
  //    nunca aceitar inbox_id do payload como autoridade sem esse vínculo.
  if (String(payload.account.id) !== storedAccountId) {
    console.error('❌ Webhook Chatwoot: account_id do payload não corresponde à conexão.');
    return denied(403, 'Conta Chatwoot não corresponde à conexão');
  }

  return { ok: true, payload };
}

/** O owner só preenche campos de auditoria; a autoridade vem da conexão assinada. */
async function escopoDaOrganizacao(
  organizacaoId: string,
): Promise<{ readonly ok: true; readonly scope: VerifiedOrganizationScope } | { readonly ok: false; readonly outcome: WebhookOutcome }> {
  const ownerActorId = await resolveOwnerActorId(organizacaoId);
  if (!ownerActorId) {
    console.error('❌ Webhook Chatwoot: organização sem owner resolvível — ambíguo/ausente.');
    return denied(403, 'Escopo organizacional inválido');
  }

  const scopeResult = await verifyOrganizationScope(supabaseServer, { organizationId: organizacaoId, actorId: ownerActorId });
  if (scopeResult._tag !== 'OrganizationScopeVerified') {
    const unavailable = scopeResult._tag === 'OrganizationScopeStoreUnavailable';
    return denied(unavailable ? 503 : 403, unavailable ? 'Serviço de autorização indisponível' : 'Escopo organizacional inválido');
  }

  return { ok: true, scope: scopeResult.scope };
}

/**
 * Resolve the connection, verify the signed delivery over the raw body, parse
 * the payload against the Chatwoot contract, cross-check the account id, and
 * derive a verified organization scope — all before any lookup/insert that
 * would trust `organizacao_id` or `inbox_id`. See
 * `docs/integrations/chatwoot-contract.md` for the exact signing scheme.
 */
async function authenticateWebhookRequest(delivery: RawDelivery): Promise<AuthenticateWebhookResult> {
  const { conexaoId, rawBody, signatureHeader, timestampHeader, deliveryHeader } = delivery;

  // 0. Formato barato antes de qualquer consulta, decifragem ou HMAC: o corpo já
  //    veio limitado pela rota; aqui só cabeçalhos bem formados seguem adiante.
  if (!signatureHeader || !timestampHeader) return denied(401, 'Assinatura ausente');
  if (!SIGNATURE_FORMAT.test(signatureHeader) || !TIMESTAMP_FORMAT.test(timestampHeader)) {
    return denied(401, 'Assinatura inválida');
  }
  const deliveryParsed = deliveryHeader === null ? null : DeliveryIdSchema.safeParse(deliveryHeader);
  if (deliveryParsed && !deliveryParsed.success) return denied(400, 'Identificador de entrega inválido');

  const assinada = await conexaoAssinada(conexaoId, rawBody, signatureHeader, timestampHeader);
  if (!assinada.ok) return assinada;
  const { connection, storedAccountId } = assinada;

  // A partir daqui, conexaoId/organizacao_id são autoridade: a assinatura provou
  // conhecimento do segredo específico desta conexão.

  // Conexão desligada não produz efeito novo, mesmo com assinatura válida. A
  // recusa vem depois da assinatura para não revelar o estado da conexão a
  // quem não conhece o segredo.
  if (conexaoDesligada(connection.status)) {
    console.warn('⚠️ Webhook Chatwoot: entrega recusada, conexão desligada.');
    return denied(403, 'Conexão Chatwoot desligada');
  }

  // Limite por conexão, depois da assinatura: quem não tem o segredo não gasta
  // a cota da conexão. Sem o contador, recusa (fail-closed).
  const limite = await checkRateLimit(rateLimitStore, 'chatwoot_webhook', conexaoId, DEFAULT_RATE_LIMIT_POLICIES.chatwoot_webhook);
  if (limite._tag !== 'RateLimitAllowed') {
    logger.warn('chatwoot.webhook.recusada', { subsystem: 'provider', conexaoId, outcome: limite._tag });
    const status = rateLimitDenialStatus(limite);
    return denied(status, status === 429 ? 'Limite de entregas excedido' : 'Serviço de limite indisponível');
  }

  const evento = eventoDaConexao(rawBody, storedAccountId);
  if (!evento.ok) return evento;
  const { payload } = evento;

  const organizacaoId = connection.organizacao_id;
  const escopo = await escopoDaOrganizacao(organizacaoId);
  if (!escopo.ok) return escopo;

  const rawInboxId = payload.inbox?.id ?? payload.conversation?.inbox_id;
  const inboxId = parseOptionalInt(rawInboxId);
  if (SIDE_EFFECTING_EVENTS.has(payload.event) && inboxId === null) {
    console.warn('⚠️ Webhook Chatwoot: evento com efeito sem inbox_id resolvível — ausente/ambíguo.');
    return denied(400, 'Inbox não identificada');
  }

  return {
    ok: true,
    request: {
      conexaoId,
      organizacaoId,
      scope: escopo.scope,
      payload,
      inboxId,
      entrega: { deliveryId: deliveryParsed?.data ?? null, timestampAssinado: timestampHeader },
    },
  };
}

/**
 * Handle one Chatwoot webhook delivery: authenticate, then durably accept it in
 * the inbox. The 2xx means only that the delivery is committed; the consumer
 * worker (MSG-006) produces every effect. Returns a plain HTTP-shaped outcome so
 * the inbound Adapter (route handler) stays a thin protocol translation layer.
 */
export async function handleChatwootWebhookDelivery(delivery: RawDelivery): Promise<WebhookOutcome> {
  let organizacaoId: string | undefined;

  try {
    const authResult = await authenticateWebhookRequest(delivery);
    if (!authResult.ok) return authResult.outcome;

    const { conexaoId, payload, inboxId, scope, entrega } = authResult.request;
    organizacaoId = authResult.request.organizacaoId;
    const event = payload.event;

    // A entrega e o evento minimizado ficam gravados (commit) antes de qualquer
    // 2xx. Sem o aceite, a resposta é não-2xx e o Chatwoot pode reenviar.
    const aceite = await chatwootInboxService.aceitarEntrega(supabaseServer, scope, {
      conexaoId,
      inboxId,
      deliveryId: entrega.deliveryId,
      idempotencyKey: chaveDoEventoChatwoot(payload, entrega),
      eventType: event,
      payload: minimizePayloadForStorage(payload),
    });
    const logDaEntrega = { subsystem: 'provider' as const, organizacaoId, conexaoId, correlationId: entrega.deliveryId ?? undefined, recurso: event };
    if (aceite._tag !== 'EntregaAceita') {
      logger.warn('chatwoot.webhook.recusada', { ...logDaEntrega, outcome: aceite._tag });
      return RECUSA_DO_ACEITE[aceite._tag];
    }
    logger.info('chatwoot.webhook.aceita', { ...logDaEntrega, inboxEventoId: aceite.eventoId, duplicata: aceite.duplicata, status: aceite.status });

    return { status: 200, body: { success: true } };
  } catch (error: unknown) {
    logger.error('chatwoot.webhook.falha', {
      subsystem: 'provider',
      organizacaoId,
      conexaoId: delivery.conexaoId,
      erro: sanitizeErrorForLog(error),
    });
    return { status: 500, body: { success: false, error: 'Erro interno no processamento do webhook' } };
  }
}
