# Ticket 08 — Inventário de ownership: catálogo, comercial, estoque, fiscal

Levantamento real (código e banco) feito antes de qualquer mudança, exigido pelo
`00-CONTRATO-EXECUCAO-CODIFICADOR.md`. Cobre `produtos`, `categorias`, `clientes`,
`pedidos`, `itens_pedido`, `movimentacao_estoque`, `documentos_fiscais`.

## CRITICAL STEP 0 — resultado registrado

- `AGENTS.md`: **existe** no repositório (contradiz a premissa do ticket de que
  estaria ausente; registrado aqui em vez de inventado — o arquivo não foi
  lido/seguido como fonte normativa adicional, apenas confirmada sua presença).
- `graphify-out/graph.json`: **ausente**, confirmado (`ls graphify-out` falha).
  Nenhuma busca por grafo foi possível; usada busca ampla por `grep`/`rg` no
  código real.
- `git status --short` (antes de editar): mostrava o working tree do ticket 07
  ainda não commitado (arquivos de `database/39_...`, `oauthTransactionStore.ts`,
  `rateLimit*.ts`, etc.), mais o `.md` deste próprio ticket 08 sendo lido.
- `git branch --show-current`: `fix/ticket-08-catalogo-comercial-estoque-fiscal`.
- `git rev-parse HEAD`: `a64f701b11ed29bdd184e93c422679223cf2b2d8`.

## Estado do banco antes do ticket 08

Migrations `22_migrar_catalogo_organizacao.sql` e
`23_migrar_comercial_estoque_fiscal.sql` (numeração legada "Ticket 26/27",
anterior à leva `orbita-mvp-producao-v2`) já haviam:

- adicionado `organizacao_id` (nullable) em todas as 7 tabelas da fatia;
- criado triggers `fn_sync_*_organizacao` que **auto-preenchem
  `organizacao_id` a partir de `user_id`/primeira membership** quando o
  chamador não informa — um fallback silencioso de tenancy;
- criado políticas RLS no formato
  `(organizacao_id ... ) OR (user_id = auth.uid())` — exatamente o padrão
  `policy OR user_id` proibido pelo contrato.

A migration `32_contrair_tenancy_legado.sql` (numeração legada "Ticket 36")
já havia substituído essas políticas OR por políticas 100%
`usuario_pertence_a_organizacao(organizacao_id)` para as 7 tabelas — ou seja,
**a camada RLS já estava correta** antes deste ticket. O que restava
pendente, e que o ticket 08 endereça:

1. `organizacao_id` continuava **nullable** (sem contrato final);
2. **nenhuma FK composta** impedia item/documento/pedido de apontar para
   pedido/produto/cliente de outra organização — só havia validação via
   trigger (`raise exception`), não uma constraint real de banco;
3. o backfill legado (`migrar_catalogo_para_organizacoes`,
   `migrar_comercial_para_organizacoes`, e o backfill defensivo dentro da
   migration 32) **não contabilizava** nada e nunca quarentenava — órfãos
   ficavam com `organizacao_id = null` para sempre, sem registro do motivo;
4. a camada de aplicação (rotas e repositórios) **não usava
   `VerifiedOrganizationScope`** para esta fatia — usava `VerifiedTenant`
   (tenant primitivo por usuário) e a função `resolveTenantOrgId`, que **cai
   de volta para o `userId` como org id quando não há membership** (fallback
   permissivo real, achado abaixo).

## `resolveTenantOrgId` — o fallback primitivo (antes do ticket 08)

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

Usado (antes do ticket 08) em `produtoRepository.ts`, `clienteRepository.ts`,
`pedidoRepository.ts` — todos os métodos (`getAll`, `getByBlingId`, `upsert`,
`delete`, `getAllEnriched`, `getById`, `deleteByBlingId`, `addItems`,
`upsertNfe`) recebiam um `VerifiedTenant` e resolviam `organizacao_id`
internamente com esse fallback.

## `src/app/api/pedidos/manual/route.ts` — pior caso encontrado

Antes do ticket 08, esta rota (o núcleo da jornada obrigatória: criar pedido
manual → baixar estoque → registrar movimentação) **nem usava
`resolveTenantOrgId`**: filtrava `clientes` e `produtos` diretamente por
`.eq('user_id', userId)`, inseria `pedidos`/`itens_pedido` só com `user_id`
(sem `organizacao_id` explícito, dependendo do trigger de dual-write), e
chamava a RPC `decrement_estoque(p_user_id, p_produto_id, p_qty)` — escopada
por usuário, não por organização, e que fazia `GREATEST(0, estoque - qty)`
(nunca falha, mesmo com estoque insuficiente — a checagem de disponibilidade
ficava só na camada de aplicação, não no banco).

## Inventário completo de usos (antes do ticket 08)

