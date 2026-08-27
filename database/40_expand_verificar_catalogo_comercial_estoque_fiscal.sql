-- ============================================================================
-- 40_expand_verificar_catalogo_comercial_estoque_fiscal.sql
-- Ticket 08 (orbita-mvp-producao-v2): fase EXPAND da jornada
-- produto -> pedido manual -> estoque -> documento fiscal com escopo
-- organizacional verificado, sem policy OR user_id e sem FK legada.
--
-- Esta migration NAO torna organizacao_id NOT NULL (isso ocorre na fase
-- CONTRACT, migration 42, apos o backfill contabilizado da migration 41).
-- FKs compostas em Postgres nao sao verificadas quando qualquer coluna da
-- chave e NULL (MATCH SIMPLE, o default), logo podem ser adicionadas aqui
-- com seguranca antes do backfill.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Chaves unicas (id, organizacao_id) para permitir FKs compostas por filho
-- ----------------------------------------------------------------------------
alter table public.produtos
    add constraint uq_produtos_id_org unique (id, organizacao_id);

alter table public.clientes
    add constraint uq_clientes_id_org unique (id, organizacao_id);

alter table public.pedidos
    add constraint uq_pedidos_id_org unique (id, organizacao_id);

-- ----------------------------------------------------------------------------
-- 2. organizacao_id nas tabelas ja preparadas por migrations legadas (22/23)
--    (idempotente: colunas ja existem desde a migracao 22/23)
-- ----------------------------------------------------------------------------
alter table public.produtos
    add column if not exists organizacao_id uuid references public.organizacoes(id) on delete cascade;
alter table public.clientes
    add column if not exists organizacao_id uuid references public.organizacoes(id) on delete cascade;
alter table public.pedidos
    add column if not exists organizacao_id uuid references public.organizacoes(id) on delete cascade;
alter table public.itens_pedido
    add column if not exists organizacao_id uuid references public.organizacoes(id) on delete cascade;
alter table public.movimentacao_estoque
    add column if not exists organizacao_id uuid references public.organizacoes(id) on delete cascade;
alter table public.documentos_fiscais
    add column if not exists organizacao_id uuid references public.organizacoes(id) on delete cascade;

-- ----------------------------------------------------------------------------
-- 3. FKs compostas anti cross-tenant: o filho so pode referenciar um pai da
--    MESMA organizacao. Substituem a validacao apenas-por-trigger da
--    migration 23 (que permanece como defesa em profundidade, mas nao e mais
--    a unica barreira).
-- ----------------------------------------------------------------------------
alter table public.pedidos
    drop constraint if exists fk_pedido_cliente_org;
alter table public.pedidos
    add constraint fk_pedido_cliente_org
    foreign key (cliente_id, organizacao_id) references public.clientes(id, organizacao_id);

alter table public.itens_pedido
    drop constraint if exists fk_item_pedido_org;
alter table public.itens_pedido
    add constraint fk_item_pedido_org
    foreign key (pedido_id, organizacao_id) references public.pedidos(id, organizacao_id);

alter table public.itens_pedido
    drop constraint if exists fk_item_produto_org;
alter table public.itens_pedido
    add constraint fk_item_produto_org
    foreign key (produto_id, organizacao_id) references public.produtos(id, organizacao_id);

alter table public.movimentacao_estoque
    drop constraint if exists fk_movimentacao_produto_org;
alter table public.movimentacao_estoque
    add constraint fk_movimentacao_produto_org
    foreign key (produto_id, organizacao_id) references public.produtos(id, organizacao_id);

alter table public.documentos_fiscais
    drop constraint if exists fk_documento_pedido_org;
alter table public.documentos_fiscais
    add constraint fk_documento_pedido_org
    foreign key (pedido_id, organizacao_id) references public.pedidos(id, organizacao_id);

-- ----------------------------------------------------------------------------
-- 4. Tabela de quarentena de backfill (reutilizavel pela fase BACKFILL,
--    migration 41). Nunca atribui ao "primeiro usuario": registra o motivo
--    (orfao/ambiguo) e um hash estavel do registro para auditoria.
-- ----------------------------------------------------------------------------
create table if not exists public.tenancy_backfill_quarentena (
    id                bigint generated always as identity primary key,
    tabela            text not null,
    registro_id       uuid not null,
    user_id           uuid,
    motivo            text not null check (motivo in ('orfao_sem_membership', 'ambiguo_multiplas_organizacoes')),
    referencia_hash   text not null,
    detectado_em      timestamptz not null default now(),
    resolvido_em      timestamptz,
    resolvido_por     uuid,
    constraint uq_tenancy_quarentena_registro unique (tabela, registro_id)
);

