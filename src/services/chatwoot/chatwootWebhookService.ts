import crypto from 'node:crypto';
import { supabaseServer } from '@/lib/supabaseServer';
import { credentialsVault, redactSensitiveData } from '@/lib/integrations/credentialsVault';
import { conexaoDesligada } from '@/lib/integrations/conexaoDesligada';
import { chatwootInboxService, generateChatwootIdempotencyKey } from '@/services/chatwootInboxService';
import { registerChatwootInboxIfNeeded } from '@/services/chatwoot/chatwootInboxRegistration';
import { parseOptionalInt, persistWebhookEffects } from '@/services/chatwoot/chatwootWebhookPersistence';
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
  readonly rawBody: string;
  readonly signatureHeader: string | null;
  readonly timestampHeader: string | null;
}

interface AuthenticatedWebhookRequest {
  readonly conexaoId: string;
  readonly organizacaoId: string;
  readonly scope: VerifiedOrganizationScope;
  readonly payload: ChatwootWebhookEvent;
  readonly inboxId: number | null;
}

type AuthenticateWebhookResult =
  | { readonly ok: true; readonly request: AuthenticatedWebhookRequest }
  | { readonly ok: false; readonly outcome: WebhookOutcome };

const SIDE_EFFECTING_EVENTS = new Set(['message_created', 'message_updated', 'conversation_status_changed']);

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
  rawBody: string,
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

  const expectedHex = crypto.createHmac('sha256', webhookSecret).update(`${timestampHeader}.${rawBody}`).digest('hex');
  const expectedSignature = `sha256=${expectedHex}`;
  const sigBuf = Buffer.from(signatureHeader);
  const expectedBuf = Buffer.from(expectedSignature);
  return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
}

/**
 * Resolve the connection, verify the signed delivery over the raw body, parse
 * the payload against the Chatwoot contract, cross-check the account id, and
 * derive a verified organization scope — all before any lookup/insert that
 * would trust `organizacao_id` or `inbox_id`. See
 * `docs/integrations/chatwoot-contract.md` for the exact signing scheme.
 */
async function authenticateWebhookRequest(delivery: RawDelivery): Promise<AuthenticateWebhookResult> {
  const { conexaoId, rawBody, signatureHeader, timestampHeader } = delivery;

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
  if (!signatureHeader || !timestampHeader) return denied(401, 'Assinatura ausente');
  if (!verifySignedDelivery(rawBody, signatureHeader, timestampHeader, webhookSecret)) {
    console.error('❌ Webhook Chatwoot: Assinatura inválida ou timestamp expirado.');
    return denied(401, 'Assinatura inválida');
  }

  // A partir daqui, conexaoId/organizacao_id são autoridade: a assinatura provou
  // conhecimento do segredo específico desta conexão.

  // Conexão desligada não produz efeito novo, mesmo com assinatura válida. A
  // recusa vem depois da assinatura para não revelar o estado da conexão a
  // quem não conhece o segredo.
  if (conexaoDesligada(connection.status)) {
    console.warn('⚠️ Webhook Chatwoot: entrega recusada, conexão desligada.');
    return denied(403, 'Conexão Chatwoot desligada');
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(rawBody);
  } catch {
    return denied(400, 'Payload JSON inválido');
  }

  const payloadParsed = ChatwootWebhookEventSchema.safeParse(rawPayload);
  if (!payloadParsed.success) return denied(400, 'Payload não corresponde ao contrato Chatwoot esperado');
  const payload = payloadParsed.data;

  // 3. Conferir account_id do payload contra o account_id persistido da conexão —
  //    nunca aceitar inbox_id do payload como autoridade sem esse vínculo.
  if (String(payload.account.id) !== String(storedAccountId)) {
    console.error('❌ Webhook Chatwoot: account_id do payload não corresponde à conexão.');
    return denied(403, 'Conta Chatwoot não corresponde à conexão');
  }

  const organizacaoId = connection.organizacao_id;
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

  const rawInboxId = payload.inbox?.id ?? payload.conversation?.inbox_id;
  const inboxId = parseOptionalInt(rawInboxId);
  if (SIDE_EFFECTING_EVENTS.has(payload.event) && inboxId === null) {
    console.warn('⚠️ Webhook Chatwoot: evento com efeito sem inbox_id resolvível — ausente/ambíguo.');
    return denied(400, 'Inbox não identificada');
  }

  return {
    ok: true,
    request: { conexaoId, organizacaoId, scope: scopeResult.scope, payload, inboxId },
  };
}

