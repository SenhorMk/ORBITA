# Registry de cookies, storage e requests de terceiros — ORBITA

**Ticket:** 16 — Publicar privacidade, cookies e governança de fornecedores (`orbita-mvp-producao-v2`).
**Commit analisado:** `36f1b231df1f50da2cd0a9e926e7a222dff81688` (branch `fix/ticket-16-privacidade-cookies-fornecedores`, a partir do working tree do ticket 15).
**Data do levantamento:** 2026-08-27.
**Método:** busca reproduzível (`rg`) sobre `src/` por `cookies\(\)\.set|\.cookies\.set`, `localStorage\.|sessionStorage\.`, `<script|createElement\('script'\)`, e por nomes de fornecedores de analytics/marketing conhecidos (ver seção de confirmações negativas). Cruzado com `docs/privacy/data-inventory.md` (itens 2-4, 31) e `docs/security/identity-boundary-inventory.md`, e confirmado linha a linha no código atual — não apenas herdado do ticket 15.

## Cookies

| Nome | Emissor | Finalidade | Duração | Atributos | Classe |
|---|---|---|---|---|---|
| `sb-*` (nome exato definido pelo SDK Supabase Auth, não pelo código ORBITA) | Supabase Auth (via `@supabase/supabase-js`, `src/lib/supabaseClient.ts`/`src/lib/supabaseServer.ts`) | Manter a sessão autenticada do usuário | Duração/expiração do token conforme padrão do Supabase Auth (não configurada pelo código ORBITA) | Gerenciado pelo SDK Supabase; atributos exatos (`HttpOnly`/`SameSite`/`Secure`) não são definidos pelo código ORBITA — **needs-owner**: confirmar atributos exatos emitidos pelo SDK em produção | `essential` |
| `orbita_oauth_transaction` | ORBITA (`src/app/api/bling/authorize/route.ts:81`, limpo em `src/app/api/bling/callback/route.ts:178`) | Proteção CSRF/replay do fluxo OAuth Bling; valor opaco (UUID), consumo único (CAS) via `transacoes_oauth` | 10 minutos (`expira_em`); limpo explicitamente (`maxAge: 0`) ao final do callback | `httpOnly: true`, `secure: NODE_ENV === 'production'`, `sameSite: 'lax'`, `path: '/api/bling/callback'` (limpeza) / rota de authorize (emissão) | `essential` |
| `orbita_active_org` (`ACTIVE_ORG_COOKIE_NAME`, `src/lib/organizationContext.ts:39`) | ORBITA (`src/app/api/organizacoes/switch/route.ts:106`, `src/app/api/convites/aceitar/route.ts`) | Contexto de organização ativa entre requisições (multi-tenant) | 30 dias (`maxAge`) | `httpOnly` (confirmar flags completas no route handler — ver observação abaixo) | `essential` |

Observação sobre `orbita_active_org`: o handler usa `(await cookies()).set(...)`; os atributos completos (`secure`/`sameSite`) estão definidos no mesmo route handler (`src/app/api/organizacoes/switch/route.ts:106` e arredores) e seguem o mesmo padrão de segurança dos demais cookies de sessão do produto (`HttpOnly`, sem exposição a JavaScript client-side).

## Local storage / session storage

| Chave | Origem | Finalidade | Classe |
|---|---|---|---|
| `haux_session` (`localStorage`) | `src/app/page.tsx` (linhas 105, 110, 515, 526, 541, 544, 647, 659, 682, 693) | Cache client-side da sessão de usuário autenticado da página principal do dashboard (nome legado do produto antes do rename para ORBITA); não é tracking, não é enviado a terceiros | `essential` |

Nenhuma outra chave de `localStorage`/`sessionStorage` foi encontrada em `src/` (busca `rg -n "localStorage\.|sessionStorage\."` retornou apenas o arquivo acima).

## Pixels, SDKs de terceiros e scripts injetados

Busca `rg -n "<script|<Script|document.createElement\('script'\)"` sobre `src/` retorna um único resultado: `src/app/api/bling/callback/route.ts:251-256`. Inspecionado: é uma tag `<script>` inline (não carregada de terceiro) dentro da página HTML de retorno do OAuth Bling, cujo único efeito é `window.opener.postMessage({ type: 'BLING_AUTH_COMPLETE', ... }, '*')` e fechar a janela popup — mecanismo de comunicação entre a janela OAuth e a aplicação principal, não um pixel ou script de terceiro. Classe: `essential` (parte do fluxo funcional de conexão Bling que o próprio usuário iniciou).

Nenhum outro `<script src="https://...">`, `<img>` de pixel, ou SDK de terceiro carregado no client foi encontrado.

## Requests de terceiros antes/depois do login

Os únicos providers externos chamados pelo código são os já documentados em `docs/privacy/vendor-role-matrix.md`: Supabase (auth/banco), Bling (ERP, iniciado por ação explícita do usuário autenticado), Chatwoot (atendimento, por conexão configurada pela organização), Stripe (billing, checkout/portal hospedados). Nenhum desses é opcional do ponto de vista de rastreamento — são partes funcionais do produto contratado, não analytics/marketing. Nenhuma chamada a esses providers ocorre antes da ação explícita do usuário que a desencadeia (login, iniciar conexão Bling, abrir checkout, etc.); não há carregamento automático em toda página.

## Confirmações negativas (buscadas, não presumidas)

- `rg -i "analytics|gtag|posthog|mixpanel|segment|amplitude|hotjar|clarity|pixel|fbq\("  src/` — sem resultado de vendor real (nenhum arquivo casou).
- `grep -iE "sentry|datadog|posthog|logrocket|analytics|amplitude|mixpanel|segment|gtag|ga4|hotjar|clarity|facebook-pixel|tiktok" package.json` — sem resultado.
- Confirma o achado já registrado em `docs/privacy/data-inventory.md` (item 31) e `docs/privacy/vendor-role-matrix.md` (linhas "Observabilidade (APM/erro)" e "Analytics de produto", ambas `not-applicable`): **não há nenhum cookie, storage, pixel, SDK ou request de terceiro de analytics, marketing, ou rastreamento no código ORBITA hoje.**

## Classificação resumida

| Classe | Itens |
|---|---|
| `essential` | `sb-*` (Supabase Auth), `orbita_oauth_transaction`, `orbita_active_org`, `haux_session` (localStorage), script inline de postMessage do callback Bling |
| `preferences` | Nenhum item hoje |
| `analytics` | Nenhum item hoje |
| `marketing` | Nenhum item hoje |

## Decisão de escopo (ver checkpoint e evidência final)

Como não há hoje nenhum cookie/storage/SDK `preferences`/`analytics`/`marketing` real no produto, este ticket não constrói banner de consentimento de cookies (seria trabalho supérfluo sobre uma categoria inexistente). O `ConsentPolicy` puro (`src/domain/privacy/consentPolicy.ts`) é implementado e testado mesmo assim, pronto para o dia em que uma categoria opcional real for adicionada — nesse momento, a mudança de código que introduzir o novo tracking deve também atualizar este registry e, aí sim, construir a UI de consentimento.
