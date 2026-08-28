# Ticket 25 — Matriz de Reconciliação Final (Gate de Release do MVP)

**Commit candidato:** `cd12c4f7a651515b01b3a880a37998f3701d6d0d`
**Data:** 2026-08-28

## Metodologia

Esta matriz foi construída lendo integralmente, um a um:

- Os 26 arquivos de ticket em `.scratch/orbita-mvp-producao-v2/issues/` (01 a 24b, excluindo 00/25/README), incluindo o título, "Blocked by", "Status" declarado no cabeçalho e a seção "Critérios de aceitação" de cada um.
- Todos os arquivos de evidência correspondentes em `.scratch/orbita-mvp-producao-v2/evidence/`: os pares `NN-checkpoint.md`/`NN-final-evidence.md` de cada ticket 07–24b, os cinco arquivos dedicados do ticket 01 (`01-allowlist.md`, `01-baseline-results.md`, `01-divergence-register.md`, `01-final-file-manifest.md`, `01-review-and-rollback.md`), o conjunto forense do ticket 02 (`02-command-log.md`, `02-dependency-report.md`, `02-evidence-catalog.md`, `02-forensic-matrix.md`, `02-graph-health-remediation.md`, `02-secret-inventory-redacted.md`), `04-database-lab.md`, `05-rpc-authorization.md`, `19-tabletop-report.md`, `21-backup-restore-run.json` e `23-status.md`.
- A matriz forense completa do ticket 02 (`02-forensic-matrix.md`, 44 tickets × 4 critérios = 176 linhas), que audita individualmente cada critério dos tickets 01–44 do plano anterior `orbita-producao-saas` e aponta, por critério, qual(is) ticket(s) do plano atual (`orbita-mvp-producao-v2`) corrige a falha encontrada — essa correspondência antigo→novo é citada diretamente desta matriz, não re-derivada.
- O diretório `.scratch/orbita-producao-saas/issues/` (51 arquivos de ticket, 01–51), usado apenas para leve conferência de títulos/numeração contra o mapeamento já produzido pelo ticket 02.

**Regra de classificação adotada, idêntica à do ticket 02**: presença de arquivo, nome de teste, comentário ou alegação de conclusão não constitui evidência de `done`. Todo item classificado como `done` nesta matriz tem uma citação de evidência fresca (comando executado + resultado real, ou pgTAP com contagem de asserções, ou busca `rg`/`grep` reproduzível). Quando o próprio arquivo de evidência usa os termos "needs-owner", "não foi possível", "simulado", "pendente", "bloqueado" ou lista explicitamente o que não foi feito, esta matriz preserva esse status — nunca o eleva a `done`.

**Legenda de status:**
- **done** — critério comprovado por evidência fresca, sem ressalva material.
- **done-with-caveats** — o núcleo funcional está comprovado, mas há uma limitação documentada e não bloqueante (ex.: prova por tipo+pgTAP em vez de HTTP end-to-end, ou uma sub-parte fora do escopo estrito do ticket).
- **needs-owner** — trabalho técnico completo, mas bloqueado por uma decisão/ação humana (credencial real, aprovação jurídica, provisionamento de infraestrutura) que o codificador não pode nem deve simular.
- **blocked** — não iniciado porque depende de um ticket predecessor ainda não `done`.
- **partial** — parte dos critérios do ticket está feita e parte reprovada/pendente, sem ser puramente uma questão de "falta owner".

---

## 0. Tickets de fundação e governança (01–06)

