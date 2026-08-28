# Stripe integration contract

Targets the official `stripe` Node SDK (npm `stripe`, pinned in `package.json`)
and API version pinned explicitly in `src/services/stripe/stripeSdkAdapter.ts`
(`PINNED_API_VERSION`) — the account's default API version is never trusted
implicitly. Based on Stripe's public API reference (`stripe.com/docs/api`) and
the SDK's own TypeScript definitions (`node_modules/stripe/cjs/lib.d.ts`,
`types/*.d.ts`) as of this ticket. If Stripe changes a field name or the
signature header format, update `stripeBillingPort.ts`/`stripeSdkAdapter.ts`
and this file together, and re-run the contract tests
(`stripeSdkAdapter.contract.test.ts`) against the fake HTTP server.

## Authentication

- `Authorization: Bearer <STRIPE_SECRET_KEY>`, set automatically by the SDK
  client constructed in `StripeSdkAdapter.create`. The secret key is read only
  from server-side environment (`STRIPE_SECRET_KEY`), parsed by
  `src/services/stripe/stripeConfig.ts`, and never serialized into any
  response, log, or `NEXT_PUBLIC_*` variable.
- All requests originate from `StripeSdkAdapter` (`src/services/stripe/stripeSdkAdapter.ts`).
  No other module in the runtime imports the `stripe` package directly —
  everything else depends on the application-owned `StripeBillingPort`
  interface (`src/services/stripe/stripeBillingPort.ts`).

## REST resources consumed by ORBITA

| Operation | Method | Path | Notes |
|---|---|---|---|
| Create customer | POST | `/v1/customers` | `metadata.organizacao_id` set; idempotency key `orbita-stripe-customer-{organizationId}` (stable per organization — see `stripeCustomerService.ts`). |
| Create checkout session | POST | `/v1/checkout/sessions` | `mode: subscription`, `customer`, `client_reference_id: organizationId`, `line_items: [{ price, quantity: 1 }]`, `success_url`/`cancel_url` built from `STRIPE_APP_BASE_URL` + an optional client-supplied relative path, `metadata.organizacao_id`. Idempotency key is a fresh `randomUUID()` per request (checkout intent is not itself idempotent — the customer lookup/creation upstream of it is). |
| Create billing portal session | POST | `/v1/billing_portal/sessions` | `customer` (from the persisted `assinaturas_organizacao.stripe_customer_id`, never client-supplied), `return_url`. |
| Verify + parse webhook | n/a (local) | n/a | `stripe.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret)` — no network call; verifies the HMAC-SHA256 signature Stripe computed over the raw delivery body. |

## Idempotency keys

- Sent via the `Idempotency-Key` HTTP header (SDK option `{ idempotencyKey }`
  on the per-call `options` argument), never as a body field.
- `createCustomer`: `orbita-stripe-customer-{organizationId}` — stable, so
  concurrent requests for the same organization converge on one Customer.
  Combined with the unique partial index on
  `assinaturas_organizacao.stripe_customer_id` (migration 34) and the
  guarded `UPDATE ... WHERE stripe_customer_id IS NULL` in
  `ensureStripeCustomerForOrganization`, a race resolves to a single
  persisted customer even if two Stripe Customers are momentarily created
  server-side (the loser's id is simply never persisted — acceptable
  per the ticket's CAS invariant; reconciliation is a `needs-owner` follow-up
  if orphaned customers need periodic cleanup).
- `createCheckoutSession`: fresh UUID per call. A checkout session itself is a
  short-lived, single-use redirect target; retried checkout attempts are
  expected to open a new session, not resume a stale one.
- `createPortalSession`: no idempotency key (Stripe's Billing Portal Sessions
  endpoint does not require one; portal sessions are short-lived and safe to
  recreate).

## Error mapping (`mapThrown` in `stripeSdkAdapter.ts`)

| Stripe SDK error class / status | `StripeBillingResult` reason | `retryable` |
|---|---|---|
| `StripeSignatureVerificationError` | `signature-invalid` | `false` |
| `StripeConnectionError` | `network` | `true` |
| `StripeRateLimitError` (HTTP 429) | `http`, `status: 429` | `true` |
| `StripeError` with `statusCode >= 500` | `http` | `true` |
| `StripeError` with `statusCode < 500` (e.g. 400/401/402/404) | `http` | `false` |
| Thrown `Error` matching `/timeout/i` | `timeout` | `true` |
| Anything else thrown | `network` | `true` |
| Checkout session response missing `url` | `invalid-response` | `false` |
| Webhook event verified but fails `stripeVerifiedEventSchema` | `invalid-response` | `false` |
| Missing `stripe-signature` header | `signature-invalid` | `false` |

Callers (`checkoutService`, `portalService`, and the route handlers in
`src/app/api/stripe/{checkout,portal}/handlers.ts`) never inspect the raw
Stripe SDK error — only this tagged union, so no Stripe-specific type ever
crosses the port boundary.

