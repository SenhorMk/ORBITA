-- ============================================================================
-- 42_contract_organizacao_obrigatoria_catalogo_comercial.sql
-- Ticket 08 (orbita-mvp-producao-v2): fase CONTRACT.
--
-- Pre-condicao: migration 41 ja rodou o backfill contabilizado. Esta
-- migration primeiro CONFIRMA em runtime que toda linha organizacao_id nula
-- restante esta em quarentena (nunca aplica NOT NULL sobre dado nao
-- resolvido) e aborta com excecao se encontrar alguma linha fora da
-- quarentena - falha alta e visivel, nunca sucesso silencioso.
-- Em seguida remove o auto-preenchimento silencioso de organizacao_id a
-- partir de user_id nos triggers legados da migration 22/23 (a aplicacao
-- agora sempre fornece organizacao_id explicitamente via
-- VerifiedOrganizationScope) e torna a coluna NOT NULL nas sete tabelas da
-- fatia.
-- ============================================================================

do $$
declare
    v_tabela text;
    v_pendentes integer;
begin
    foreach v_tabela in array array['produtos','categorias','clientes','pedidos','itens_pedido','movimentacao_estoque','documentos_fiscais']
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
-- dual-write; manter apenas a validacao anti cross-tenant (defesa em
-- profundidade complementar as FKs compostas da migration 40).
-- ----------------------------------------------------------------------------
create or replace function public.fn_sync_catalogo_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    return new;
end;
$$;

create or replace function public.fn_sync_clientes_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    return new;
end;
$$;

create or replace function public.fn_sync_pedidos_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_rel_org_id uuid;
begin
    if new.cliente_id is not null then
        select organizacao_id into v_rel_org_id from public.clientes where id = new.cliente_id;
        if v_rel_org_id is not null and new.organizacao_id is not null and v_rel_org_id != new.organizacao_id then
            raise exception 'Cliente pertence a outra organizacao' using errcode = '23503';
        end if;
    end if;
    return new;
end;
$$;

create or replace function public.fn_sync_itens_pedido_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_rel_org_id uuid;
begin
    if new.pedido_id is not null then
        select organizacao_id into v_rel_org_id from public.pedidos where id = new.pedido_id;
        if v_rel_org_id is not null and new.organizacao_id is not null and v_rel_org_id != new.organizacao_id then
            raise exception 'Pedido pertence a outra organizacao' using errcode = '23503';
        end if;
    end if;
    if new.produto_id is not null then
        select organizacao_id into v_rel_org_id from public.produtos where id = new.produto_id;
        if v_rel_org_id is not null and new.organizacao_id is not null and v_rel_org_id != new.organizacao_id then
            raise exception 'Produto pertence a outra organizacao' using errcode = '23503';
        end if;
    end if;
    return new;
end;
$$;

create or replace function public.fn_sync_movimentacao_estoque_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_rel_org_id uuid;
begin
    if new.produto_id is not null then
        select organizacao_id into v_rel_org_id from public.produtos where id = new.produto_id;
        if v_rel_org_id is not null and new.organizacao_id is not null and v_rel_org_id != new.organizacao_id then
            raise exception 'Produto da movimentacao pertence a outra organizacao' using errcode = '23503';
        end if;
    end if;
    return new;
end;
$$;

create or replace function public.fn_sync_documentos_fiscais_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_rel_org_id uuid;
begin
    if new.pedido_id is not null then
        select organizacao_id into v_rel_org_id from public.pedidos where id = new.pedido_id;
        if v_rel_org_id is not null and new.organizacao_id is not null and v_rel_org_id != new.organizacao_id then
            raise exception 'Pedido do documento fiscal pertence a outra organizacao' using errcode = '23503';
        end if;
    end if;
    return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- NOT NULL: a coluna so pode ser referencia de tenancy a partir de agora.
-- ----------------------------------------------------------------------------
alter table public.produtos alter column organizacao_id set not null;
alter table public.categorias alter column organizacao_id set not null;
alter table public.clientes alter column organizacao_id set not null;
alter table public.pedidos alter column organizacao_id set not null;
alter table public.itens_pedido alter column organizacao_id set not null;
alter table public.movimentacao_estoque alter column organizacao_id set not null;
alter table public.documentos_fiscais alter column organizacao_id set not null;

-- ----------------------------------------------------------------------------
-- Remover RPCs legadas com escopo primitivo por user_id, confirmado sem
-- callers na aplicacao apos a migracao da jornada desta fatia para
-- VerifiedOrganizationScope (ver docs/migrations/ticket-08-ownership-inventory.md
-- e busca `rg` registrada na evidencia final do ticket 08).
-- ----------------------------------------------------------------------------
drop function if exists public.decrement_estoque(uuid, uuid, integer);
drop function if exists public.try_nfe_lock(uuid, uuid);
drop function if exists public.unlock_nfe(uuid, uuid);