| Controle/Requisito | Ticket(s) antigo(s) 01-44 | Ticket(s) 07-24b (ou 01-06) | Arquivo/evidência | Status | Owner/pendência |
|---|---|---|---|---|---|
| Snapshot corretivo sanitizado e adotado, com allowlist revisada e baseline registrada | 45 (orbita-producao-saas, fora do escopo do audit 01-44) | 01 | `01-allowlist.md`, `01-baseline-results.md`, `01-divergence-register.md`, `01-final-file-manifest.md`, `01-review-and-rollback.md` | done | — |
| Auditoria forense individual dos 176 critérios dos tickets 01-44 do plano anterior, com matriz de dependências fail-closed | 01-44 (é a própria auditoria desses tickets) | 02 | `02-forensic-matrix.md` (98 aprovado / 51 parcial / 22 reprovado / 5 needs-owner de 176 critérios), `02-evidence-catalog.md`, `02-command-log.md`, `02-secret-inventory-redacted.md` | done | — |
| Rotação de credenciais reais e separação de ambientes (dev/staging/produção) | 01 | 03 | Issue `03-rotacionar-credenciais-contas-externas.md`, decisão do proprietário datada 2026-08-24: uso de credenciais de dev aceito temporariamente; rotação só ao final do ticket 25 | needs-owner | Owner — rotacionar Supabase/Stripe/Bling/Chatwoot/hospedagem/domínio/e-mail antes do go-live; bloqueia ticket 25, não o trabalho local |
| Laboratório Supabase/PostgreSQL descartável com ledger de migrations, checksums e repetibilidade | 04, 14, 15 | 04 | `04-database-lab.md`: 2 execuções limpas, mesmo fingerprint de catálogo, pgTAP real | done | — |
| RPCs privilegiadas fechadas (ACL, security invoker, search_path, escopo verificado) | 06, 13(parcial) | 05 | `05-rpc-authorization.md`: PUBLIC/anon sem privilégio, revisão Standards+Spec aprovada | done | — |
| Contexto canônico de organização/membership server-side, sem fallback para `user_id` | 03, 05, 24 | 06 | Issue `06-contexto-organizacao-membership.md` — evidência objetiva: 274 testes, `test:db` 2 ciclos limpos, catálogo idêntico, `docs/security/organization-context.md` | done | — |

---

## 1. Identidade, sessão, OAuth e abuso

| Controle/Requisito | Ticket(s) antigo(s) 01-44 | Ticket(s) 07-24b | Arquivo/evidência | Status | Owner/pendência |
|---|---|---|---|---|---|
| CSRF/replay/callback OAuth rejeitados antes de qualquer efeito (state one-time, CAS) | 03, 09, 10 | 07 | `07-final-evidence.md`: pgTAP `identidade_sessao_oauth.test.sql` 16/16, `oauth-transaction.test.ts` 8/8, teste de replay prova `exchangeCalls===1` | done | — |
| Rate limiting (registro, Bling authorize/callback) com fail-closed em falha do store | 09 | 07 | `07-final-evidence.md`: `rateLimit.test.ts` 7/7, 503 quando store indisponível (`signUpCalls===0`) | done | — |
| Respostas de cadastro não enumeram contas | 09 | 07 | `07-final-evidence.md`: resposta idêntica byte-a-byte entre e-mail novo e já cadastrado | done | — |
| Cookies/logs atendem baseline de segurança (HttpOnly, SameSite, redaction) | 09 | 07 | `07-final-evidence.md`: cookie `orbita_oauth_transaction` testado, `redactSensitiveData` cobre state/code | done | — |
| Validação end-to-end contra Bling real em staging (segunda tentativa de callback rejeitada) | — | 07 | `07-final-evidence.md`, item needs-owner 1 | needs-owner | Owner — credenciais Bling reais em staging, só disponíveis ao final do ticket 25 |
| Login/logout/recuperação de senha com rate limit server-side | — | 07 | `07-final-evidence.md`, item needs-owner 2 — rotas não existem no backend | needs-owner | Produto — decidir se cria rotas dedicadas de login/logout/recuperação |

---

## 2. Catálogo, comercial, estoque e fiscal por organização