create index if not exists idx_tenancy_quarentena_tabela on public.tenancy_backfill_quarentena(tabela);

alter table public.tenancy_backfill_quarentena enable row level security;
-- Somente service_role opera quarentena; nenhum papel de aplicacao le/escreve diretamente.
revoke all on public.tenancy_backfill_quarentena from public, anon, authenticated;
grant all on public.tenancy_backfill_quarentena to service_role;
grant usage, select on sequence public.tenancy_backfill_quarentena_id_seq to service_role;

-- ----------------------------------------------------------------------------
-- 5. Relatorio contabilizado de execucoes de backfill (total = migrados + quarentena)
-- ----------------------------------------------------------------------------
create table if not exists public.tenancy_backfill_relatorio (
    id              bigint generated always as identity primary key,
    tabela          text not null,
    total           integer not null,
    migrados        integer not null,
    quarentena      integer not null,
    executado_em    timestamptz not null default now(),
    constraint chk_tenancy_relatorio_soma check (total = migrados + quarentena)
);

alter table public.tenancy_backfill_relatorio enable row level security;
revoke all on public.tenancy_backfill_relatorio from public, anon, authenticated;
grant all on public.tenancy_backfill_relatorio to service_role;
grant usage, select on sequence public.tenancy_backfill_relatorio_id_seq to service_role;

-- ----------------------------------------------------------------------------
-- 6. RPC atomica e idempotente para baixa de estoque por organizacao
--    verificada. Substitui decrement_estoque(p_user_id, ...): nunca aceita
--    organizacao/actor forjados como parametro de autoridade - o chamador
--    (aplicacao) ja verificou o VerifiedOrganizationScope antes de invocar,
--    e a funcao ainda revalida que o produto pertence a organizacao
--    informada. Nunca permite estoque negativo (falha explicita em vez de
--    GREATEST(0, ...) silencioso).
-- ----------------------------------------------------------------------------
create or replace function public.baixar_estoque_organizacao(
    p_organizacao_id uuid,
    p_produto_id uuid,
    p_qty integer
)
returns table (produto_id uuid, estoque_restante integer)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_estoque_restante integer;
begin
    if p_qty <= 0 then
        raise exception 'Quantidade deve ser maior que zero.' using errcode = '22023';
    end if;

    update public.produtos
    set estoque = estoque - p_qty
    where id = p_produto_id
      and organizacao_id = p_organizacao_id
      and estoque >= p_qty
    returning estoque into v_estoque_restante;

    if not found then
        if exists (
            select 1 from public.produtos
            where id = p_produto_id and organizacao_id = p_organizacao_id
        ) then
            raise exception 'Estoque insuficiente para o produto.' using errcode = '23514';
        end if;
        raise exception 'Produto nao encontrado para a organizacao verificada.' using errcode = 'P0002';
    end if;

    insert into public.movimentacao_estoque (organizacao_id, produto_id, tipo, origem, quantidade)
    values (p_organizacao_id, p_produto_id, 'SAIDA', 'BAIXA_ORGANIZACAO_VERIFICADA', p_qty);

    return query select p_produto_id, v_estoque_restante;
end;
$$;

revoke all on function public.baixar_estoque_organizacao(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.baixar_estoque_organizacao(uuid, uuid, integer) to service_role;

-- ----------------------------------------------------------------------------
-- 7. Lock de emissao de NF-e por organizacao verificada (substitui
--    try_nfe_lock/unlock_nfe com p_user_id).
-- ----------------------------------------------------------------------------
create or replace function public.tentar_lock_nfe_organizacao(p_organizacao_id uuid, p_pedido_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
    if not exists (
        select 1 from public.pedidos
        where id = p_pedido_id and organizacao_id = p_organizacao_id
    ) then
        return false;
    end if;

    return pg_catalog.pg_try_advisory_lock(hashtextextended(p_organizacao_id::text || ':' || p_pedido_id::text, 0));
end;
$$;

create or replace function public.liberar_lock_nfe_organizacao(p_organizacao_id uuid, p_pedido_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    perform pg_catalog.pg_advisory_unlock(hashtextextended(p_organizacao_id::text || ':' || p_pedido_id::text, 0));
end;
$$;

revoke all on function public.tentar_lock_nfe_organizacao(uuid, uuid) from public, anon, authenticated;
revoke all on function public.liberar_lock_nfe_organizacao(uuid, uuid) from public, anon, authenticated;
grant execute on function public.tentar_lock_nfe_organizacao(uuid, uuid) to service_role;
grant execute on function public.liberar_lock_nfe_organizacao(uuid, uuid) to service_role;
