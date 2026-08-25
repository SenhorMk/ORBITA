# Inventário de autoridade organizacional

Snapshot do Ticket 06. Os números de linha são verificáveis pelos comandos abaixo; alterações futuras devem regenerar este ledger.

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
| `src/app/api/bling/webhook/route.ts:24-91` | query hint + assinatura + conexões/membership | hint não é autoridade | remover fallbacks `tenant.id`/`user_id` em ticket próprio |

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

## Autoridade legada explicitamente não reutilizável

| Local | Fonte problemática | Disposição |
| --- | --- | --- |
| `src/lib/auth.ts:136-147` | `app_metadata.role/tenant_id` | compatibilidade residual; proibido no contexto canônico |
| `src/app/api/config/route.ts:15-20,73-80` | `verifySessionAndRole` + `session.tenant.id` + body | migrar por fatia |
| `src/app/api/dashboard/route.ts:12,46` | tenant pessoal | migrar por fatia |
| `src/app/api/nfe/route.ts:12,20,33,47,141` | tenant pessoal + body | migrar por fatia fiscal |
| `src/app/api/pedidos/status/route.ts:10,15-16` | tenant pessoal + body | migrar por fatia comercial |
| `src/repositories/clienteRepository.ts:3-61` | `resolveTenantOrgId` | adapter legado; não copiar |
| `src/repositories/produtoRepository.ts:3-97` | `resolveTenantOrgId` | adapter legado; não copiar |
| `src/repositories/pedidoRepository.ts:3-181` | `resolveTenantOrgId` | adapter legado; não copiar |
| `src/repositories/financeiroRepository.ts:4-100` | `resolveTenantOrgId` | adapter legado; não copiar |
| `src/app/api/{clientes,produtos}/(update|delete)` | `verifySessionAndRole` + body | migração residual catálogo/comercial |
| `src/app/api/{financeiro,financeiro/fornecedores,financeiro/sync}` | `verifySessionAndRole` + query/body | migração residual financeiro |
| `src/app/api/{sync,sync/status,startup,bling/situacoes}` | `verifySessionAndRole` | migração residual sync/startup |

## Comandos reproduzíveis

```powershell
rg -n "verifySessionAndRole|session\.tenant\.id|resolveTenantOrgId|app_metadata" src/app/api src/lib src/repositories --glob "*.ts" --glob "!*.test.ts"
rg -n "request\.json\(|req\.json\(|searchParams\.get|headers\.get\(|params.*Promise" src/app/api --glob "*.ts" --glob "!*.test.ts"
rg -n "userIdHint|organizacaoId =|organizacao_id.*metadata|webhook|orbita_active_org" src/app/api src/lib --glob "*.ts" --glob "!*.test.ts"
rg -l "resolveActiveOrganization" src/app/api --glob route.ts
```

O último comando deve retornar zero. Este inventário registra dívida existente; não concede autoridade a nenhuma fonte marcada como residual.
