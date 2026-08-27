# Ticket 09 — Inventário de ownership: financeiro

Levantamento real (código e banco) feito antes de qualquer mudança, exigido pelo
`00-CONTRATO-EXECUCAO-CODIFICADOR.md`. Cobre `contas_financeiras`,
`categorias_financeiras`, `fornecedores`, `titulos_financeiros`, a tabela legada
`financeiro` e `financeiroRepository.ts`.

## CRITICAL STEP 0 — resultado registrado

- `AGENTS.md`: existe no repositório, lido integralmente.
- `git status --short` (antes de editar): árvore de trabalho limpa (branch recém
  criada a partir da `main` sincronizada).
- `git branch --show-current`: `fix/ticket-09-financeiro-organizacao`.
- `git rev-parse HEAD`: `36d47c569e2816224c299374518375d4ac889cb0`.
- `graphify-out/graph.json`: não consultado (ausente/não necessário; busca
  ampla feita com `Grep`/`rg` no código real).

## Estado do banco antes do ticket 09

`database/24_migrar_financeiro_organizacao.sql` (numeração legada "Ticket 28",
anterior à leva `orbita-mvp-producao-v2`) já havia:

- adicionado `organizacao_id` (nullable) em `contas_financeiras`,
  `categorias_financeiras`, `fornecedores` e `titulos_financeiros`;
- criado um índice único parcial `(organizacao_id, bling_id)` por tabela;
- criado triggers `fn_sync_*_financeiras_organizacao` /
  `fn_sync_titulos_financeiros_organizacao` que **auto-preenchem
  `organizacao_id` a partir da primeira membership do `user_id`** quando o
  chamador não informa — o mesmo fallback silencioso de tenancy encontrado no
  ticket 08 para catálogo/comercial, e que nunca quarentena ambíguos: apenas
  escolhe a primeira organização (`owner` antes, depois por `created_at asc`);
- criado uma função de backfill `migrar_financeiro_para_organizacoes()` que
  **não contabiliza nada e nunca quarentena órfãos/ambíguos** — apenas faz
  `update ... where organizacao_id is null` a partir de uma única membership
  arbitrária por `distinct on (user_id) ... order by owner, created_at asc`;
- criado políticas RLS no formato
  `(organizacao_id ...) OR (user_id = auth.uid())` para as 4 tabelas — o
  padrão `policy OR user_id` proibido pelo contrato.

`database/32_contrair_tenancy_legado.sql` (numeração legada "Ticket 36") já
substituiu a política `OR user_id` por uma política 100%
`usuario_pertence_a_organizacao(organizacao_id)` **apenas para
`titulos_financeiros` e `categorias_financeiras`**. `contas_financeiras` e
`fornecedores` **continuavam com a política `OR user_id`** até este ticket —
um usuário sem nenhuma membership de organização, mas com uma linha
`organizacao_id is null and user_id = auth.uid()`, ainda conseguiria acessá-la
via RLS.

`database/13_ownership_fornecedores_ids_externos.sql` (Ticket 17, já mesclado)
removeu as constraints `UNIQUE` globais em `bling_id` de todas as 4 tabelas e
as substituiu por índices únicos compostos **por `user_id`**
(`uq_idx_*_tenant_bling`). Esses índices legados por usuário continuam ativos
hoje, em paralelo aos índices por organização criados na migration 24 — dois
regimes de unicidade coexistindo, um deles (`user_id`) ainda com autoridade
sobre o legado de tenancy por usuário.

`database/12_quarentena_financeiro_sem_tenant.sql` (Ticket 16, já mesclado) já
remove e quarentena (em `quarentena_financeira`) qualquer linha de
`titulos_financeiros`, `categorias_financeiras` e `contas_financeiras` com
`user_id is null`. **`fornecedores` não foi coberto** por essa migration —
linhas de fornecedores com `user_id is null` (se existirem) nunca foram
quarentenadas.

O que faltava, endereçado por este ticket:

1. `organizacao_id` continuava **nullable** nas 4 tabelas (sem contrato
   final);
2. **nenhuma FK composta** impedia `titulos_financeiros.categoria_id` /
   `.conta_financeira_id` / `.fornecedor_id` de apontar para uma linha de
   outra organização — só havia validação via trigger
   (`fn_sync_titulos_financeiros_organizacao`, `raise exception`), não uma
   constraint real de banco;