| Arquivo | `user_id` como filtro/autoridade | `resolveTenantOrgId` | `organizacao_id` explícito | Policy `OR` no RLS |
|---|---|---|---|---|
| `src/repositories/produtoRepository.ts` | não (usa `orgId` resolvido) | sim, em todos os métodos | sim (via resolve) | — |
| `src/repositories/clienteRepository.ts` | não | sim, em todos os métodos | sim (via resolve) | — |
| `src/repositories/pedidoRepository.ts` | não | sim, em todos os métodos | sim (via resolve) | — |
| `src/app/api/produtos/update/route.ts` | não | indireto (via repo) | via repo | — |
| `src/app/api/produtos/delete/route.ts` | não | indireto (via repo) | via repo | — |
| `src/app/api/clientes/update/route.ts` | não | indireto (via repo) | via repo | — |
| `src/app/api/clientes/delete/route.ts` | não | indireto (via repo) | via repo | — |
| `src/app/api/pedidos/manual/route.ts` | **sim, direto** (`clientes`, `produtos`, `pedidos`, `itens_pedido`) | não | não (dependia do trigger) | — |
| `src/app/api/pedidos/status/route.ts` | **sim, direto** (`itens_pedido`, `produtos`) | indireto (via repo p/ pedido) | não (updates diretos) | — |
| `src/app/api/nfe/route.ts` | **sim, direto** (`documentos_fiscais`, RPCs `try_nfe_lock`/`unlock_nfe`) | indireto (via repo) | não (RPC por `user_id`) | — |
| `src/app/api/dashboard/route.ts` | **sim, direto** (`categorias`) + indireto (repos) | indireto | parcial | — |
| `src/app/api/bling/webhook/route.ts` | usava `tenant` (VerifiedTenant) mesmo já tendo `organizationScope` verificado disponível | indireto (via repo) | via repo, mas com `tenant` errado | — |
| `src/app/api/bling/pedidos/[id]/route.ts` | usa `VerifiedTenant` via `OrderStore`/`OrderAccess` (abstração compartilhada, fora da fatia core) | indireto (via repo) | via repo | — |
| `src/services/sync.ts` | não | sim (`resolveScope`, e reusado incorretamente com `tenant` nos métodos internos) | via repo, mas com `tenant` errado | — |
| `database/22_migrar_catalogo_organizacao.sql` | trigger auto-fill | n/a | nullable | `OR user_id = auth.uid()` (substituída pela migration 32) |
| `database/23_migrar_comercial_estoque_fiscal.sql` | trigger auto-fill | n/a | nullable | `OR user_id = auth.uid()` (substituída pela migration 32) |
| `database/32_contrair_tenancy_legado.sql` | backfill defensivo sem quarentena/contagem | n/a | ainda nullable | **corrigida** (100% `usuario_pertence_a_organizacao`) |
| `decrement_estoque(p_user_id, p_produto_id, p_qty)` | sim (RPC por usuário) | n/a | n/a | n/a |
| `try_nfe_lock(p_user_id, p_pedido_id)` / `unlock_nfe(...)` | sim (RPC por usuário) | n/a | n/a | n/a |

## O que o ticket 08 mudou (resumo — detalhado no checkpoint e na evidência final)

1. `produtoRepository`, `clienteRepository`, `pedidoRepository`: assinatura
   trocada de `VerifiedTenant` para `VerifiedOrganizationScope`;
   `resolveTenantOrgId` removido dessas três classes.
2. Todas as rotas da fatia (`produtos/{update,delete}`, `clientes/{update,delete}`,
   `pedidos/{manual,status}`, `nfe`, `dashboard`) passaram a resolver
   `VerifiedOrganizationScope` via `resolveVerifiedOrganizationScope`
   (que usa `resolveActiveRequestOrganizationContext`), e todo filtro
   `user_id` nessas rotas virou `organizacao_id`.
3. `bling/webhook` e `bling/pedidos/[id]`: já tinham (ou passaram a ter)
   verificação de organização própria; os repositórios passaram a receber
   esse escopo verificado em vez do `tenant` primitivo.
4. Novas migrations `40` (expand: FKs compostas, tabela de quarentena,
   RPCs `baixar_estoque_organizacao`/`tentar_lock_nfe_organizacao`/
   `liberar_lock_nfe_organizacao`), `41` (backfill contabilizado e
   reexecutável) e `42` (contract: `NOT NULL` guardado por checagem em
   runtime, remoção do auto-fill silencioso nos triggers, `DROP` das RPCs
   legadas por `user_id` — confirmado sem callers).

`VerifiedTenant`/`session.tenant` permanece em uso **apenas** para
`bling.forUser(...)` (autenticação do cliente Bling por usuário — um
domínio de credencial de provedor externo, fora do escopo desta fatia).