| Controle/Requisito | Ticket(s) antigo(s) 01-44 | Ticket(s) 07-24b | Arquivo/evidência | Status | Owner/pendência |
|---|---|---|---|---|---|
| FK composta impede pedido/item/documento de outra organização; RLS canônica sem `OR user_id` | 18-21, 26, 27, 36 | 08 | `08-final-evidence.md`: pgTAP `catalogo_comercial_estoque_fiscal_organizacao.test.sql` 12/12, `errcode 23503` | done | — |
| Backfill contabilizado com quarentena de órfãos (`total = migrados + quarentena`) | 26, 27 | 08 | `08-final-evidence.md`: constraint `chk_tenancy_relatorio_soma`, assertion 10 | done | — |
| Busca zero de `resolveTenantOrgId`/fallback `user_id` nas 8 rotas e 3 repositories migrados | 36 | 08 | `08-final-evidence.md`: `grep` zero resultados | done | — |
| Jornada catálogo→pedido→estoque→fiscal ponta a ponta demonstrada via HTTP/UI real | 27 | 08 | `08-final-evidence.md`, critério `[~]`: só prova por tipo+pgTAP, sem suíte HTTP nem demonstração ao vivo | done-with-caveats | needs-owner — suíte de integração HTTP com duas orgs reais; demonstração ao vivo do fluxo completo |
| `BlingPort`/`BlingV3Adapter` formal + contract tests do adapter de ~30 métodos de recurso | 42 | 10b | Issue `10b-bling-port-adapter-contract-tests.md` — nenhum arquivo de evidência gerado; desmembrado do ticket 10 em 2026-08-27 | blocked | Não iniciado; sem evidência de execução |

---

## 3. Financeiro por organização

| Controle/Requisito | Ticket(s) antigo(s) 01-44 | Ticket(s) 07-24b | Arquivo/evidência | Status | Owner/pendência |
|---|---|---|---|---|---|
| IDs externos iguais coexistem entre organizações; unicidade dentro da organização preservada | 16, 17, 28 | 09 | `09-final-evidence.md`: pgTAP `financeiro_organizacao_ticket09.test.sql` assertions 1-3 | done | — |
| FK composta recusa referência cross-tenant (categoria/conta/fornecedor) | 28 | 09 | `09-final-evidence.md`: assertions 4-7, `errcode 23503` | done | — |
| Sync repetido não duplica lançamentos (`onConflict: organizacao_id,bling_id` + checkpoint) | 34, 35 | 09 | `09-final-evidence.md`: `upsertTitulo`, `sync_state` por `(organizacao_id, entidade)` | done | — |
| Quarentena financeira contabilizada e observável, reexecução idempotente | 16 | 09 | `09-final-evidence.md`: assertions 9-13 | done | — |
| Busca zero de `resolveTenantOrgId` em financeiro | 36 | 09 | `09-final-evidence.md`: `grep` zero resultados | done | — |
| Prova de sync idempotente contra conta Bling real de produção | — | 09 | `09-final-evidence.md`, seção needs-owner | needs-owner | Owner — credenciais/conta Bling real |
| Tabela legada `financeiro` (distinta de `*_financeiro*`) — descontinuar ou remodelar | — | 09 | `09-final-evidence.md`, needs-owner | needs-owner | Produto — decisão de descontinuação |

---

## 4. Integração Bling

| Controle/Requisito | Ticket(s) antigo(s) 01-44 | Ticket(s) 07-24b | Arquivo/evidência | Status | Owner/pendência |
|---|---|---|---|---|---|
| OAuth one-time, sem state reutilizável | 09, 10, 30 | 07, 10 | `10-final-evidence.md`: reaproveita ticket 07, 297/297 testes verdes | done | — |
| Resolução de organização no webhook corrigida (fail-closed, sem "primeira membership") | 10, 30, 36 | 10 | `10-final-evidence.md`: `webhook.test.ts` novos testes "zero organizations"/"more than one organization" | done | — |
| Backfill de `conexoes_integracao` contabilizado com quarentena | 30 | 10 | `10-final-evidence.md`: `bling_conexoes_backfill_contabilizado.test.sql` 8/8 | done | — |
| Refresh concorrente de token sem corrupção (lock de banco) | 30 | 10 | `10-final-evidence.md`: pgTAP `bling_organizacao.test.sql` assertions 2-6; sem teste TS de concorrência real ponta a ponta | done-with-caveats | Teste de integração TS concorrente contra servidor fake (needs-owner item 3) |
| Contrato Bling v3 documentado (endpoints, rate limit, retry) | — | 10 | `docs/integrations/bling-v3-contract.md` | done | — |
| Separação formal `BlingPort`/`BlingV3Adapter` + contract tests do adapter de recursos | 42 | 10 (desmembrado para 10b) | `10-final-evidence.md`, needs-owner item 3 | blocked | Ver ticket 10b acima — não iniciado |
| Jornada real de teste contra conta/sandbox Bling (OAuth→recurso→sync→webhook) | 44 | 10 | `10-final-evidence.md`, needs-owner item 1, com passo-a-passo exato | needs-owner | Owner — `BLING_CLIENT_ID`/`SECRET` reais só ao final do ticket 25 |
| Recifragem de credenciais legadas migradas (`integracoes_bling`→cofre organizacional) | — | 10 | `10-final-evidence.md`, needs-owner item 2 | needs-owner | Engenharia — script de recifragem com `ENCRYPTION_KEY` |
| Auditoria de execução manual histórica de `migrar_bling_para_organizacoes()` | — | 10 | `10-final-evidence.md`, needs-owner item 4 | needs-owner | Owner — confirmar se função antiga foi executada manualmente em algum ambiente |

