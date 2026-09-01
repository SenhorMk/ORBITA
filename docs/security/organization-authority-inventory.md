# Inventário de autoridade organizacional

Snapshot do Ticket 06, atualizado na **fatia A do Ticket 22** (01/09/2026). Os números de linha são verificáveis pelos comandos abaixo; alterações futuras devem regenerar este ledger.

## Fontes canônicas

| Local | Fonte | Autoridade | Disposição |
| --- | --- | --- | --- |
| `src/lib/auth.ts:242` | bearer token verificado | identidade do ator | legado ainda usado por rotas residuais; contexto novo usa a verificação de identidade sem papel de metadata |
| `src/lib/organizationAuthorization.ts:103` | seleção ativa persistida | seleção, nunca cookie | canônico |
| `src/repositories/organizationMembershipRepository.ts:58-83` | `contextos_organizacao_ativos` + `membros_organizacao` | organização, versão, papel | canônico; falha fechada |
| `src/app/api/organizacoes/switch/route.ts:34-75` | body + contexto + CAS | body é candidato; DB decide | canônico; stale `409` |
| `src/app/api/bling/callback/route.ts:12-34` | query/state e transação OAuth assinada | transação persistida vincula ator/organização | manter contrato OAuth |
| `src/app/api/stripe/webhook/route.ts:12` | header de assinatura Stripe | autenticidade do evento | manter; organização vem do mapeamento persistido do provedor |
| `src/app/api/chatwoot/webhook/route.ts:89-164` | assinatura + inbox/membership persistidos | mapeamento do webhook | remover fallback pessoal em `:169` em ticket próprio |
| `src/app/api/bling/webhook/route.ts` | assinatura HMAC contra o cofre | a conexão que assina determina a organização | **resolvido no ticket 11**: o hint `?userId=` e os fallbacks `tenant.id`/`membros_organizacao` foram removidos; a organização vem da linha de `conexoes_integracao` |

## Entradas HTTP não confiáveis já confrontadas com contexto canônico

| Local | Fonte | Uso permitido | Disposição |
| --- | --- | --- | --- |
| `src/app/api/auditoria/route.ts:30-33` | query | filtros dentro da organização provada | migrado |
| `src/app/api/stripe/checkout/route.ts:35` e `stripe/portal/route.ts:32` | body | dados de operação; organização vem do contexto | migrado |
| `src/app/api/chatwoot/send/route.ts:91` e `status/route.ts:21` | body | recurso filtrado pela organização provada | migrado |
| `src/app/api/organizacoes/route.ts:41` | body | criação após identidade verificada | identidade-only por necessidade de bootstrap |
| `src/app/api/organizacoes/switch/route.ts:34` | body | destino + versão candidatos | membership + CAS obrigatórios |
| `src/app/api/bling/pedidos/[id]/handlers.ts:38,59,142` | path/body | recurso deve ser filtrado no domínio | residual acompanhado pelos tickets comerciais |
| `src/app/api/sync/status/route.ts:19` | query | job precisa permanecer escopado ao ator | residual |
| `src/app/api/organizacoes/[id]/convites/route.ts:12-40` | path/body | ID candidato | residual: migrar para contexto/capability |
| `src/app/api/organizacoes/[id]/lifecycle/route.ts:41-96` | path/body | ID candidato | residual: migrar para contexto/capability |
| `src/app/api/organizacoes/[id]/membros/[userId]/route.ts:8-15` | path | IDs candidatos | residual: migrar para contexto/capability |

## Migrado na fatia A do Ticket 22 (01/09/2026)

Dez handlers deixaram de consultar `app_metadata`. O portão legado era
redundância: cada rota já resolvia `resolveVerifiedOrganizationScope` logo
abaixo, que responde 401/403/503 pela fonte canônica.

| Rota | O que saiu |
| --- | --- |
| `bling/situacoes`, `financeiro`, `financeiro/fornecedores` (GET+POST) | portão puro |
| `clientes/delete`, `produtos/delete`, `nfe` | `session.role !== 'dono'` → `escopoTemCapacidade(scope, 'organization:manage')` |
| `pedidos/manual`, `pedidos/status`, `financeiro/sync` | `session.tenant.id` como ator → `scope.actorId` |

**`src/app/api/config` foi apagada**, por decisão do proprietário. Lia
`integracoes_bling` — tabela sem grants de `service_role` desde as migrations de
endurecimento, que responde 403 — por `user_id` legado, e nenhum arquivo do
`src/` a chamava. Isso encerra também o achado "GET /api/config expõe bloco
Chatwoot legado via env vars globais", registrado como `needs-owner` nos
documentos do Ticket 25: a rota não existe mais.

## Autoridade legada explicitamente não reutilizável

| Local | Fonte problemática | Disposição |
| --- | --- | --- |
| `src/lib/auth.ts:136-147` | `app_metadata.role/tenant_id` | compatibilidade residual; proibido no contexto canônico |
| `src/app/api/dashboard/route.ts:12,46` | tenant pessoal | migrar por fatia |
| `src/repositories/clienteRepository.ts:3-61` | `resolveTenantOrgId` | adapter legado; não copiar |
| `src/repositories/produtoRepository.ts:3-97` | `resolveTenantOrgId` | adapter legado; não copiar |
| `src/repositories/pedidoRepository.ts:3-181` | `resolveTenantOrgId` | adapter legado; não copiar |
| `src/repositories/financeiroRepository.ts:4-100` | `resolveTenantOrgId` | adapter legado; não copiar |
| `src/app/api/{clientes,produtos}/update` | `verifySessionAndRole` + body | conferir na fatia B |
| `src/app/api/{sync,sync/status,startup}` | `verifySessionAndRole` passado inteiro ao `syncService` | **fatia B** — exige trocar o port do serviço, que hoje recebe `ActorContext` |
| `src/app/api/bling/pedidos/[id]`, `src/app/api/categorias/sync` | `resolveActorContext` | **fatia B** — mesma fonte legada, que o inventário do Ticket 22 não via. `categorias/sync` ainda **escreve** `user_id: tenant.id` |

## Comandos reproduzíveis

```powershell
rg -n "verifySessionAndRole|session\.tenant\.id|resolveTenantOrgId|app_metadata" src/app/api src/lib src/repositories --glob "*.ts" --glob "!*.test.ts"
rg -n "request\.json\(|req\.json\(|searchParams\.get|headers\.get\(|params.*Promise" src/app/api --glob "*.ts" --glob "!*.test.ts"
rg -n "userIdHint|organizacaoId =|organizacao_id.*metadata|webhook|orbita_active_org" src/app/api src/lib --glob "*.ts" --glob "!*.test.ts"
rg -l "resolveActiveOrganization" src/app/api --glob route.ts
```

O último comando deve retornar zero. Este inventário registra dívida existente; não concede autoridade a nenhuma fonte marcada como residual.
