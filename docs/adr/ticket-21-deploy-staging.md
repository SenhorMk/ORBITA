# ADR — Ticket 21: hosting, staging e prontidão de deploy

Status: proposto (decisão final de infraestrutura real é `needs-owner`).

## Contexto

O ticket 21 exige um staging isolado e reproduzível, health checks corretos, um manifest de
secrets e um ensaio real de backup/restore. Este repositório não tem hoje host, domínio,
projeto Supabase de staging, cofre de secrets nem canal de alerta provisionados — nada disso
será criado agora (credenciais externas só entram no fim do ticket 25, por decisão registrada
em `project_orbita_credential_timing`). Este ADR propõe opções tecnicamente razoáveis; a decisão
de custo/contrato/responsável cabe ao proprietário.

## Decisão proposta por eixo

| Eixo | Proposta | Alternativa | Status |
|---|---|---|---|
| **Runtime/host** | Next.js App Router em runtime Node.js (não Edge — várias rotas usam `supabaseServer`/service-role e SDKs Node-only como `pg`). Plataforma sugerida: Vercel (alinhado ao App Router) ou um container Node em Fly.io/Railway se o proprietário preferir não depender de um PaaS específico da Vercel. | Container Docker próprio atrás de um load balancer (mais controle, mais operação manual). | `needs-owner` — escolha de provider e custo. |
| **Região** | `sa-east-1` (São Paulo) ou região mais próxima da base de clientes, para latência e para alinhar com a região do projeto Supabase de staging. | — | `needs-owner` — depende de onde o Supabase de staging for provisionado. |
| **Build/start** | `npm run build` gerando `.next`; `npm run start` (ou equivalente do provider) servindo o build. `npm run build:artifact:check` já valida que o artefato de build não contém segredo/placeholder embutido — manter como gate obrigatório pré-deploy. | — | Executável hoje (gate já existe). |
| **Domínio/TLS** | Subdomínio dedicado de staging (ex.: `staging.orbita.<domínio>`) com TLS gerenciado pelo provider (Vercel/Fly certs automáticos) ou Let's Encrypt via proxy reverso se self-hosted. | — | `needs-owner` — domínio não existe ainda. |
| **Supabase de staging** | Projeto Supabase **separado** do de produção (nunca o mesmo projeto, nunca o laboratório local Docker deste repositório). Aplicar as 55 migrations canônicas via `database/migrations.lock.json` em ordem, como etapa de deploy observável e auditável — nunca implicitamente no boot da aplicação (ver `src/app/api/health/startup/route.ts`, que só **lê** o schema, nunca migra). | — | `needs-owner` — projeto Supabase de staging não provisionado. |
| **Variáveis/secrets** | Ver `docs/operations/secrets-manifest.md`. Nunca compartilhar valor entre staging e produção; nunca reutilizar a service-role key de produção em staging. Build já falha em placeholder via `src/lib/runtime-config.ts` (`isValidSupabaseUrl`/`isValidKey`) — confirmado nesta branch (ver evidência final). | — | Lógica pronta hoje; provisionamento real `needs-owner`. |
| **Workers/scheduler** | Os jobs duráveis do Ticket 12 (`sync_jobs`/outbox) rodam como parte do mesmo processo Next.js hoje; se um worker dedicado for necessário em staging/produção, propor um segundo processo/container rodando o mesmo código-fonte com um entrypoint de worker, nunca `setTimeout` em request path. | — | `needs-owner` para a topologia real; a lógica de job já é durável (banco), não em memória. |
| **Logs/métricas** | Logger estruturado já emite JSON redigido (`src/lib/observability/logger.ts`) — compatível com qualquer coletor (provider log drain, Logtail, Datadog). Alertas do Ticket 19 já têm interface testável localmente; entrega real a um canal (Slack/email/PagerDuty) depende do canal escolhido. | — | `needs-owner` — canal de alerta real. |
| **Custo** | Estimativa depende do provider escolhido; staging tende a ser um plano mínimo (hobby/starter) já que não serve tráfego de produção. | — | `needs-owner`. |
| **Responsável** | A definir pelo proprietário do produto/infra. | — | `needs-owner`. |

## Invariantes não negociáveis (independente da escolha acima)

- Staging e produção **nunca** compartilham banco Supabase nem chaves Stripe live (`AGENTS.md`,
  ticket 21 "Plano determinístico" item 1).
- Migrations são uma etapa de deploy anterior e observável, nunca implícita no startup da
  aplicação (`src/app/api/health/startup/route.ts` só lê `information_schema`/tabelas baseline,
  nunca executa DDL).
- `readiness` falha fechado para toda dependência indispensável ausente/placeholder/timeout/erro
  (`src/lib/health/dependencyCheck.ts`), nunca retorna saudável nesse cenário.
- Nenhuma credencial real de staging ou produção é colada em texto no repositório, em prompt, ou
  em qualquer arquivo deste ticket — apenas nomes/localização/rotação (ver secrets manifest).

## Consequências

- Enquanto o proprietário não provisionar staging real, os critérios de aceitação relacionados a
  staging real (deploy a partir de commit, alerta entregue de verdade, rollback ensaiado em
  staging) permanecem `needs-owner` e são listados explicitamente na evidência final deste
  ticket.
- Tudo o que não depende de infraestrutura externa (health checks corretos, manifest de secrets,
  backup/restore real em laboratório local, runbook de rollback) foi implementado e validado
  nesta branch.
