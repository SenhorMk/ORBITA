# 38 — Integrar Stripe para assinatura e cobrança

**What to build:** sincronizar assinatura Stripe com os entitlements da organização por um fluxo idempotente de checkout, renovação, inadimplência e cancelamento.

**Blocked by:** 37 — Criar planos, limites e entitlements.

**Status:** ready-for-agent

- [ ] Checkout vincula customer e subscription à organização autorizada.
- [ ] Webhooks Stripe são autenticados, idempotentes e ordenados por estado.
- [ ] Renovação, inadimplência, cancelamento e reativação atualizam entitlements corretamente.
- [ ] Chaves Stripe permanecem server-side e contract tests usam boundary controlado.
