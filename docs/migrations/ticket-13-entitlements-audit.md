# Ticket 13 — Auditoria de planos, entitlements e ciclo de vida

## Mapa entitlement → operação → limite → contador

| Entitlement / recurso | Operação MVP | Limite (fonte) | Contador | Atomicidade antes | Atomicidade depois (Ticket 13) |
| --- | --- | --- | --- | --- | --- |
| `limite_membros` | Aceitar convite de membro (`aceitar_convite_organizacao`) | `planos.limite_membros` ou `assinaturas_organizacao.limites_customizados->>'limite_membros'` | `count(*) from membros_organizacao where organizacao_id = ...` | **Nenhuma.** Contagem nunca era checada no aceite; apenas `enforceMemberLimit` (TypeScript) contava antes do **convite** ser criado — não antes do membro ser inserido. Duas aceitações concorrentes de convites distintos podiam ambas passar quando restava 1 slot (TOCTOU real). | `pg_advisory_xact_lock(org+':membros')` + recontagem dentro do lock, no mesmo RPC que insere o membro (`database/49_...ordering.sql`). Prova: `supabase/tests/database/entitlement_reserva_concorrente.test.sql`. |
| `limite_conexoes_bling` / `limite_conexoes_chatwoot` | Conectar integração Bling/Chatwoot | `planos.limite_conexoes_*` | `count(*) from conexoes_integracao where organizacao_id=... and provedor=... and status='ativa'` | `enforceIntegrationLimit` existe mas **nenhuma rota chama**; nenhum caller encontrado (`rg enforceIntegrationLimit` só retorna a própria definição/teste). | Fora do escopo mínimo deste ticket (nenhuma rota real ainda consome o recurso); `entitlementPolicy.evaluateEntitlementPolicy` já suporta `limitedResource: 'conexoes_bling' \| 'conexoes_chatwoot'` para quando a rota existir — não é preciso nova regra quando isso acontecer. |
| Feature booleana (`export_relatorios`, etc.) | Qualquer mutação que exija o recurso do plano | `planos.recursos` / `limites_customizados.recursos` | N/A (booleano) | `enforceFeatureAccess` existia, sem caller real. | Unificado em `entitlementPolicy.evaluateEntitlementPolicy` (`requiredFeature`). |
| Ciclo de vida da organização (`organizacoes.status`) | Qualquer mutação (convite, alteração de plano, etc.) | N/A — bloqueio binário por estado | N/A | `assertOrganizationActive` existia mas **nenhuma rota mutável chamava**; `POST /organizacoes/[id]/convites` criava convites mesmo com organização suspensa/pending_deletion/cancelada. | `authorizeEntitlement` consulta o estado canônico (`mapPersistedStatusToLifecycleState`) e bloqueia mutação em suspended/cancelled/pending_deletion; leitura/exportação nunca são bloqueadas. |
| Status de assinatura Stripe (`assinaturas_organizacao.status`) | Sincronização de billing via webhook | N/A | N/A | `atualizar_assinatura_stripe_atomica` aplicava qualquer payload recebido sem comparar ordering — um evento antigo entregue fora de ordem podia regredir plano/status. | RPC agora recebe `p_event_versao`/`p_event_ocorrido_em`, trava a linha (`for update`) e rejeita (`outcome: 'rejected_stale'`) eventos mais antigos que o já persistido. Handler TS (`stripeWebhookHandler.ts`) propaga o timestamp `created` do evento Stripe (Zod-validado) e mapeia o outcome para `stale_ignored`. |

## Máquina de estados unificada

Antes deste ticket existiam **dois** modelos de estado desacoplados:

- `assinaturas_organizacao.status`: `trial \| active \| past_due \| canceled \| incomplete` (billing).
- `organizacoes.status`: `active \| suspended \| pending_deletion \| deleted` (operacional/LGPD).

Nenhuma rota combinava os dois de forma consistente — cada consumidor decidia por conta própria
qual checar (e a maioria não checava nenhum). O ticket exige uma máquina de estados única com
tagged union (`trial \| active \| past_due \| cancelled \| suspended \| pending_deletion`); a
função pura `mapPersistedStatusToLifecycleState`
(`src/repositories/entitlementLifecycleRepository.ts`) faz essa fusão: o status operacional da
organização tem prioridade sobre o status de billing (uma organização suspensa por violação de
termos continua bloqueada mesmo com fatura em dia); `deleted` é tratado como `pending_deletion`
(fail closed, nunca "active" por fallback); `incomplete` é tratado como `past_due`.

## Rotas/serviços auditados

- `src/app/api/organizacoes/[id]/convites/route.ts` — **gap real corrigido**: não verificava
  `VerifiedOrganizationScope` nem ciclo de vida antes de criar convite. Agora usa
  `verifyOrganizationScope` + `authorizeEntitlement`.
- `src/app/api/organizacoes/[id]/lifecycle/route.ts` — já usava `verifyOrganizationScope` e RPCs
  dedicadas; sem alteração necessária (fora do domínio de entitlement por operação, é o próprio
  gerenciamento do ciclo de vida).
- `src/lib/stripe/stripeWebhookHandler.ts` + `src/app/api/stripe/webhook/route.ts` — gap real
  corrigido: payload não era parseado com Zod (`JSON.parse(...) as StripeEvent` sem validação) e
  não havia ordering. Ambos corrigidos.
- Nenhuma rota em `src/app/api/**` contém `if (plan === ...)`, `if (plano === ...)`,
  `if (status === 'suspended')` fora dos módulos de domínio/serviço centralizados — ver busca
  reproduzível na evidência final.

## Migrations 33–35 — o que já existia vs. o que faltava

- **33** (`planos_limites_entitlements.sql`): catálogo de planos, assinatura por organização,
  histórico auditável, RPC de leitura de entitlements. Sólido, mantido sem alteração.
- **34** (`integrar_stripe_assinaturas.sql`): inbox idempotente de webhooks Stripe e RPC de
  sincronização. Faltava ordering/versão — corrigido na migration 49.
- **35** (`suspensao_retencao_encerramento.sql`): ciclo de vida da organização, suspensão,
  encerramento com anonimização LGPD. Sólido; `executar_encerramento_definitivo` já preserva
  meios de exportação ao não apagar `organizacoes` fisicamente (soft-delete `status='deleted'`) e
  ao anonimizar apenas dados de identificação de clientes, não os registros de negócio em si.

## Conclusão da auditoria

Os gaps reais identificados e corrigidos neste ticket:

1. Contador de membros não era atômico no ponto real de escrita (aceite de convite).
2. Nenhuma rota mutável real verificava o ciclo de vida da organização antes de agir.
3. Webhooks Stripe não tinham proteção contra eventos fora de ordem (nem parsing Zod na fronteira).
4. Não existia módulo de domínio único — cada necessidade de autorização exigiria duplicar regra.
