# Contexto canônico de organização


> **Superado em partes pelo Ticket 22, fatia C (01/09/2026).**
>
> `verifySessionAndRole`, `resolveActorContext`, `actorContextDenialStatus`,
> `resolveLegacyMembership` e os tipos `ActorContext`/`ActorCapability`/
> `ActorRole`/`AuthSession` **não existem mais**: resolviam papel a partir de
> `app_metadata.role`, campo que nenhum fluxo escreve, e foram removidos depois
> que as 19 fronteiras migraram para `membros_organizacao`. Onde este documento
> os descreve como ativos, o texto é **snapshot histórico**.
>
> A autoridade atual é `resolveVerifiedOrganizationScope` /
> `authorizeRequestOrganizationCapability`, com `resolveAuthenticatedIdentity`
> apenas para identidade. A guarda `authorization-distinction` do
> `boundaries:check` cobre `src/app/api/` inteiro.
>
> Ressalva: `resolveTenantOrgId` continua existindo e ainda devolve o `userId`
> como organização quando não acha vínculo. Tem zero chamadores de produção, e a
> regra `tenancy-legacy-resolver` impede que ganhe algum. Destino no ticket 25.

## Contrato

`resolveOrganizationContext`, em `src/lib/organizationAuthorization.ts`, é a autoridade para requisições autenticadas que acessam dados de uma organização. O contexto só existe após duas provas independentes:

1. o bearer token foi verificado pelo provedor de identidade no servidor;
2. a combinação exata de `user_id` e `organizacao_id` existe em `membros_organizacao` e contém um papel válido.

Parâmetros de rota, body, query string, headers, cookies e `app_metadata` são entradas não confiáveis. Nenhum deles cria membership nem escolhe a organização ativa. `owner` e `admin` recebem `organization:manage`; `member` recebe apenas `organization:access`.

Uma preferência explícita inválida, externa ou revogada retorna a mesma negação e nunca escolhe outra organização. Falha do banco de autorização é distinguida como indisponibilidade e falha fechada.

## Troca de organização

`POST /api/organizacoes/switch` exige:

- `organizacao_id`: destino desejado;
- `expected_version`: versão persistida retornada por `GET /api/organizacoes`.

O servidor autentica a sessão, valida a membership do destino e chama `alternar_organizacao_ativa_cas`. O RPC compara e incrementa a versão na mesma instrução de escrita; somente uma requisição concorrente vence. Repetir uma versão consumida produz `409`. O cookie HTTP-only é apenas uma conveniência de interface e nunca participa da autorização.

## Inventário de fontes e migração

| Fonte atual | Autoridade permitida | Tratamento |
| --- | --- | --- |
| bearer token | identidade, após `auth.getUser` | canônico |
| `membros_organizacao` | organização, papel e capacidades | canônico |
| `contextos_organizacao_ativos` | organização ativa e versão CAS | canônico, após membership persistida |
| `orbita_active_org` | conveniência de interface | nunca usar como autoridade |
| parâmetro `[id]`, body, query e headers | entrada não confiável | parsear e confrontar com o contexto |
| `app_metadata.role` / `tenant_id` | compatibilidade temporária de rotas antigas | não usar no contexto canônico |
| `session.tenant.id` e `user_id` pessoal | modelo legado | remover por fatias; nunca usar como fallback organizacional |
| mapeamento de webhook verificado | candidato de workflow sem sessão | autenticar assinatura e validar escopo persistido |

As bordas de organização ativa migradas neste ticket são: organizações (leitura), troca de organização, auditoria, Stripe checkout/portal, Bling authorize, Chatwoot sync/status/send e saúde de integrações. A borda resolve o contexto canônico e somente então o adapta para `VerifiedOrganizationScope` quando chama um adapter privilegiado.

O serviço de aplicação depende de `OrganizationMembershipPort`; `SupabaseOrganizationMemberships` é o adapter que contém query, parsing de row e classificação de indisponibilidade. `requestOrganizationContext.ts` é a composição de produção. Auth e banco indisponíveis produzem `503`, enquanto sessão ausente/inválida produz `401` e membership ausente/revogada produz `403`.

O ledger detalhado, com arquivo/linha, fonte, autoridade e disposição, está em `docs/security/organization-authority-inventory.md`.

