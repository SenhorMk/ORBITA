# Ticket 25 — Revisão Independente (Standards, Spec, Arquitetura, Tenancy/Auth/RLS, Integrações, Banco, Observabilidade, LGPD)

**Commit candidato:** `cd12c4f7a651515b01b3a880a37998f3701d6d0d`
**Branch:** `fix/ticket-25-gate-final-release-mvp`
**Data:** 2026-08-28
**Revisor:** codificador do ticket 25, lendo o código real no commit candidato (não reaproveitando texto de revisões anteriores de tickets 07-24b, apenas confirmando-as por amostragem).

Esta revisão não repete integralmente as revisões Standards/Spec já registradas dentro de `NN-final-evidence.md` de cada ticket 07-24b (essas já existem e foram por-pares dentro de cada ticket). Ela faz duas coisas: (1) confirma por amostragem que essas revisões anteriores não foram infladas, lendo o código citado; (2) aplica uma segunda passada, de nível de release, olhando o sistema como um todo em vez de ticket a ticket, onde inconsistências entre tickets só aparecem quando tudo é visto junto.

---

## 1. Eixo Standards (coding-standards / AGENTS.md)

**Achados:**

- `npm run lint:ratchet` → 0 erros, 0 warnings (zero-tolerance). `npm run aislop` → 2 erros + 2 warnings, todos os 4 com exceção documentada e justificada individualmente em `quality/aislop-allowlist.json` (2 arquivos grandes com plano de split registrado, 1 limitação de ambiente Windows no `npm audit` interno do aislop, 1 falso-positivo de SQL injection em identificador validado por `assertSafeIdentifier` e vindo de `information_schema`, não de input externo). Nenhuma exceção nova foi adicionada nesta revisão.
- Busca por `as any`, `TODO`, `FIXME`, `catch {}` vazio: `grep -rn "as any" src/` não retorna nenhuma ocorrência fora de arquivos de teste. Não foram encontrados stubs "sempre sucesso" nas rotas API revisadas por amostragem (`src/app/api/stripe/webhook`, `src/app/api/bling/webhook`, `src/app/api/chatwoot/webhook/[conexaoId]`, `src/app/api/organizacoes/switch`).
- Padrão de fronteira (Zod na entrada, ator/organização derivados de sessão verificada) é consistente nos módulos revisados: `src/lib/organizationContext.ts` centraliza a resolução de `VerifiedOrganizationScope`; as rotas amostradas chamam essa função antes de qualquer query privilegiada, em vez de aceitar `organization_id` do corpo da requisição.
- `src/app/page.tsx` (2218 linhas) e `src/services/bling.ts` (1183 linhas) seguem acima do orçamento de tamanho de arquivo. Isso já está registrado como achado aceito com plano de follow-up no allowlist do ticket 20 — não é um achado novo, apenas confirmado presente no commit candidato.

**Severidade:** nenhum achado bloqueante novo. Os dois arquivos grandes ficam como **médio, não bloqueante, owner=engenharia, ticket de follow-up já especificado no allowlist**.

---

## 2. Eixo Spec (o código bate com os tickets 06-24b?)

**Achados:**

- A arquitetura de contexto organizacional descrita no ticket 06 (`VerifiedOrganizationScope`, CAS de troca de organização, sem fallback para `user_id`) está implementada em `src/lib/organizationContext.ts` e é consumida pelos módulos posteriores (financeiro, catálogo, Bling, Chatwoot, entitlements) — confirmado por amostragem de imports e pela ausência de `resolveTenantOrgId` usado como autoridade fora do próprio módulo (as 6 ocorrências restantes em `src/` são: a própria definição, dois usos legítimos dentro de `ActorContext` já verificado, e três em testes).
- Ticket 10b (`BlingPort`/`BlingV3Adapter` com contract tests formais) foi desmembrado do ticket 10 e **não tem nenhum arquivo de evidência** em `.scratch/orbita-mvp-producao-v2/evidence/`. O ticket 10 entregou a integração Bling funcional (OAuth, webhook, backfill, refresh de token) mas não a separação formal de porta/adapter com contract tests dedicados que o item 42 do plano antigo e o próprio ticket 10b pedem. Isso é uma lacuna de escopo real, não apenas documentação: **achado de severidade média — spec do ticket 10b não implementada, sem evidência de início.**
- Ticket 24 (E2E real em staging) entrega a config fail-closed e 21 specs estruturalmente válidas (`playwright test --list` confirma isso nesta mesma execução), mas 6 áreas da "matriz mínima" do próprio ticket (financeiro, Bling, Chatwoot, Stripe, LGPD, durabilidade) não têm spec nenhuma escrita — não é só "não executado", é "não escrito". Isso é fielmente reportado como `needs-owner` no ticket 24, mas cabe destacar aqui: mesmo quando staging real existir, a suíte atual não cobre esses fluxos.

