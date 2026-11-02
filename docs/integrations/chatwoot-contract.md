# Chatwoot integration contract

Provado contra o Chatwoot CE 4.19.1 real em `docs/operations/msg-001-runbook.md`
(`npm run test:chatwoot`). Onde isso diverge do texto abaixo, vale a prova. Payloads
capturados: `src/services/chatwoot/__fixtures__/chatwoot-v4.19.1-webhooks.json`.

Verified against `developers.chatwoot.com` (Application API introduction,
`/api-reference/webhooks/add-a-webhook`) and public webhook payload examples
(chatwoot/chatwoot GitHub issues #4267, #13993, #3140) on 2026-08-27, plus the
behavior already exercised by ORBITA's existing adapter
(`src/services/chatwoot.ts` pre-refactor). Chatwoot does not publish a fixed
version number for the Application API; this contract targets the currently
documented `api/v1` surface. If the provider changes a field name, update the
Zod schema in `src/services/chatwoot/chatwootPort.ts` and this file together.

## Authentication

- Header: `api_access_token: <token>` (account/user access token generated in
  Chatwoot's own admin UI, one per organization's connection — never a value
  ORBITA can silently share across organizations).
- Base URL: operator-configured per connection (`api_url`, defaults to
  `https://app.chatwoot.com` for the SaaS offering, but self-hosted instances use
  their own origin).
- All Application API endpoints are namespaced under
  `{api_url}/api/v1/accounts/{account_id}/...`. `account_id` is specific to the
  Chatwoot workspace the token belongs to and is supplied at connect time, then
  persisted encrypted per-connection. It is **never** trusted from a webhook
  payload as authority — only compared against the persisted value for
  disambiguation (see webhook contract below).

## REST resources consumed by ORBITA

| Operation | Method | Path | Notes |
|---|---|---|---|
| List conversations | GET | `/conversations` | 4.19.1 responde `{ data: { meta, payload: Conversation[] } }`; aceita também `{ payload }`. Outro formato é `invalid-response`, nunca lista vazia. Sem filtro, a API só devolve conversas abertas: o sync não vê as resolvidas. |
| List messages | GET | `/conversations/{conversation_id}/messages` | Response `{ payload: Message[] }`. |
| Send message | POST | `/conversations/{conversation_id}/messages` | Body `{ content, message_type: "outgoing", private: false }`. |
| Toggle conversation status | POST | `/conversations/{conversation_id}/toggle_status` | Body `{ status: "open" \| "resolved" \| "pending" }`. |

## Zod schemas (application boundary)

Defined in `src/services/chatwoot/chatwootPort.ts`:

- `ChatwootContactSchema` — `id` (number|string, coerced to number), `name`,
  `email?`, `phone_number?`, `avatar_url?`/`thumbnail?`.
- `ChatwootConversationSchema` — `id`, `display_id?`, `contact_id?`,
  `status` (`open|resolved|pending`, defaults `open`), `inbox_id?`, `channel?`/
  `channel_type?`, `meta.sender?`.
- `ChatwootMessageSchema` — `id`, `content?`, `message_type`
  (`incoming|outgoing|system|template`, accepts legacy numeric 0-3), `sender?`,
  `created_at?`.
- `ChatwootWebhookEventSchema` — `event` (required, non-empty string),
  `account.id` (required for `message_created`/`message_updated`/
  `conversation_status_changed`), `inbox.id` or `conversation.inbox_id`,
  `conversation?`, `sender?`, `meta.sender?`, `id?`, `content?`,
  `message_type?`, `created_at?`.

Every boundary parse uses `.safeParse`; a failed parse is a typed
`ChatwootFailed { reason: 'invalid-response' }` (outbound) or a `400` response
with no side effect (inbound webhook) — never a thrown exception that could
skip the idempotent inbox write.

## Webhook contract

A 2xx means the delivery is durably committed in the inbox, nothing more. The
consumer worker (MSG-006) produces every effect afterwards; a client of this
endpoint never triggers it. See `docs/operations/msg-006-runbook.md`.

- Chatwoot's `POST /api/v1/accounts/{account_id}/webhooks` resource creates a
  webhook subscription with its own unique per-webhook secret. Signed
  deliveries carry `X-Chatwoot-Timestamp` (Unix seconds) and
  `X-Chatwoot-Signature` = `sha256=` + `HMAC-SHA256(secret, "{timestamp}.{raw_body}")`.
  ORBITA stores that secret as the `webhook_secret` field of
  `ChatwootCredentialsPayloadSchema`, scoped to one organization's connection,
  and recomputes the same digest over the *raw* request body before any parse,
  lookup, or database write. Verification also rejects a timestamp more than 5
  minutes old/skewed, to bound replay of a captured signed request.
- ORBITA additionally routes each connection to its own delivery URL
  (`/api/chatwoot/webhook/{conexaoId}`) so the correct per-connection secret
  can be looked up *before* verifying the signature, without ever trusting the
  URL segment itself as authority — only a correct signature over that
  connection's secret grants authority to treat the resolved `organizacao_id`
  as verified.
- Every documented webhook payload includes a top-level `account: { id }` and,
  depending on event, an `inbox` or `conversation.inbox_id`. ORBITA cross-checks
  `payload.account.id` against the `account_id` persisted for the resolved
  connection before treating `inbox_id` as authoritative. A mismatch is a fail
  loud (`403`), never a silent fallback.
- Dedup (MSG-005, `docs/operations/msg-005-runbook.md`): `X-Chatwoot-Delivery`
  is optional and never invented; when present it is unique per organization +
  connection. The logical event key (`chaveDoEventoChatwoot`, version `v2`)
  carries a revision marker (provider `updated_at`, else delivery id, else the
  signed timestamp), so later edits and repeated statuses separated by other
  transitions are kept. `message_created` has no marker. A `2xx` is only returned
  after the delivery and the minimized event are committed.
- Limits before any expensive work: body up to 256 KiB (`413`), header format,
  then HMAC over the original bytes, then 300 signed deliveries per minute per
  connection (`429`; `503` when the counter is unavailable).

### Formato real das entregas (4.19.1)

`ChatwootWebhookEventSchema` normaliza tudo isto num formato só:

- `message_*`: contato em `conversation.meta.sender` e `conversation.contact_inbox.contact_id`;
  não há `meta` no topo nem `conversation.contact_id`.
- `sender` de contato vem **sem `type`**; o de agente traz `type: 'user'`. O `type` de contato
  só é preenchido com prova: mensagem de entrada cujo `sender.id` é o contato da conversa.
- `conversation_*`: a conversa vem no topo (`id`, `status`, `inbox_id`, `updated_at`), sem
  `conversation` e sem `inbox`; `created_at` é numérico.
- `message_updated` não traz `updated_at` da mensagem; a revisão usa o id da entrega.
- `X-Chatwoot-Delivery` veio em todas as entregas observadas, como UUID. Segue opcional.
- Na API, `created_at` da mensagem são segundos desde a época; a aplicação recebe ISO.
- **O Chatwoot não repete entrega recusada.** Um 401 ou 5xx perde aquela entrega
  (`Webhooks::Trigger` só registra a falha; a prova confirma com 15 s de espera). Recuperar
  o que se perdeu exige reconciliação, que não existe hoje.

### Known limitation (provider-side, tracked `needs-owner`)

Chatwoot GitHub issue [#13809](https://github.com/chatwoot/chatwoot/issues/13809)
(reported 2026) documents that on some Chatwoot versions the `secret` field
returned by the webhook-creation API does not match the internal `hmac_token`
actually used to sign deliveries, making signature verification fail even with
the "correct" documented secret. Na 4.19.1 self-hosted o segredo da API é o que assina (MSG-001). Must still be
checked against any other version or the Cloud offering before connecting it — if the instance is affected, the organization's
webhook cannot be verified until the provider fixes it or exposes the real
signing key, and ORBITA must refuse to accept unsigned/unverifiable deliveries
rather than silently downgrading to a weaker check.

## Rate limits, retries, timeouts

- ORBITA sets a 10s per-request timeout (`AbortSignal.timeout`).
- HTTP 429 is mapped to `ChatwootFailed { reason: 'rate-limited', retryAfterSeconds }`
  using the `Retry-After` response header (defaults to 60s when absent).
- HTTP 5xx is mapped to `ChatwootFailed { reason: 'http', status }`; HTTP
  401/403 is mapped the same tag but callers must treat it as **permanent**
  (credential problem, requires reconnection) — see `chatwootAdapter.ts` for the
  `retryable: boolean` classification exposed alongside `reason`.
- `retryable` is a read-path hint. For the message **creation** POST it never
  decides a retry (MSG-007): the API has no idempotency key and does not document
  that 429 or 5xx prove non-application, and `fetch` cannot tell a connection
  failure before the request from one after it. The outbox maps the send result
  with `desfechoDoEnvioChatwoot` (`services/outbox/desfechoDoEfeito.ts`): only a
  definitive 4xx is a refusal; timeout, network, invalid response (including an
  invalid 2xx), 429 and 5xx are `unknown`, which is never retried automatically.
- Network failures and timeouts are distinguished (`reason: 'network'` vs
  `'timeout'`) so callers can apply different backoff.
