-- ============================================================================
-- 45_contract_organizacao_obrigatoria_financeiro.sql
-- Ticket 09 (orbita-mvp-producao-v2): fase CONTRACT.
--
-- Pre-condicao: migration 44 ja rodou o backfill contabilizado. Esta
-- migration primeiro CONFIRMA em runtime que toda linha organizacao_id nula
-- restante esta em quarentena (nunca aplica NOT NULL sobre dado nao
-- resolvido) e aborta com excecao se encontrar alguma linha fora da
-- quarentena - falha alta e visivel, nunca sucesso silencioso.
--
-- Em seguida:
--  1. remove o auto-preenchimento silencioso de organizacao_id a partir de
--     user_id nos triggers da migration 24 (a aplicacao agora sempre fornece
--     organizacao_id explicitamente via VerifiedOrganizationScope);
--  2. torna a coluna organizacao_id NOT NULL nas 4 tabelas da fatia;
--  3. canonicaliza a RLS de contas_financeiras/fornecedores removendo o
--     fallback `OR user_id = auth.uid()` (titulos_financeiros/
--     categorias_financeiras ja estavam canonicas desde a migration 32);
--  4. remove os indices unicos legados por user_id da migration 13, agora
--     substituidos integralmente pelos indices por organizacao_id da
--     migration 24.
-- ============================================================================

do $$
declare
    v_tabela text;
    v_pendentes integer;
begin
    foreach v_tabela in array array['contas_financeiras','categorias_financeiras','fornecedores','titulos_financeiros']
    loop
        execute format(
            'select count(*) from public.%I t where t.organizacao_id is null and not exists (select 1 from public.tenancy_backfill_quarentena q where q.tabela = %L and q.registro_id = t.id)',
            v_tabela, v_tabela
        ) into v_pendentes;

        if v_pendentes > 0 then
            raise exception 'Contract abortado: % linha(s) em % com organizacao_id nulo fora da quarentena de backfill.', v_pendentes, v_tabela
                using errcode = '55000';
        end if;
    end loop;
end;
$$;

-- ----------------------------------------------------------------------------
-- Remover auto-preenchimento silencioso de organizacao_id nos triggers de
-- dual-write; manter apenas a validacao anti cross-tenant em
-- titulos_financeiros (defesa em profundidade complementar as FKs compostas
-- da migration 43).
-- ----------------------------------------------------------------------------
create or replace function public.fn_sync_contas_financeiras_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    return new;
end;
$$;

create or replace function public.fn_sync_categorias_financeiras_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    return new;
end;
$$;

create or replace function public.fn_sync_fornecedores_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    return new;
end;
$$;

create or replace function public.fn_sync_titulos_financeiros_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_rel_org_id uuid;
begin
    if new.categoria_id is not null then
        select organizacao_id into v_rel_org_id from public.categorias_financeiras where id = new.categoria_id;
        if v_rel_org_id is not null and new.organizacao_id is not null and v_rel_org_id != new.organizacao_id then
            raise exception 'Categoria financeira pertence a outra organizacao' using errcode = '23503';
        end if;
    end if;

    if new.conta_financeira_id is not null then
        select organizacao_id into v_rel_org_id from public.contas_financeiras where id = new.conta_financeira_id;
        if v_rel_org_id is not null and new.organizacao_id is not null and v_rel_org_id != new.organizacao_id then
            raise exception 'Conta financeira pertence a outra organizacao' using errcode = '23503';
        end if;
    end if;

    if new.fornecedor_id is not null then
        select organizacao_id into v_rel_org_id from public.fornecedores where id = new.fornecedor_id;
        if v_rel_org_id is not null and new.organizacao_id is not null and v_rel_org_id != new.organizacao_id then
            raise exception 'Fornecedor pertence a outra organizacao' using errcode = '23503';
        end if;
    end if;

    return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- NOT NULL: a coluna so pode ser referencia de tenancy a partir de agora.
-- ----------------------------------------------------------------------------
alter table public.contas_financeiras alter column organizacao_id set not null;
alter table public.categorias_financeiras alter column organizacao_id set not null;
alter table public.fornecedores alter column organizacao_id set not null;
alter table public.titulos_financeiros alter column organizacao_id set not null;