3. o backfill (`migrar_financeiro_para_organizacoes`) não contabilizava nada e
   nunca quarentenava — ambíguos (usuário em 2+ organizações) eram resolvidos
   silenciosamente para a primeira organização, e órfãos (sem membership)
   ficavam com `organizacao_id = null` para sempre, sem registro do motivo;
4. `contas_financeiras` e `fornecedores` mantinham a política RLS
   `OR user_id` (achado de segurança real, não hipotético);
5. índices únicos `(user_id, bling_id)` legados continuavam ativos em paralelo
   aos índices `(organizacao_id, bling_id)`;
6. faltavam índices de consulta `(organizacao_id, data_vencimento)` e
   `(organizacao_id, situacao)` em `titulos_financeiros` (só existia
   `idx_titulos_abertos_vencimento` filtrado por `situacao = 'aberto'`, sem a
   coluna de organização à esquerda);
7. a camada de aplicação (`financeiroRepository.ts` e as três rotas) **não
   usava `VerifiedOrganizationScope`** — usava `VerifiedTenant` e a função
   `resolveTenantOrgId`, que **cai de volta para o próprio `userId` como org
   id quando não há membership** (fallback permissivo real, mesmo achado do
   ticket 08 para catálogo, reproduzido aqui de forma independente).

## `resolveTenantOrgId` — o fallback primitivo (antes do ticket 09)

`src/lib/organizationContext.ts`:

```ts
export async function resolveTenantOrgId(supabase, tenant) {
  const userId = typeof tenant === 'string' ? tenant : tenant.id;
  const { data } = await supabase
    .from('membros_organizacao')
    .select('organizacao_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return data?.organizacao_id ?? userId; // <- fallback para o próprio userId
}
```

Usado (antes do ticket 09), dentro da fatia financeira, apenas por
`src/repositories/financeiroRepository.ts` (todos os 5 métodos:
`getCategorias`, `getCategoriaByBlingId`, `getResumo`, `getTitulosFiltro`,
`upsertTitulo`). Esta função continua em uso fora da fatia financeira (rota
`bling/pedidos/[id]`, `src/services/sync.ts` — sempre seguida de
`verifyOrganizationScope`, que neutraliza o fallback antes de qualquer
leitura/escrita privilegiada) e não foi removida do arquivo, apenas descontinuada
dentro do domínio financeiro.

## Inventário completo de usos (antes do ticket 09)

| Arquivo/objeto | `user_id` como filtro/autoridade | `resolveTenantOrgId` cru (sem `verifyOrganizationScope`) | `organizacao_id` explícito | Policy `OR` no RLS |
|---|---|---|---|---|
| `src/repositories/financeiroRepository.ts` | sim, em `upsertTitulo` (`user_id: tenant.id`) | sim, em todos os métodos | via resolve (com fallback inseguro) | — |
| `src/app/api/financeiro/route.ts` (GET/POST) | não direto | indireto (via repo) | via repo | — |
| `src/app/api/financeiro/sync/route.ts` (POST) | não direto | indireto (via repo) | via repo | — |
| `src/app/api/financeiro/fornecedores/route.ts` (GET/POST) | não — **nunca toca `organizacao_id`/`user_id`**: é um passthrough puro do Bling via `bling.forUser(session.tenant)`, sem leitura/escrita na tabela `fornecedores` do Supabase | não | não aplicável | — |
| `database/24_migrar_financeiro_organizacao.sql` | trigger auto-fill (primeira membership, sem quarentena) | n/a | nullable | `OR user_id = auth.uid()` (não corrigida para `contas_financeiras`/`fornecedores`) |
| `database/32_contrair_tenancy_legado.sql` | backfill defensivo sem quarentena/contagem | n/a | ainda nullable | corrigida **apenas** para `titulos_financeiros`/`categorias_financeiras` |
| `database/13_ownership_fornecedores_ids_externos.sql` | índice único `(user_id, bling_id)` ainda ativo | n/a | n/a | n/a |
| `migrar_financeiro_para_organizacoes()` | resolve por 1ª membership, sem quarentena/contagem | n/a | n/a | n/a |
| `quarentena_financeira` (migration 12) | cobre `titulos_financeiros`/`categorias_financeiras`/`contas_financeiras`; **não cobre `fornecedores`** | n/a | n/a | n/a |

## `fornecedores` — achado de escopo de aplicação