## Price mapping (server-side allowlist)

`resolvePriceId` in `stripeConfig.ts` maps `(planoSlug, intervalo)` to one of
four Price IDs configured by environment variable
(`STRIPE_PRICE_{PRO,ENTERPRISE}_{MONTHLY,YEARLY}`), each required to start
with `price_` and rejected if it is a placeholder value. The HTTP client
(`plano_slug` + `intervalo` in the request body of `POST /api/stripe/checkout`)
never supplies a Price ID, `customerId`, or `organizationId` — those are
always resolved server-side from the verified session/organization context
and this allowlist.

## Return URL allowlist

`buildAllowlistedReturnUrl` in `stripeConfig.ts` resolves `success_url`,
`cancel_url`, and the portal `return_url` from a single server-configured
origin (`STRIPE_APP_BASE_URL`) plus, at most, a client-supplied relative path
(`return_path` in the request body, validated by both a Zod regex in the route
handler and an origin-equality check after `new URL(path, base)` resolution).
A path that would resolve to a different origin — including a
protocol-relative `//host/path` — throws `SAFETY: ...` and is mapped to a
`invalid-response` failure; the request never reaches the Stripe API with an
attacker-controlled URL.

## Webhook contract

- Signature header: `Stripe-Signature: t=<unix_timestamp>,v1=<hex_hmac_sha256>`
  (Stripe may include additional `v0=`/legacy scheme values in some
  configurations; the SDK's `constructEvent` handles the current `v1` scheme).
  ORBITA never re-implements this HMAC computation — verification is entirely
  delegated to `stripe.webhooks.constructEvent`, over the untouched raw
  request body (`await req.text()`, read once, before any JSON parsing).
- Default replay/clock-skew tolerance is the SDK's built-in tolerance (300
  seconds), applied by `constructEvent` itself — ORBITA does not override it.
- After verification, the event is parsed against
  `stripeVerifiedEventSchema` (`id`, `type`, `created`, `data.object`) before
  being handed to `processStripeWebhookEvent` (`src/lib/stripe/stripeWebhookHandler.ts`,
  unchanged from ticket 13). That function persists `event.id` in the
  `stripe_webhook_events` inbox before any side effect, and applies state
  transitions through the monotonic RPC `atualizar_assinatura_stripe_atomica`
  (`database/34_integrar_stripe_assinaturas.sql`, hardened by
  `database/49_entitlement_reserva_atomica_ordering.sql`), so a replayed
  event is a no-op (`already_processed`) and an event older than the applied
  state is `stale_ignored` — never regressing the subscription.
- Events consumed: `checkout.session.completed`,
  `customer.subscription.updated`, `customer.subscription.deleted`,
  `invoice.payment_failed`. Any other event type reaches
  `processStripeWebhookEvent`, is recorded in the inbox, and is a no-op for
  state (not explicitly matched by the `if`/`else if` chain) — this is safe by
  construction, not silently ignored data loss, since the event is still
  durably recorded and can be reprocessed if a handler is added later.
- Endpoint registration and rotation (`stripe listen` for local/CI, or a
  dashboard-configured endpoint pointing at `/api/stripe/webhook` for a real
  environment) is `needs-owner` — see the final evidence file for exact
  commands.

## Feature flag / rollout

`STRIPE_CHECKOUT_ENABLED` (parsed as a boolean in `stripeConfig.ts`, default
`false`) gates only `checkoutService.createOrganizationCheckoutSession` — when
`false`, the checkout route returns `StripeBillingFailed { reason:
'unconfigured' }` without calling the billing port at all. The webhook route
and `processStripeWebhookEvent` are independent of this flag and keep running
regardless, per the ticket's rollback requirement (never stop consuming
events, never delete customer/subscription/event data — only block new
checkout/portal session creation).

## Rate limits, retries, timeouts

- SDK client configured with `timeout: 20_000` (production) /
  `5_000` (`forTesting`) and `maxNetworkRetries: 2` (production) /
  `0` (`forTesting`, so contract tests observe every response deterministically).
- HTTP 429 is mapped to `retryable: true`; the caller (route handler) surfaces
  this as an HTTP failure the client can retry, but ORBITA itself does not
  implement additional backoff beyond the SDK's built-in `maxNetworkRetries`.
- Network/timeout failures are distinguished from HTTP failures so future
  callers (e.g. an outbox-based retry policy) can apply different handling,
  matching the pattern already used by the Chatwoot/Bling adapters.

## Known limitations / `needs-owner`

See the final evidence file (`.scratch/orbita-mvp-producao-v2/evidence/14-final-evidence.md`)
for the complete list of credential-gated steps (Test Mode Products/Prices,
`STRIPE_SECRET_KEY`, `stripe listen` webhook secret, and the required Test
Mode checkout/webhook/portal journey) that cannot be executed without real
Stripe credentials, per this ticket's blocking constraint (credentials arrive
only at the end of ticket 25).
