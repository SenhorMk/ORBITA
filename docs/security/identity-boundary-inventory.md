# Inventário de fronteiras de identidade (Ticket 07)

Levantado por busca reproduzível (`rg`) sobre `verifySessionAndRole`, `resolveAuthenticatedIdentity`,
`resolveActorContext`, `resolveActiveRequestOrganizationContext`, `resolveRequestOrganizationContext`,
`app_metadata`, `getSession`, `getUser`, cookies, `redirect` e state OAuth, em 2026-08-27.

## Autoridade de identidade HTTP

Toda rota mutável server-side deriva ator/organização de uma das seguintes fontes verificadas — nunca de
`getSession()` não verificado, nunca de `app_metadata` reconstruído localmente para rotas novas:

- `resolveAuthenticatedIdentity` (`src/lib/auth.ts:100`) — verificação de bearer contra `supabaseServer.auth.getUser`. Única fonte nova de identidade HTTP.
- `resolveActorContext` / `verifySessionAndRole` (`src/lib/auth.ts:167`, `:242`) — compõem sobre `resolveAuthenticatedIdentity` e adicionam papel/capacidade via metadata de compatibilidade legada (P0 containment, Ticket 24 deve substituir).
- `resolveActiveRequestOrganizationContext` / `resolveRequestOrganizationContext` (`src/lib/requestOrganizationContext.ts`) — contexto canônico de organização do Ticket 06, usado por todas as rotas novas/alteradas neste ticket.

## `rg` — ausência de `getSession()` como autoridade server-side

```
rg "getSession\(" src/
```

Resultado: todas as ocorrências (`src/app/page.tsx`, `ClienteEditModal.tsx`, `EditOrderModal.tsx`,
`ManualOrderModal.tsx`, `OrderDetailModal.tsx`, `ProductDetailModal.tsx`, `SetupWizard.tsx`) são chamadas
**client-side** ao SDK do Supabase apenas para anexar o token `Authorization` em requisições HTTP; nenhuma
delas decide autorização localmente. Nenhuma ocorrência em `src/app/api/**` ou `src/lib/**`. A única
verificação server-side de sessão é `supabaseServer.auth.getUser(token)`, dentro de `resolveAuthenticatedIdentity`.

## Rotas mutáveis e sua fonte de identidade

| Rota | Fonte de identidade | Autorização | CSRF/replay | Rate limit | Disposição |
|---|---|---|---|---|---|
| `POST /api/auth/register` | Nenhuma (público, cadastro) | N/A | N/A | **Novo**: `register` por IP (`rateLimit.ts`) | Endurecido neste ticket (Zod, resposta indistinguível, rate limit). |
| `GET /api/bling/authorize` | `resolveActiveRequestOrganizationContext` | Contexto de organização (Ticket 06) | Emite transação OAuth server-side de uso único | **Novo**: `bling_authorize` por IP | Endurecido neste ticket. |
| `GET /api/bling/callback` | Transação OAuth consumida (`consumeOAuthTransaction`) resolve `userId`/`organizacaoId` | Vínculo à transação original | **Novo**: consumo atômico CAS, state em tempo constante | **Novo**: `bling_callback` por IP + por ator | Endurecido neste ticket. |
| `POST /api/bling/webhook` | `authorizeSignedServiceTenant` (HMAC) | Assinatura `x-bling-signature-256` | Assinatura HMAC (`timingSafeEqual`) | Fora de escopo (ticket anterior) | Sem alteração. |
| `POST /api/chatwoot/webhook` | HMAC `x-chatwoot-signature` | Assinatura | `timingSafeEqual` | Fora de escopo | Sem alteração. |
| `POST /api/stripe/webhook` | `verifyStripeWebhookSignature` | Assinatura Stripe | SDK Stripe | Fora de escopo | Sem alteração. |
| `GET/POST /api/organizacoes`, `/switch`, `/[id]/*` | `resolveActiveRequestOrganizationContext` / `resolveRequestOrganizationContext` | Contexto de organização | N/A (sessão) | Fora de escopo deste ticket | Sem alteração — já usa contexto canônico do Ticket 06. |
| `POST /api/chatwoot/send`, `/status`, `/sync` | `resolveActiveRequestOrganizationContext` | Contexto de organização | N/A | Fora de escopo | Sem alteração. |
| `POST/DELETE /api/clientes/*`, `/produtos/*`, `/pedidos/*`, `/financeiro/*`, `/nfe`, `/dashboard`, `/sync*`, `/config`, `/startup`, `/convites/aceitar`, `/organizacoes/[id]/*` (legado) | `verifySessionAndRole` (bearer verificado) | Papel de compatibilidade P0 (metadata) | N/A | Fora de escopo | Sem alteração — usam a mesma verificação de identidade, sem reconstrução paralela. |
| `GET /api/bling/pedidos/[id]`, `/categorias/sync` | `resolveActorContext` | Capacidade explícita | N/A | Fora de escopo | Sem alteração. |
| `GET /api/integracoes/saude` | `resolveRequestOrganizationContext` (injetado) | Contexto de organização | N/A | Fora de escopo | Sem alteração. |
| `POST /api/stripe/checkout`, `/portal` | `resolveActiveRequestOrganizationContext` | Contexto de organização | N/A | Fora de escopo | Sem alteração. |

## Cookies

| Cookie | Atributos antes | Atributos depois (Ticket 07) |
|---|---|---|
| `orbita_oauth_transaction` | `HttpOnly`, `SameSite=Lax`, `Secure` em produção, `path=/api/bling/callback`, `maxAge=600`; **valor = payload cifrado inteiro** (ator, organização, provider, state, timestamp) | Mesmos atributos de transporte; **valor = referência opaca** (id da linha em `transacoes_oauth`). Nenhum dado sensível trafega no cookie. Consumo de uso único é feito no servidor via `consumir_transacao_oauth` (CAS). |
| `orbita_ativo_organizacao` (Ticket 06, `ACTIVE_ORG_COOKIE_NAME`) | `HttpOnly`, `SameSite=Lax`, `Secure` em produção | Sem alteração neste ticket. |

## Ausências registradas (não inventadas)

- **`AGENTS.md`**: ausente na raiz do repositório.
- **`graphify-out/graph.json`**: ausente.
- **Login/logout/recuperação de senha server-side**: não existem rotas `src/app/api/auth/login`, `/logout`,
  `/recover`. `src/app/login/page.tsx` chama o SDK Supabase diretamente no browser
  (`supabase.auth.signInWithPassword` etc.), sem seam HTTP server-side próprio para aplicar rate limit. Não
  foi inventada uma rota nova fora do escopo do ticket; a superfície de rate limit deste ticket cobre apenas
  o que o ticket pede explicitamente disponível (`register`, `bling_authorize`, `bling_callback`).