**Severidade:** achado de ticket 10b é o mais relevante — falta de execução de um ticket inteiro do plano, não apenas de um item interno. Owner: engenharia, sem bloquear o gate porque a integração Bling em si funciona (10) e o formalismo de porta/adapter é debt arquitetural, não um bug de tenancy/segurança.

---

## 3. Arquitetura / boundaries

- `npm run boundaries:check` → 0 violações dos limites do monólito modular no commit candidato.
- `npm run db:drift:check` → ledger de 56 arquivos SQL com checksums íntegros, ordem preservada.
- Não há `graphify-out/graph.json` neste ambiente (confirmado por `ls`), portanto a checagem de saúde de grafo pedida no ticket 25 não pôde ser executada com a ferramenta Graphify real — ver seção Graphify abaixo. A verificação de limites de módulo foi feita pelo script dedicado do repositório (`check-module-boundaries.mjs`), que é a ferramenta real usada durante todo o desenvolvimento 07-24b, não um substituto improvisado para este gate.

---

## 4. Tenancy / Auth / RLS (spot-check)

Reexecutei `npm run test:db` neste commit (não reaproveitei resultado anterior): 2 ciclos limpos do laboratório descartável, 55 migrations aplicadas em ordem, catálogo final idêntico entre os dois ciclos (hash `239600fa3c979f779e4da1aa556869c2eba6abfa2768f904a5e19cc064d17056`), pgTAP final (`supabase/tests/final/catalog_security.test.sql`) 15/15 asserções aprovadas.

Spot-checks adicionais, lendo o SQL diretamente:

- `grep -rl "OR.*user_id"` em `database/` retorna apenas migrations antigas (04, 07, 08, 10, 11 e o `schema_master.sql` histórico) e as migrations 40/41/43/44/45 — estas últimas são exatamente as migrations que **contraem** (removem) o padrão permissivo `organizacao_id IS NULL OR user_id = auth.uid()`, substituindo por RLS estritamente `organizacao_id`. Isso é confirmado pelo próprio log do `test:db` desta execução: as políticas antigas (`produtos_organizacao_select`, `clientes_org_select`, etc.) aparecem como "does not exist, skipping" quando as migrations de contração tentam removê-las — ou seja, o estado final do catálogo não contém mais as políticas permissivas antigas, só as políticas `_org_` estritas por organização introduzidas nos tickets 07-09.
- Nenhum `as any` ou cast `SAFETY` não documentado encontrado em `src/` fora de testes.

**Conclusão do spot-check:** consistente com o que os tickets 06-09 alegam ter corrigido. Nenhum achado crítico/alto novo nesta amostragem.

---

## 5. Integrações (Stripe / Bling / Chatwoot)

- **Stripe**: `grep -rn "cs_mock\|mock_portal\|cus_mock" src/` (reexecutado nesta revisão) não retorna nada — confirma a alegação do ticket 14 de que não há mock de produção. O adapter usa o SDK oficial (`StripeSdkAdapter`), o allowlist de Price ID é server-side. A jornada real de Test Mode nunca rodou contra uma conta Stripe real — permanece `needs-owner`, corretamente rotulado.
- **Bling**: OAuth one-time, refresh de token com lock de banco (pgTAP), resolução de organização no webhook fail-closed. A separação formal `BlingPort`/adapter com contract tests (ticket 10b) não existe — ver achado de Spec acima.
- **Chatwoot**: webhook por conexão (não mais segredo global) é uma correção de segurança real encontrada e corrigida durante o ticket 11, confirmada pela existência da rota `src/app/api/chatwoot/webhook/[conexaoId]/route.ts`. `GET /api/config` ainda expõe um bloco Chatwoot legado via variáveis de ambiente globais em vez de `conexoes_integracao` — achado conhecido, `needs-owner`, não crítico (não expõe segredo, expõe apenas status de configuração legada).

Nenhuma das três integrações rodou uma jornada real contra conta/sandbox de terceiro — todas corretamente `needs-owner`, aguardando credenciais reais que só chegam ao final deste ticket.

---

## 6. Banco / migrations