---

## 5. Integração Chatwoot

| Controle/Requisito | Ticket(s) antigo(s) 01-44 | Ticket(s) 07-24b | Arquivo/evidência | Status | Owner/pendência |
|---|---|---|---|---|---|
| IDs externos sobrepostos (inbox_id) não colidem entre organizações | 08, 31 | 11 | `11-final-evidence.md`: migration 47 + pgTAP `chatwoot_inbox_account_disambiguation.test.sql` 6/6 | done | — |
| Webhook por conexão (segredo específico, não global) — correção de segurança encontrada nesta passagem | 08, 11, 31 | 11 | `11-final-evidence.md`, seção 8: rota `/api/chatwoot/webhook/{conexaoId}` substitui segredo global único | done | — |
| Contract tests do adapter contra servidor HTTP fake real (schema inválido, 401, 429, 500, timeout, concorrência) | 31 | 11 | `11-final-evidence.md`: 11 cenários, `node:http` real, 37/37 testes | done | — |
| Envio/status exigem capacidade; falha externa não deixa sucesso local falso | 31 | 11 | `11-final-evidence.md`, seção 6 | done | — |
| Redação de token/segredo em logs e payload persistido | 31 | 11 | `11-final-evidence.md`, seção 4 | done | — |
| Jornada real em instância Chatwoot controlada | 44 | 11 | `11-final-evidence.md`, needs-owner item 1, com passo-a-passo | needs-owner | Owner — credenciais/instância real só ao final do ticket 25 |
| `GET /api/config` ainda expõe bloco Chatwoot legado via env vars globais | — | 11 | `11-final-evidence.md`, needs-owner item 2 | needs-owner | Ticket dedicado — migrar status para `conexoes_integracao` |
| Bug conhecido do provedor (chatwoot/chatwoot#13809, `secret` divergente de `hmac_token`) | — | 11 | `11-final-evidence.md`, needs-owner item 3 | needs-owner | Owner — verificar versão da instância real antes de conectar |

---

## 6. Inbox, outbox e jobs duráveis

| Controle/Requisito | Ticket(s) antigo(s) 01-44 | Ticket(s) 07-24b | Arquivo/evidência | Status | Owner/pendência |
|---|---|---|---|---|---|
| Apenas um worker possui lease válido (`FOR UPDATE SKIP LOCKED` real) | 32-35 | 12 | `12-final-evidence.md`: pgTAP `outbox_lease_correlacao.test.sql` assertions 4-6 | done | — |
| Duplicata não repete efeito (inbox já correto; outbox endurecido nesta entrega) | 32-35 | 12 | `12-final-evidence.md`: assertions 7-8, `concluir_evento_outbox` rejeita worker sem lease vigente | done | — |
| Crash/reinício retomam do checkpoint seguro (reaper de leases expirados) | 34, 35 | 12 | `12-final-evidence.md`: assertions 10-13, bug funcional real encontrado e corrigido no processo (guard de posse de lease incompleto) | done | — |
| Worker invocável sem timer obrigatório em memória (`runOutboxWorkerOnce`/`drainOutboxWorker`) | 34 | 12 | `12-final-evidence.md`: `outboxWorker.ts` + 13 testes de orquestração | done | — |
| Rota/RPC de replay explícita e auditada para outbox (só existe para inbox) | 35 | 12 | `12-final-evidence.md`, needs-owner item 1 | needs-owner | Ticket dedicado — RPC `preparar_replay_evento_outbox` |
| `correlation_id` preenchido pelos handlers HTTP existentes (coluna existe, callers não escrevem) | 40 | 12 | `12-final-evidence.md`, needs-owner item 2 | needs-owner | Engenharia — wiring nos handlers de webhook/sync |

---

## 7. Planos, entitlements, Stripe e ciclo de vida

| Controle/Requisito | Ticket(s) antigo(s) 01-44 | Ticket(s) 07-24b | Arquivo/evidência | Status | Owner/pendência |
|---|---|---|---|---|---|
| Limites aplicados atomicamente no servidor (`pg_advisory_xact_lock` + contagem no mesmo RPC) | 37 | 13 | `13-final-evidence.md`: pgTAP `entitlement_reserva_concorrente.test.sql` 9/9 | done | — |
| Transições inválidas/eventos antigos não regridem estado (ordering por versão/timestamp) | 37, 38 | 13 | `13-final-evidence.md`: `subscriptionLifecycle.test.ts` 14 casos, `rejected_stale` no RPC | done | — |
| Suspensão bloqueia mutação sem impedir leitura/exportação (LGPD) | 39 | 13 | `13-final-evidence.md`: `entitlementPolicy.test.ts`, `authorizeEntitlement.test.ts` | done | — |
| Nenhuma regra de entitlement duplicada em rota (`rg` zero) | 37 | 13 | `13-final-evidence.md`: busca `rg` sem match em `src/app/**` | done | — |
| SDK oficial Stripe real (não mock) para checkout/portal/webhook, price allowlist server-side | 38, 48 | 14 | `14-final-evidence.md`: `rg "cs_mock\|mock_portal\|cus_mock"` zero resultados em `src/`; `StripeSdkAdapter` real | done | — |
| Webhook Stripe autenticado via `constructEvent` oficial, idempotente, ordenado | 38 | 14 | `14-final-evidence.md`: `webhook/handlers.test.ts` — Proxy que falha o teste se acessar Supabase em assinatura inválida | done | — |
| Jornada completa de Test Mode (checkout→webhook→entitlement→portal→cancelamento→replay) | 44, 48 | 14 | `14-final-evidence.md`, seção 6, needs-owner com 11 passos exatos | needs-owner | Owner — `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/Price IDs reais só ao final do ticket 25 |
| `enforceIntegrationLimit` (limite de conexões Bling/Chatwoot) sem caller de rota real | — | 13 | `13-final-evidence.md`, needs-owner | needs-owner | Produto — nenhuma rota de "conectar" consome entitlement hoje; não bloqueante |

---

## 8. LGPD / Privacidade (mapeamento, cookies, direitos, retenção, incidentes)

| Controle/Requisito | Ticket(s) antigo(s) 01-44 | Ticket(s) 07-24b | Arquivo/evidência | Status | Owner/pendência |
|---|---|---|---|---|---|
| Inventário de dados, ROPA, matriz de fornecedores e RIPD produzidos (análise, não implementação) | 39, 40 | 15 | `docs/privacy/{data-inventory,ropa,vendor-role-matrix,ripd}.md` (citados nas evidências dos tickets 16-19) | done-with-caveats | Documentos técnicos completos; bases legais marcadas `needs-legal-review` |
| Aprovação jurídica das bases legais e decisões do RIPD | — | 15 | Ver `16-final-evidence.md` §7, `18-final-evidence.md` needs-owner item 1 | needs-owner | Owner/assessor jurídico — revisão agendada para o final do ticket 25 |
| Registry de cookies real (sem tracking opcional hoje) + `ConsentPolicy` pura test-first | — | 16 | `16-final-evidence.md`: `cookie-registry.md`, `consentPolicy.test.ts` 12/12 | done | — |
| Conteúdo jurídico do aviso de privacidade publicado | — | 16 | `16-final-evidence.md` §7, needs-owner item 1 | needs-owner | Owner/jurídico — bloqueado até aprovação do RIPD (ticket 15) |
| Canal de privacidade/DPO real | — | 16 | `16-final-evidence.md` §5, needs-owner item 2 | needs-owner | Owner — nenhum canal existe hoje, nenhum foi inventado |
| DPA/status de fornecedores (Supabase, Stripe, Bling, Chatwoot) | — | 16 | `16-final-evidence.md` needs-owner item 3 — todos `missing` | needs-owner | Owner — confirmar contratos/DPA reais |
| Direitos do titular: máquina de estados, verificação de identidade, export cifrado, propagação a 5 adapters (banco/bling/chatwoot/stripe/logs) | — | 17 | `17-final-evidence.md`: pgTAP `titular_direitos.test.sql` 24/24, 462 testes totais | done | — |
| Wiring de produção do outbox para adapters reais Bling/Chatwoot em solicitações de titular | — | 17 | `17-final-evidence.md` needs-owner item 6 | needs-owner | Engenharia — gap herdado do ticket 12 |
| Retenção, anonimização, eliminação, tombstone anti-reintrodução em restore | — | 18 | `18-final-evidence.md`: pgTAP `retencao.test.sql` 31/31, reconciliação pós-restore testada (assertions 22-23) | done | — |
| Prazos reais de retenção por categoria aprovados | — | 18 | `18-final-evidence.md` needs-owner item 1 — política travada em `pending_approval` por construção | needs-owner | Owner/jurídico — aprovação de prazos, prevista para fim do ticket 25 |
| Ativação de scheduler de retenção em produção | — | 18 | `18-final-evidence.md` needs-owner item 2 | needs-owner | Owner — decisão de ativação com pacote de autorização próprio |
| Auditoria anti-forjamento cross-tenant, redaction de logs, alertas sintéticos, tabletop de incidente | — | 19 | `19-final-evidence.md`: pgTAP `auditoria_anti_forjamento.test.sql` 8/8, `19-tabletop-report.md` | done | — |
| Entrega real de alerta em staging; nomeação de Incident Commander/DPO; ferramenta de plantão | — | 19 | `19-final-evidence.md` needs-owner itens 1-4 | needs-owner | Owner — staging/canal/responsáveis não existem ainda |
| Retrofit de auditoria nas rotas de auth/billing/membership já existentes | — | 19 | `19-final-evidence.md` needs-owner item 6 | needs-owner | Engenharia incremental, não bloqueante |

---

## 9. CI, gates de qualidade e artefato de build

| Controle/Requisito | Ticket(s) antigo(s) 01-44 | Ticket(s) 07-24b | Arquivo/evidência | Status | Owner/pendência |
|---|---|---|---|---|---|
| Baselines/ratchets de lint e AI-slop eliminados (zero-tolerance real) | 02, 12, 43 | 20 | `20-final-evidence.md`: `quality/lint-baseline.json`/`quality/aislop-baseline.json` deletados; lint 0/0, aislop 0 erros/2 warnings allowlisted | done | — |
| Ensaio deliberado de falha para cada gate obrigatório (test, typecheck, lint, aislop, secrets, boundaries, db-drift, build) | 02, 12, 20 | 20 | `20-final-evidence.md` §5: 9 gates, falha induzida com exit code real, revertida no mesmo turno | done | — |
| Inspeção de artefato de build (sem `.env`, `.scratch`, `.agents`, secret em bundle cliente) | 20 | 20 | `20-final-evidence.md` §6: `check-build-artifact.mjs` + 5 testes, novo script `build:artifact:check` | done | — |
| `src/app/page.tsx` (2218 linhas) e `src/services/bling.ts` (1183 linhas) acima do orçamento `file-too-large` | 42, 43 | 20 | `20-final-evidence.md` §4, itens 1-2, allowlisted com owner/ticket/data | needs-owner | Ticket de follow-up — modularização por aba/domínio |
| Strix (scanner de segurança CI) e Graphify (grafo de dependências) | — | 20 | `20-final-evidence.md` §9 | needs-owner | Não aprovado/configurado neste ambiente; explicitamente fora de escopo |
| `npm audit` interno do `aislop` falha no Windows (`spawn npm ENOENT`) — gate real (`audit:check`) passa | — | 20 | `20-final-evidence.md` §4 item 3 | done-with-caveats | Limitação de ambiente documentada, não bloqueante (0 vulnerabilidades reais) |

---

## 10. Deploy readiness, backup e restore

| Controle/Requisito | Ticket(s) antigo(s) 01-44 | Ticket(s) 07-24b | Arquivo/evidência | Status | Owner/pendência |
|---|---|---|---|---|---|
| Readiness/liveness/startup falham fechado por dependência ausente/timeout/5xx | 41 | 21 | `21-final-evidence.md`: 28 testes, matriz de 8 cenários injetados | done | — |
| Backup real (`pg_dump`) e restore real (`pg_restore`) em segunda instância vazia, com validação pós-restore completa | 41, 49 | 21 | `21-final-evidence.md` + `21-backup-restore-run.json`: 50 tabelas/56 linhas idênticas, checksums, constraints, RLS, functions, indexes, smoke multi-tenant, `validationErrors: []` | done | — |
| RPO/RTO medidos (não estimados) | 41 | 21 | `21-backup-restore-run.json`: RTO 6,64s (backup 2,55s + restore 4,09s), RPO 0s | done | — |
| Staging real isolado e reproduzível (host, domínio/TLS, Supabase separado) | 41, 49 | 21 | `21-final-evidence.md`, needs-owner item 1; `docs/adr/ticket-21-deploy-staging.md` | needs-owner | Owner — provisionar host/domínio/Supabase staging |
| Ensaio de rollback fim-a-fim em staging real | 41 | 21 | `21-final-evidence.md`, needs-owner item 5 | needs-owner | Depende de staging real (item acima) |
| Alertas críticos entregues a um canal real | 41 | 21 | `21-final-evidence.md`, needs-owner item 3 | needs-owner | Depende do canal do ticket 19 |

---

## 11. Sincronização Supabase real (pacote e aplicação)

| Controle/Requisito | Ticket(s) antigo(s) 01-44 | Ticket(s) 07-24b | Arquivo/evidência | Status | Owner/pendência |
|---|---|---|---|---|---|
| Ferramenta de geração de bundle (drift, ordem, checksum, rollback) construída e testada | 14, 15, 22, 23 | 22 | `22-final-evidence.md`: 26 testes unitários, `classifyDrift` rodado contra as 55 migrations reais do ledger | done | — |
| Ensaio completo do bundle em ambiente isolado (2 ciclos, fingerprint idêntico ao aprovado) | 14, 15, 23 | 22 | `22-final-evidence.md`: `239600fa...` idêntico em ambos os ciclos e ao `catalog-reference.json` aprovado | done | — |
| Project ref Supabase remoto real confirmado pelo owner | 14 | 22 | `22-final-evidence.md`, "Bloqueio estrutural confirmado" | needs-owner | Owner — nenhum project ref remoto existe nesta data (2026-08-28) |
| Inspeção read-only real de um projeto Supabase remoto | 14 | 22 | Não executável sem project ref | needs-owner | Depende do item acima |
| Aplicação supervisionada do bundle no Supabase real, com autorização imediatamente antes da escrita | 23 | 23 | `23-status.md`: ticket nasce `needs-owner` — mecanismo pronto e ensaiado (ticket 22), execução real não iniciada | needs-owner | Owner — project ref, credenciais, janela de aplicação e aprovação explícita, agendado para o fim do ticket 25 |

---

## 12. E2E real em staging e UI essencial

| Controle/Requisito | Ticket(s) antigo(s) 01-44 | Ticket(s) 07-24b | Arquivo/evidência | Status | Owner/pendência |
|---|---|---|---|---|---|
| Config Playwright fail-closed (URL staging HTTPS explícita, sem fallback localhost, Stripe test-mode) | 44, 51 | 24 | `24-final-evidence.md`: `stagingConfig.ts` + 17 testes; prova real de `StagingConfigError` sem `STAGING_URL` | done | — |
| Specs reais escritas para identidade, organização/CAS, catálogo→pedido→fiscal, negação cross-tenant, acessibilidade | 44 | 24 | `24-final-evidence.md`: 5 arquivos, 21 testes Playwright, seletores extraídos do DOM real | done-with-caveats | Seletores não validados contra staging real ainda (needs-owner item 10) |
| Specs de financeiro, Bling, Chatwoot, Stripe, LGPD e durabilidade | 44 | 24 | `24-final-evidence.md`, tabela "matriz mínima" — 6 itens marcados `❌ needs-owner`, nenhuma spec escrita | needs-owner | Engenharia — escrever specs quando staging/contas sandbox existirem |
| Execução real da suíte contra staging publicado | 44, 51 | 24 | `24-final-evidence.md`, needs-owner item 8 — nunca rodada | needs-owner | Depende de staging real (ticket 21) e Supabase sincronizado (ticket 23) |
| UI de organização/membros, conectar Bling/Chatwoot, plano/billing Stripe (antes só existiam via API) | — (gap descoberto pelo próprio ticket 24) | 24b | `24b-final-evidence.md`: `OrganizationPanel`/`IntegrationsPanel`/`BillingPanel`, 25 testes de componente novos, 644 testes totais verdes | done | — |
| `HealthMonitor` no topo do dashboard com `blingConnected`/`chatwootConnected` fixos (não reflete `/api/integracoes/saude` real) | — | 24b | `24b-final-evidence.md`, needs-owner item 1 | needs-owner | Ticket dedicado pequeno — trocar valores fixos por fetch real |
| `MembersList` exibe `user_id` bruto sem e-mail/nome (sem tabela de perfil) | — | 24b | `24b-final-evidence.md`, needs-owner item 2 | needs-owner | Produto — decidir Admin API server-side ou tabela `perfis` |
| Migração do spec Playwright `organization.spec.ts` para dirigir a UI real (hoje usa `page.request`) | — | 24b | `24b-final-evidence.md`, needs-owner item 3 | needs-owner | Engenharia — passo mecânico, não bloqueado por decisão de produto |

---

## Resumo quantitativo

- **Tickets 01–24b cobertos nesta matriz**: 26 (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 10b, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 24b).
- **Tickets com evidência `done`/`done-with-caveats` predominante**: 01, 02, 04, 05, 06, 07 (core), 08 (core), 09 (core), 10 (escopo reduzido), 11 (core), 12, 13, 16, 17, 18, 19, 20, 21, 22, 24b.
- **Tickets `needs-owner` integral ou majoritário**: 03, 14 (jornada real Stripe), 15 (aprovação jurídica), 23, 24 (execução real em staging).
- **Ticket `blocked`/não iniciado**: 10b (nenhum arquivo de evidência produzido).
- **Itens `needs-owner` individuais catalogados nesta matriz**: 34 (contando cada linha de dependência de owner/produto/engenharia listada acima).

## Observação sobre o plano `orbita-producao-saas` (tickets 01–51)

O diretório `.scratch/orbita-producao-saas/issues/` contém 51 tickets (01–51), mas a auditoria forense do Ticket 02 (`02-forensic-matrix.md`) cobriu explicitamente apenas os tickets 01–44 — os tickets 45–51 (`45-sanitizar-adotar-snapshot-auditado`, `46-fechar-rpcs-security-definer`, `47-concluir-tenancy-membership`, `48-integrar-stripe-real`, `49-deploy-backup-restore-reais`, `50-eliminar-ratchets-fechar-ci`, `51-e2e-staging-release-gate`) ficaram fora do escopo do audit por definição do próprio ticket 02 ("Auditar individualmente os tickets 01–44"). Por título, esses sete tickets finais do plano antigo mapeiam evidentemente para o mesmo território dos tickets 01/06 (fundação), 05 (RPCs), 06 (tenancy/membership), 14 (Stripe real), 21 (backup/restore real), 20 (ratchets/CI) e 24 (E2E staging) do plano atual — mas essa correspondência não tem uma auditoria criteriosa formal equivalente à do ticket 02, então não foi citada linha a linha nesta matriz como prova de substituição. Nenhum trabalho de auditoria adicional sobre 45–51 foi encontrado nos arquivos de evidência lidos.
