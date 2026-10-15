-- 78_movimentacao_estoque_somente_por_organizacao.sql
--
-- PRE-006A: a movimentação de estoque passa a ser isolada só pela organização,
-- como produtos, categorias, clientes, pedidos e itens.
--
-- A policy legada "Acesso a movimentacao_estoque por organizacao ou user"
-- valia para todos os papéis (USING e WITH CHECK) com
-- `membro da organização OR user_id = auth.uid()`. O ramo do `user_id` deixava
-- quem **não** é membro da organização — por exemplo, um ex-membro — ler,
-- alterar e apagar as movimentações que gravou no livro de outra organização,
-- e forjar movimentações novas nele (provado em laboratório no PRE-006A).
--
-- Grants intactos: o DML de `authenticated` nesta tabela continua concedido e
-- só sai no PRE-006D. Nenhum fluxo da aplicação usa o ramo do `user_id`: o
-- servidor grava com a service role e o navegador não escreve nesta tabela.
--
-- Forward-only. Rollback: não recriar o ramo do `user_id`; se um fluxo legítimo
-- depender dele, mover esse fluxo para um comando do servidor.

drop policy if exists "Acesso a movimentacao_estoque por organizacao ou user" on public.movimentacao_estoque;
drop policy if exists "movimentacao_estoque_org_select" on public.movimentacao_estoque;
drop policy if exists "movimentacao_estoque_org_insert" on public.movimentacao_estoque;
drop policy if exists "movimentacao_estoque_org_update" on public.movimentacao_estoque;
drop policy if exists "movimentacao_estoque_org_delete" on public.movimentacao_estoque;

create policy "movimentacao_estoque_org_select" on public.movimentacao_estoque for select to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "movimentacao_estoque_org_insert" on public.movimentacao_estoque for insert to authenticated
    with check (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "movimentacao_estoque_org_update" on public.movimentacao_estoque for update to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
    with check (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "movimentacao_estoque_org_delete" on public.movimentacao_estoque for delete to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