### Busca reproduzível de compatibilidade residual

Executar na raiz:

```powershell
rg -l "verifySessionAndRole" src/app/api --glob route.ts
rg -l "resolveActiveOrganization" src --glob "*.ts" --glob "*.tsx"
rg -l "resolveTenantOrgId" src --glob "*.ts" --glob "*.tsx"
rg -l "session\.tenant\.id" src/app/api --glob route.ts
```

Resultado no fechamento do Ticket 06:

- `resolveActiveOrganization`: zero rotas; apenas implementação legada e testes de compatibilidade;
- `verifySessionAndRole`: 20 rotas residuais, delimitadas aos módulos catálogo/comercial/fiscal/financeiro/sync/convites/startup;
- `resolveTenantOrgId`: adapters legados de catálogo, comercial, financeiro e sync;
- `session.tenant.id`: `config`, `dashboard`, `nfe` e `pedidos/status`.

Esses callers não podem ser copiados por código novo. Permanecem temporariamente para migração vertical nos tickets de contenção dos respectivos domínios; a compatibilidade não participa da construção de `OrganizationContext`.

## Verificação objetiva

- testes de contrato cobrem owner, admin, member, externo, revogado, metadata não autoritativa, candidato malformado e indisponibilidade de Auth/DB;
- testes da troca e pgTAP cobrem versão inicial, replay, vencedor/perdedor concorrente, cross-tenant e membership revogada;
- o teste da rota de saúde prova a passagem pelo contexto antes do adapter privilegiado;
- o laboratório Supabase executa duas reconstruções limpas, todos os pgTAP e catálogo final idêntico (`9c44ec2d247df0867f88b41223ad6896959e3209f009177e32e2e21bf2d9bb2d`);
- a migration local ordenada é `database/38_contexto_organizacao_ativo_cas.sql`; nenhuma alteração foi feita no Supabase remoto.

## Rollout, validação e rollback

Ordem obrigatória para um ambiente compartilhado, somente em ticket de deploy aprovado:

1. aplicar `38_contexto_organizacao_ativo_cas.sql` antes do aplicativo;
2. validar tabela, grants, função e ausência de rows órfãs pelas consultas abaixo;
3. publicar o aplicativo que lê `selectionVersion` e troca por CAS;
4. observar taxas de `403`, `409` e `503`; somente então considerar o rollout concluído.

Usuários legados começam sem row em `contextos_organizacao_ativos`. Nesse estado, o adapter escolhe deterministicamente a primeira membership e expõe `selectionVersion = 0`; a primeira troca autorizada insere a row na versão 1. O antigo cookie pode apontar para outra organização, mas é deliberadamente ignorado. Isso pode mudar a organização inicialmente exibida uma única vez para usuários que dependiam apenas do cookie; a UI deve carregar `GET /api/organizacoes` antes de emitir ações organizacionais.

Validações pós-migration:

```sql
select to_regclass('public.contextos_organizacao_ativos');
select to_regprocedure('public.alternar_organizacao_ativa_cas(uuid,uuid,bigint)');
select count(*) as contextos_orfaos
from public.contextos_organizacao_ativos c
left join public.membros_organizacao m
  on m.user_id = c.user_id and m.organizacao_id = c.organizacao_id
where m.id is null;
select grantee, privilege_type
from information_schema.role_routine_grants
where routine_schema = 'public'
  and routine_name = 'alternar_organizacao_ativa_cas'
order by grantee, privilege_type;
```

Resultado esperado: tabela e função presentes, zero órfãos e `EXECUTE` apenas para `service_role` (além do owner da função). A criação da tabela e da função adquire locks de catálogo breves; não há backfill, scan ou rewrite de tabela existente. Cada troca bloqueia no máximo a row do usuário em `contextos_organizacao_ativos`; usuários diferentes não disputam a mesma row.

Rollback seguro é aplicativo-primeiro: reverter o aplicativo para a versão anterior, interrompendo novas escritas CAS, e preservar tabela, função e dados. Não dropar a tabela em rollback operacional, pois isso perderia a organização ativa/versionamento já gravados. A remoção física, se algum dia necessária, exige ticket separado, export/contagem das rows, janela aprovada e confirmação de que nenhum caller usa a função. A migration é forward-only; o rollback não executa DDL destrutiva.
