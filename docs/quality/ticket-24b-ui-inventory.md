# Ticket 24b — Inventário de UI (antes/depois)

Levantado por `grep`/leitura real de `src/app/api/**/route.ts` e `src/app/page.tsx` /
`src/components/**` antes de qualquer alteração, conforme exigido pelo ticket.

## Rotas de API existentes vs. tela

| Rota de API | Tela antes (24b) | Gap encontrado | Tela depois (24b) |
| --- | --- | --- | --- |
| `GET/POST /api/organizacoes` | Nenhuma | Sem UI para criar/listar organização | `OrganizationPanel` + `CreateOrganizationForm` + `OrganizationList` |
| `POST /api/organizacoes/switch` | Nenhuma | Sem UI para trocar organização (Ticket 24 usou `page.request` puro) | `OrganizationList` (botão "Trocar para…"), CAS via `useOrganizationsList` |
| `POST /api/organizacoes/[id]/convites` | Nenhuma | Sem UI para convidar membro | `InviteMemberForm` |
| `GET /api/organizacoes/[id]/convites` | Nenhuma | Sem UI para listar convites pendentes | `InviteMemberForm` (lista de convites) |
| `POST /api/convites/aceitar` | Nenhuma | Sem UI para aceitar convite (usuário tinha que chamar a API na mão) | `AcceptInviteForm` |
| `DELETE /api/organizacoes/[id]/membros/[userId]` | Nenhuma | Sem UI para remover membro, e **sem rota para listar membros** (ver abaixo) | `MembersList` |
| `GET /api/organizacoes/[id]/membros` | **Não existia** | A ticket pedia "listar/remover membro e ver papel", mas não havia nenhuma rota GET para listar membros (`membros_organizacao`) — só o `DELETE` por `userId` já conhecido. Criada como fatia vertical mínima, reusando exatamente o padrão de autorização de `convites/route.ts` (`verifySessionAndRole` + `verifyOrganizationScope`), sem RPC nova nem migration. | `src/app/api/organizacoes/[id]/membros/route.ts` (novo) + `MembersList` |
| `GET /api/organizacoes/[id]/entitlements` | **Não existia** | A ticket pedia "tela de plano atual e limites (entitlements do Ticket 13)", mas o Ticket 13 só criou `getOrganizationEntitlements` como função de serviço interna — nenhuma rota HTTP a expunha para o cliente. Criada como fatia vertical mínima, mesma autorização de `convites/route.ts`, delegando 100% da lógica de plano para `getOrganizationEntitlements` já existente (nenhuma regra de plano duplicada). | `src/app/api/organizacoes/[id]/entitlements/route.ts` (novo) + `BillingPanel` |
| `GET /api/bling/authorize` | `HealthMonitor`/`SetupWizard` existiam, mas `blingConnected`/`chatwootConnected` em `src/app/page.tsx` eram **hardcoded `true`** (linhas 1049-1050) — não refletiam nenhum estado real. `SetupWizard` não inicia o fluxo OAuth Bling. | Sem UI real para iniciar OAuth Bling nem para ver status real | `IntegrationsPanel` (botão "Conectar Bling", redireciona para `authorizeUrl` real) |
| `GET /api/integracoes/saude` | Não consumido pela UI (só existia a API, testada em `saude-integracoes.test.ts`) | Sem tela mostrando `health_status`/`last_health_error` reais | `IntegrationsPanel` (badge de status por conexão) |
| `POST /api/chatwoot/connect` | Nenhuma UI que envie `api_token`/`account_id`/`webhook_secret` | Sem UI para conectar Chatwoot | `IntegrationsPanel` (formulário de credenciais) |
| `POST /api/stripe/checkout` | Nenhuma | Sem UI para iniciar checkout | `BillingPanel` (botão "Assinar Pro/Enterprise") |
| `POST /api/stripe/portal` | Nenhuma | Sem UI para abrir portal de faturamento | `BillingPanel` (botão "Abrir portal de faturamento") |

## Achados fora do escopo executável deste ticket (não alterados)

- `HealthMonitor` (`src/components/HealthMonitor.tsx`) continua recebendo `blingConnected`/`chatwootConnected` fixos como `true` em `src/app/page.tsx` (linhas ~1049-1050, pré-existentes). Corrigir isso duplicaria a nova fonte de verdade (`/api/integracoes/saude`, já consumida por `IntegrationsPanel`) num componente de topo que não fazia parte do escopo executável do ticket 24b (organização/membros, integrações, billing). Registrado como `needs-owner` — ver evidência final.
- `SetupWizard.tsx` não foi tocado: cobre outro fluxo (configuração inicial local), não o OAuth Bling real nem Chatwoot; o ticket pediu para reusar HealthMonitor/SetupWizard "se cobrirem parte disso" — confirmado por leitura que não cobrem, então não foram reaproveitados nem duplicados.
- Painéis administrativos/internos (LGPD Ticket 17, auditoria/incidentes Ticket 19, retenção Ticket 18) permanecem sem tela dedicada, conforme decisão explícita do ticket ("ficam fora deste ticket").

## Rotas de API que já existiam e foram apenas consumidas (não recriadas)

`/api/organizacoes`, `/api/organizacoes/switch`, `/api/organizacoes/[id]/convites`,
`/api/organizacoes/[id]/membros/[userId]`, `/api/convites/aceitar`, `/api/bling/authorize`,
`/api/integracoes/saude`, `/api/chatwoot/connect`, `/api/stripe/checkout`, `/api/stripe/portal`.