- Ledger de 56 arquivos SQL, checksums verificados (`db:drift:check`), aplicação forward-only confirmada por `test:db` nesta execução (55 migrations aplicadas em ordem sem erro fatal — os `NOTICE ... does not exist, skipping` são idempotência esperada de `DROP POLICY IF EXISTS`/`DROP TRIGGER IF EXISTS`, não falhas).
- Constraints de integridade tenant (`fk_..._org`) presentes desde a migration 40 em diante, com backfill contabilizado (migrations 41/44/46) e depois contração (42/45) — o padrão expand/backfill/contract exigido por `orbita-database` foi seguido.

---

## 7. Observabilidade

- `src/lib/organizationContext.ts` e os handlers de webhook amostrados usam `redactSensitiveData`/equivalentes antes de logar payloads (confirmado no ticket 07/11 e não contradito nesta amostragem).
- `correlation_id` existe como coluna (migration 48) mas não é preenchido pelos handlers HTTP existentes — gap conhecido, `needs-owner`, registrado no ticket 12.
- Retrofit de auditoria em rotas de auth/billing/membership pré-existentes ao ticket 19 é parcial — registrado como `needs-owner` no próprio ticket 19, não uma alegação nova desta revisão.

---

## 8. LGPD (revalidação de que a peça existe e está referenciada corretamente — não é decisão jurídica)

Confirmado por leitura direta nesta revisão (não apenas por citação do ticket 02/15-19):

- `docs/privacy/data-inventory.md`, `docs/privacy/ropa.md`, `docs/privacy/ripd.md`, `docs/privacy/vendor-role-matrix.md`, `docs/privacy/cookie-registry.md` existem e cada um contém marcações explícitas `needs-owner`/`needs-legal-review` (10, 24, 7, 21 e 1 ocorrências respectivamente, contadas nesta revisão via `grep -c`).
- `docs/operations/incident-response.md` existe e contém 8 ocorrências de `needs-owner`.
- Nenhuma base legal foi aprovada por esta revisão nem por nenhum ticket anterior — cada arquivo mantém a decisão jurídica como pendente do responsável qualificado, exatamente como o ticket 25 exige. Esta revisão não decide base legal, apenas confirma a existência e a honestidade das marcações pendentes.

---

## 9. Achados agregados desta revisão independente

| # | Achado | Severidade | Eixo | Owner | Decisão |
|---|---|---|---|---|---|
| 1 | Ticket 10b (BlingPort/Adapter formal + contract tests) sem nenhuma evidência de execução | Média | Spec | Engenharia | Não bloqueia o gate — a integração Bling funcional (ticket 10) está testada; o formalismo de porta/adapter é debt arquitetural documentado, não uma falha de tenancy/segurança. Registrar no risk register. |
| 2 | `src/app/page.tsx` e `src/services/bling.ts` acima do orçamento de tamanho | Média | Standards | Engenharia | Já aceito e documentado no allowlist do ticket 20 (data 2026-08-28, com plano de split). Não bloqueia. |
| 3 | 6 áreas da matriz mínima de E2E (financeiro, Bling, Chatwoot, Stripe, LGPD, durabilidade) sem spec Playwright escrita | Média | Spec/Testing | Engenharia | Registrado no ticket 24 como `needs-owner`; não bloqueia o gate porque as jornadas centrais (identidade, organização, catálogo→fiscal, cross-tenant, acessibilidade) têm cobertura estrutural comprovada. |
| 4 | `GET /api/config` expõe bloco Chatwoot legado via env vars globais em vez de `conexoes_integracao` | Baixa | Spec/Segurança | Engenharia | Expõe apenas status, não segredo. Não bloqueia; ticket dedicado recomendado. |
| 5 | `correlation_id` não preenchido pelos handlers HTTP existentes | Baixa | Observabilidade | Engenharia | Não bloqueia; reduz rastreabilidade de incidentes até ser corrigido. |
| 6 | Graphify não configurado neste ambiente — diagnóstico de saúde de grafo não pôde ser executado com a ferramenta real | Média | Processo/Ferramental | Owner (ferramenta externa) | Ver seção Graphify do formulário GO/NO-GO. Não é um achado de código. |

**Nenhum achado crítico ou alto foi encontrado nesta revisão independente.** Nenhuma correção de código foi feita durante esta revisão — cada achado acima já estava documentado no próprio ticket que o originou; esta revisão apenas confirmou, por leitura direta do código no commit candidato, que as alegações anteriores são precisas e que nenhum achado novo de severidade crítica/alta surgiu ao olhar o sistema como um todo.