-- ----------------------------------------------------------------------------
-- RLS canonica para contas_financeiras/fornecedores: remove o fallback
-- `OR user_id = auth.uid()` que ainda permitia acesso a linhas sem
-- organizacao_id resolvida para usuarios sem nenhuma membership de
-- organizacao. titulos_financeiros/categorias_financeiras ja estavam
-- canonicas desde a migration 32 e sao recriadas aqui apenas para manter as
-- 4 tabelas da fatia com o mesmo padrao explicito por operacao.
-- ----------------------------------------------------------------------------
drop policy if exists "Acesso a contas_financeiras por organizacao ou user" on public.contas_financeiras;
drop policy if exists "contas_financeiras_org_select" on public.contas_financeiras;
drop policy if exists "contas_financeiras_org_insert" on public.contas_financeiras;
drop policy if exists "contas_financeiras_org_update" on public.contas_financeiras;
drop policy if exists "contas_financeiras_org_delete" on public.contas_financeiras;

create policy "contas_financeiras_org_select" on public.contas_financeiras for select to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id));
create policy "contas_financeiras_org_insert" on public.contas_financeiras for insert to authenticated
    with check (public.usuario_pertence_a_organizacao(organizacao_id));
create policy "contas_financeiras_org_update" on public.contas_financeiras for update to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id))
    with check (public.usuario_pertence_a_organizacao(organizacao_id));
create policy "contas_financeiras_org_delete" on public.contas_financeiras for delete to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id));

drop policy if exists "Acesso a fornecedores por organizacao ou user" on public.fornecedores;
drop policy if exists "fornecedores_org_select" on public.fornecedores;
drop policy if exists "fornecedores_org_insert" on public.fornecedores;
drop policy if exists "fornecedores_org_update" on public.fornecedores;
drop policy if exists "fornecedores_org_delete" on public.fornecedores;

create policy "fornecedores_org_select" on public.fornecedores for select to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id));
create policy "fornecedores_org_insert" on public.fornecedores for insert to authenticated
    with check (public.usuario_pertence_a_organizacao(organizacao_id));
create policy "fornecedores_org_update" on public.fornecedores for update to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id))
    with check (public.usuario_pertence_a_organizacao(organizacao_id));
create policy "fornecedores_org_delete" on public.fornecedores for delete to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id));

drop policy if exists "Acesso a titulos_financeiros por organizacao ou user" on public.titulos_financeiros;
drop policy if exists "titulos_org_select" on public.titulos_financeiros;
drop policy if exists "titulos_org_insert" on public.titulos_financeiros;
drop policy if exists "titulos_org_update" on public.titulos_financeiros;
drop policy if exists "titulos_org_delete" on public.titulos_financeiros;

create policy "titulos_org_select" on public.titulos_financeiros for select to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id));
create policy "titulos_org_insert" on public.titulos_financeiros for insert to authenticated
    with check (public.usuario_pertence_a_organizacao(organizacao_id));
create policy "titulos_org_update" on public.titulos_financeiros for update to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id))
    with check (public.usuario_pertence_a_organizacao(organizacao_id));
create policy "titulos_org_delete" on public.titulos_financeiros for delete to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id));

drop policy if exists "Acesso a categorias_financeiras por organizacao ou user" on public.categorias_financeiras;
drop policy if exists "categorias_fin_org_select" on public.categorias_financeiras;
drop policy if exists "categorias_fin_org_insert" on public.categorias_financeiras;
drop policy if exists "categorias_fin_org_update" on public.categorias_financeiras;
drop policy if exists "categorias_fin_org_delete" on public.categorias_financeiras;

create policy "categorias_fin_org_select" on public.categorias_financeiras for select to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id));
create policy "categorias_fin_org_insert" on public.categorias_financeiras for insert to authenticated
    with check (public.usuario_pertence_a_organizacao(organizacao_id));
create policy "categorias_fin_org_update" on public.categorias_financeiras for update to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id))
    with check (public.usuario_pertence_a_organizacao(organizacao_id));
create policy "categorias_fin_org_delete" on public.categorias_financeiras for delete to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id));

-- ----------------------------------------------------------------------------
-- Remover indices unicos legados por user_id (migration 13), agora que
-- organizacao_id e obrigatorio e os indices unicos por organizacao (migration
-- 24) sao a unica fonte de verdade para idempotencia de bling_id.
-- ----------------------------------------------------------------------------
drop index if exists public.uq_idx_categorias_financeiras_tenant_bling;
drop index if exists public.uq_idx_titulos_financeiros_tenant_bling;
drop index if exists public.uq_idx_contas_financeiras_tenant_bling;
drop index if exists public.uq_idx_fornecedores_tenant_bling;