async function processStatusChangedEvent(
  request: AuthenticatedWebhookRequest,
  inboxEventoId: string | null,
): Promise<WebhookOutcome> {
  const { organizacaoId, payload, scope } = request;
  const conversationData = payload.conversation;
  if (conversationData?.id) {
    const convId = parseOptionalInt(conversationData.id);
    if (convId !== null) {
      const { error: statusError } = await supabaseServer
        .from('chatwoot_conversations')
        .update({ status: conversationData.status || 'open', updated_at: new Date().toISOString() })
        .eq('id', convId)
        .eq('organizacao_id', organizacaoId);
      if (statusError) throw statusError;
    }
  }
  if (inboxEventoId) {
    await chatwootInboxService.markProcessed(supabaseServer, scope, inboxEventoId, {
      success: true,
      event: 'conversation_status_changed',
    });
  }
  return { status: 200, body: { success: true } };
}

/**
 * Handle one Chatwoot webhook delivery end to end: authenticate, register the
 * inbox mapping, apply the idempotent inbox pattern, persist effects, and mark
 * the inbox event processed/failed. Returns a plain HTTP-shaped outcome so the
 * inbound Adapter (route handler) stays a thin protocol translation layer.
 */
export async function handleChatwootWebhookDelivery(delivery: RawDelivery): Promise<WebhookOutcome> {
  let inboxEventoId: string | null = null;
  let scope: VerifiedOrganizationScope | null = null;

  try {
    const authResult = await authenticateWebhookRequest(delivery);
    if (!authResult.ok) return authResult.outcome;

    const { conexaoId, organizacaoId, payload, inboxId } = authResult.request;
    scope = authResult.request.scope;
    const event = payload.event;

    if (inboxId !== null) {
      await registerChatwootInboxIfNeeded(supabaseServer, scope, { conexaoId, inboxId, accountId: String(payload.account.id) });
    }

    const idempotencyKey = generateChatwootIdempotencyKey(payload);
    const minimizedPayload = minimizePayloadForStorage(payload);

    const inboxResult = await chatwootInboxService.registerEvent(supabaseServer, scope, {
      conexaoId,
      inboxId: inboxId ?? undefined,
      idempotencyKey,
      eventType: event,
      payload: minimizedPayload,
    });
    inboxEventoId = inboxResult.eventoId;

    // Duplicata segura: replay é no-op, retorna resultado cacheado.
    if (inboxResult.isDuplicate && inboxResult.status === 'processed') {
      return { status: 200, body: inboxResult.cachedResponse || { success: true } };
    }

    if (event === 'conversation_status_changed') {
      return await processStatusChangedEvent(authResult.request, inboxEventoId);
    }

    const effects = await persistWebhookEffects(payload, organizacaoId, conexaoId, scope.actorId, inboxId);

    if (inboxEventoId) {
      await chatwootInboxService.markProcessed(supabaseServer, scope, inboxEventoId, { success: true, event, ...effects });
    }

    return { status: 200, body: { success: true } };
  } catch (error: unknown) {
    if (inboxEventoId && scope) {
      try {
        await chatwootInboxService.markFailed(supabaseServer, scope, inboxEventoId, error);
      } catch (markErr) {
        console.error('❌ Falha ao gravar status de falha no inbox Chatwoot:', markErr);
      }
    }
    const message = error instanceof Error ? error.message : 'Erro interno no processamento do webhook';
    console.error('❌ Erro de processamento no Webhook do Chatwoot:', message);
    return { status: 500, body: { success: false, error: message } };
  }
}