A tabela `public.fornecedores` existe no banco (com `organizacao_id` desde a
migration 24) mas **nenhum caminho de código em `src/` faz `select`/`insert`
nela**. A rota `src/app/api/financeiro/fornecedores/route.ts` apenas consulta
e cria contatos diretamente no Bling (`bling.forUser(session.tenant)`), sem
espelhar no Supabase. Isso é preservado neste ticket (fora do escopo mudar o
comportamento de produto da rota); o trabalho de banco (FK composta, unique
por organização, RLS sem `OR user_id`, quarentena) é feito de qualquer forma
porque a tabela é uma FK de `titulos_financeiros.fornecedor_id` e pode ser
escrita diretamente por SQL/futuras integrações.

## Tabela legada `financeiro` (distinta de `*_financeiro*`)

`database/schema_master.sql` linha 152: `CREATE TABLE IF NOT EXISTS financeiro
(id, user_id, pedido_id, tipo, valor, forma_pagamento, data_pagamento, status,
...)`. Sem coluna `organizacao_id`. Único escritor: a função legada dentro do
próprio `schema_master.sql` (bloco de criação de pedido completo por RPC, que
insere em `financeiro` após criar `pedidos`/`itens_pedido`).

Busca `rg` confirmando zero callers em `src/`:

```
$ rg -n "from\('financeiro'\)|from\(\"financeiro\"\)|INSERT INTO financeiro" src database --include=*.ts --include=*.sql
database/schema_master.sql:543:    INSERT INTO financeiro (user_id, pedido_id, tipo, valor, forma_pagamento, status)
```

Nenhum resultado em `src/`. A tabela `financeiro` (legada) está órfã do lado
da aplicação: nenhuma rota, repositório ou serviço em `src/` a lê ou escreve.
Como o contrato proíbe eliminar dados financeiros no rollback/contract sem uma
decisão explícita do proprietário, e esta tabela está fora da lista de
entidades desta fatia (`contas_financeiras`, `categorias_financeiras`,
`fornecedores`, `titulos_financeiros`), **este ticket não migra nem contrai a
tabela `financeiro` legada** — fica registrada como `needs-owner`: decidir se
ela deve ser formalmente descontinuada (drop) ou re-arquitetada para
`organizacao_id` em um ticket futuro dedicado, já que mexer nela exigiria
tocar a RPC de criação de pedido completo, fora do domínio financeiro estrito
desta fatia.

## O que o ticket 09 muda (resumo — detalhado no checkpoint e na evidência final)

1. `financeiroRepository`: assinatura trocada de `VerifiedTenant` para
   `VerifiedOrganizationScope` em todos os métodos; `resolveTenantOrgId`
   removido deste arquivo; payload de `upsertTitulo` usa
   `scope.organizationId`/`scope.actorId` em vez de `tenant.id`.
2. `src/app/api/financeiro/route.ts` e `src/app/api/financeiro/sync/route.ts`
   passam a resolver `VerifiedOrganizationScope` via
   `resolveVerifiedOrganizationScope` (que usa
   `resolveActiveRequestOrganizationContext`) e repassam esse escopo ao
   repositório; `bling.forUser(session.tenant)` continua usando
   `VerifiedTenant` (autenticação por usuário no provedor externo, fora do
   escopo de tenancy de banco).
3. `src/app/api/financeiro/fornecedores/route.ts`: sem mudança de
   comportamento (não toca o banco); documentado acima.
4. Novas migrations `43` (expand: FKs compostas por `(id, organizacao_id)`,
   índices `(organizacao_id, data_vencimento)`/`(organizacao_id, situacao)`),
   `44` (backfill contabilizado e reexecutável, reaproveitando
   `tenancy_backfill_quarentena`/`tenancy_backfill_relatorio` já criadas pela
   migration 40) e `45` (contract: `NOT NULL` guardado por checagem em
   runtime, remoção do auto-fill silencioso nos triggers financeiros, RLS
   canônica sem `OR user_id` para as 4 tabelas, remoção dos índices únicos
   legados por `user_id`).

`VerifiedTenant`/`session.tenant` permanece em uso **apenas** para
`bling.forUser(...)` nas três rotas financeiras — autenticação do cliente
Bling por usuário, um domínio de credencial de provedor externo, fora do
escopo desta fatia (mesmo precedente do ticket 08).
