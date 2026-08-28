# Manifest de secrets — ORBITA

Documento operacional. **Nunca contém valor real de secret** — apenas nome, ambiente, dono,
origem/cofre, política de rotação e consumidores. Baseado em `.env.example` (fonte da verdade de
nomes) e nos módulos que os consomem.

| Variável | Exposição | Ambientes | Owner (`needs-owner`) | Origem/cofre (`needs-owner`) | Rotação | Consumidores |
|---|---|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Pública (browser) | dev, staging, prod | proprietário do produto/infra | Console Supabase do projeto correspondente | Só muda ao trocar de projeto Supabase | `src/lib/supabaseServer.ts`, `src/lib/runtime-config.ts`, todo client Supabase browser |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Pública (browser) | dev, staging, prod | proprietário do produto/infra | Console Supabase → Project Settings → API | Rotacionar se vazada; Supabase permite rotação sem downtime da anon key | `src/lib/runtime-config.ts`, clients browser |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-only, privilegiada** (bypassa RLS) | dev, staging, prod | proprietário do produto/infra | Console Supabase → Project Settings → API (secret) | Rotacionar imediatamente se vazada; rotação programada recomendada a cada 90 dias | `src/lib/supabaseServer.ts` (única leitura), toda rota/serviço server-side privilegiado |
| `ENCRYPTION_KEY` | **Server-only** | dev, staging, prod | proprietário de segurança | Gerado localmente (32 bytes aleatórios, hex) e guardado em cofre (ex.: 1Password/Vault) — nunca gerado em CI sem registro | Rotação exige plano de re-criptografia de dados em repouso; não rotacionar sem migração de dados | `src/lib/crypto.ts` (`checkEncryptionConfiguration`) |
| `BLING_CLIENT_ID` | Server-only | dev, staging, prod | proprietário da integração Bling | Painel de developer do Bling (app OAuth) | Baixo risco isolado; rotacionar junto do secret se o app for recriado | `src/services/bling/*` |
| `BLING_CLIENT_SECRET` | **Server-only** | dev, staging, prod | proprietário da integração Bling | Painel de developer do Bling | Rotacionar imediatamente se vazado | `src/services/bling/*` |
| `BLING_API_KEY` | Server-only | dev, staging, prod | proprietário da integração Bling | Painel Bling | Conforme política do Bling | `src/services/bling/*` |
| `BLING_WEBHOOK_SECRET` | **Server-only** | dev, staging, prod | proprietário da integração Bling | Painel Bling (configuração de webhook) | Rotacionar se vazado; invalida assinaturas de webhooks antigos pendentes | `src/app/api/bling/webhook/*` (verificação de assinatura) |
| `NEXT_PUBLIC_BLING_API_KEY` | Pública (browser) | dev, staging, prod | proprietário da integração Bling | Mesmo painel Bling, variante pública documentada como não-secreta | Baixo risco | UI de configuração Bling |
| `CHATWOOT_API_URL` | Server-only (não secreta, mas específica do ambiente) | dev, staging, prod | proprietário da integração Chatwoot | Instância Chatwoot (self-host ou cloud) | N/A | `src/services/chatwoot/*` |
| `CHATWOOT_API_TOKEN` | **Server-only** | dev, staging, prod | proprietário da integração Chatwoot | Chatwoot → Profile Settings → Access Token | Rotacionar se vazado | `src/services/chatwoot/*` |
| `CHATWOOT_ACCOUNT_ID` | Server-only | dev, staging, prod | proprietário da integração Chatwoot | Painel Chatwoot | N/A | `src/services/chatwoot/*` |
| `CHATWOOT_WEBHOOK_SECRET` | **Server-only** | dev, staging, prod | proprietário da integração Chatwoot | Configuração de webhook Chatwoot | Rotacionar se vazado | `src/app/api/chatwoot/webhook/*` |
| `INTEGRATION_ENCRYPTION_KEY` | **Server-only** | dev, staging, prod | proprietário de segurança | Gerado localmente, guardado em cofre | Mesma restrição de `ENCRYPTION_KEY` — exige plano de re-criptografia | Armazenamento de credenciais de provider em repouso |
| `STRIPE_SECRET_KEY` | **Server-only** | dev, staging, prod | proprietário de billing | Stripe Dashboard → Developers → API keys (usar chave de **test** em dev/staging, **live** só em produção) | Rotacionar imediatamente se vazada | `src/services/stripe/*` |
| `STRIPE_WEBHOOK_SECRET` | **Server-only** | dev, staging, prod | proprietário de billing | Stripe Dashboard → Webhooks (por endpoint) | Rotacionar se o endpoint for recriado ou se vazado | `src/app/api/stripe/webhook/*` |
| `STRIPE_APP_BASE_URL` | Server-only (não secreta) | dev, staging, prod | proprietário de billing | Domínio do ambiente correspondente | N/A | Construção de URLs de checkout/portal |
| `STRIPE_PRICE_PRO_MONTHLY` / `..._YEARLY` / `STRIPE_PRICE_ENTERPRISE_*` | Server-only (não secreta) | dev, staging, prod | proprietário de billing | Stripe Dashboard → Products → Prices | Atualizar ao criar novo Price | `src/services/stripe/*` (allowlist de planos) |
| `STRIPE_CHECKOUT_ENABLED` | Server-only (feature flag, não secreta) | dev, staging, prod | proprietário de billing | Configuração de ambiente | N/A | Gate de criação de nova sessão de checkout/portal |
| `MOCK_MODE` | Server-only (flag de desenvolvimento) | dev apenas | equipe de desenvolvimento | Configuração local | N/A | Comportamento local sem integrações reais |

## Regras que já são aplicadas em runtime (confirmadas nesta branch)

- `src/lib/runtime-config.ts` rejeita URL/keys Supabase placeholder (`placeholder`, `seu-projeto`,
  comprimento curto, `replace-me`, `your-`/`your_`) tanto para a configuração de browser quanto de
  servidor, e falha fechado lançando na importação de `src/lib/supabaseServer.ts` — build/boot com
  placeholder falha, não silenciosamente usa um fallback.
- `src/app/api/readiness/route.ts` e `src/app/api/health/startup/route.ts` nunca retornam `200`
  quando essa validação falha — ver `docs/quality/ticket-21-deploy-readiness-audit.md`.
- Nenhum secret aparece em log estruturado: `src/lib/observability/logger.ts` redige recursivamente
  chaves sensíveis e padrões inline (`Authorization: Bearer ...`, `password=...`, etc.).

## `needs-owner`

Provisionamento real de cada cofre/origem acima (ex.: qual gerenciador de secrets — 1Password,
Vault, o "Environment Variables" nativo do provider de hosting escolhido no ADR) e a política de
rotação programada (calendário, responsável por executar) dependem da infraestrutura real
escolhida no ADR `docs/adr/ticket-21-deploy-staging.md`. Enquanto isso, os valores de
desenvolvimento local seguem apenas em `.env.local` (gitignored), nunca commitados.
