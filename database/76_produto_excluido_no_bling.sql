-- 76_produto_excluido_no_bling.sql
--
-- PRE-004: `product.deleted` do Bling vira tombstone, nunca exclusão física.
--
-- Antes desta migration o webhook tratava `product.deleted` como qualquer
-- evento de produto: pedia o detalhe ao Bling e fazia upsert. Um produto já
-- excluído lá era regravado aqui como se existisse, e um `product.updated`
-- atrasado recriava um produto que o Bling já tinha excluído.
--
-- 1. `produtos_excluidos_no_bling`: a ausência remota por (organização,
--    `bling_id`), registrada mesmo quando o ORBITA nunca teve o produto. Só
--    insere; não se apaga nem se reescreve.
-- 2. `registrar_exclusao_de_produto_no_bling`: grava a tombstone e arquiva o
--    produto local (migration 75), sem apagar cadastro, foto, itens de pedido
--    nem movimentação. Idempotente: a reentrega responde `ja_registrado`.
-- 3. Nenhuma gravação cria — ou passa a apontar para — um produto com
--    `bling_id` excluído no Bling: é assim que um update atrasado não ressuscita
--    o produto. A tombstone e a gravação se serializam por uma trava consultiva
--    do mesmo (organização, `bling_id`).
--
-- Forward-only. Rollback: quarentenar `product.deleted` no webhook e
-- reprocessar depois; nunca redirecionar para o upsert.

create table if not exists public.produtos_excluidos_no_bling (
    organizacao_id       uuid not null references public.organizacoes(id) on delete cascade,
    bling_id             text not null check (bling_id ~ '^[1-9][0-9]*$'),
    -- O produto local arquivado pela exclusão, quando existia.
    produto_id           uuid references public.produtos(id) on delete set null,
    -- A data do evento no Bling, quando veio; o registro local é `registrado_em`.
    excluido_no_bling_em timestamptz,
    registrado_em        timestamptz not null default now(),
    constraint pk_produtos_excluidos_no_bling primary key (organizacao_id, bling_id)
);

comment on table public.produtos_excluidos_no_bling is
    'Tombstone de produto excluído no Bling (PRE-004). Só insere: um update atrasado não recria o produto.';

revoke all on public.produtos_excluidos_no_bling from public, anon, authenticated;
grant select, insert on public.produtos_excluidos_no_bling to service_role;
alter table public.produtos_excluidos_no_bling enable row level security;

create or replace function public.fn_tombstone_de_produto_imutavel()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    -- A exclusão em cascata da organização segue (a linha dela já não existe).
    if tg_op = 'DELETE' and not exists (select 1 from public.organizacoes o where o.id = old.organizacao_id) then
        return old;
    end if;
    -- `produto_id` só perde o vínculo pela própria FK (on delete set null).
    if tg_op = 'UPDATE' and new.organizacao_id = old.organizacao_id and new.bling_id = old.bling_id
       and new.excluido_no_bling_em is not distinct from old.excluido_no_bling_em
       and new.registrado_em = old.registrado_em and new.produto_id is null then
        return new;
    end if;
    raise exception 'A exclusao de um produto no Bling e registro permanente.' using errcode = '23514';
end;
$$;

revoke all on function public.fn_tombstone_de_produto_imutavel() from public, anon, authenticated;

drop trigger if exists tg_tombstone_de_produto_imutavel on public.produtos_excluidos_no_bling;
create trigger tg_tombstone_de_produto_imutavel
    before update or delete on public.produtos_excluidos_no_bling
    for each row execute function public.fn_tombstone_de_produto_imutavel();

-- A trava consultiva do (organização, `bling_id`) que a tombstone e a gravação
-- de produto compartilham.
create or replace function public.fn_travar_bling_id_de_produto(p_organizacao_id uuid, p_bling_id text)
returns void
language sql
set search_path = ''
as $$
    select pg_advisory_xact_lock(hashtextextended(p_organizacao_id::text || ':produto-bling:' || p_bling_id, 0));
$$;

revoke all on function public.fn_travar_bling_id_de_produto(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Nenhuma gravação cria um produto excluído no Bling.
--
-- Vale para o INSERT (inclusive o `insert ... on conflict do update` do
-- espelho, cujo BEFORE INSERT roda antes da resolução do conflito) e para o
-- UPDATE que troca o `bling_id`. A trava serializa com o registro da
-- tombstone: das duas ordens, a tombstone sempre vence.
-- ---------------------------------------------------------------------------
create or replace function public.fn_produto_excluido_no_bling_nao_volta()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if new.bling_id is null or new.bling_id !~ '^[1-9][0-9]*$' then
        return new;
    end if;
    if tg_op = 'UPDATE' and new.bling_id = old.bling_id then
        return new;
    end if;
    perform public.fn_travar_bling_id_de_produto(new.organizacao_id, new.bling_id);
    if exists (select 1 from public.produtos_excluidos_no_bling e
                where e.organizacao_id = new.organizacao_id and e.bling_id = new.bling_id) then
        raise exception 'Produto % foi excluido no Bling; nao volta ao catalogo.', new.bling_id using errcode = '23514';
    end if;
    return new;
end;
$$;

revoke all on function public.fn_produto_excluido_no_bling_nao_volta() from public, anon, authenticated;

drop trigger if exists tg_produto_excluido_no_bling_nao_volta on public.produtos;
create trigger tg_produto_excluido_no_bling_nao_volta
    before insert or update of bling_id on public.produtos
    for each row execute function public.fn_produto_excluido_no_bling_nao_volta();

-- ---------------------------------------------------------------------------
-- O comando do webhook.
--
-- desfecho: `registrado` (tinha o produto, agora arquivado), `registrado_sem_produto`
-- (o ORBITA nunca o teve; a tombstone impede que ele apareça depois) ou
-- `ja_registrado` (reentrega: nada muda).
-- ---------------------------------------------------------------------------
create or replace function public.registrar_exclusao_de_produto_no_bling(
    p_organizacao_id uuid,
    p_bling_id text,
    p_excluido_no_bling_em timestamptz default null
)
returns table (desfecho text, produto_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_produto_id uuid;
    v_situacao text;
    v_existente uuid;
begin
    if p_organizacao_id is null or p_bling_id is null or p_bling_id !~ '^[1-9][0-9]*$' then
        raise exception 'Organizacao e id numerico do Bling sao obrigatorios.' using errcode = '22023';
    end if;

    perform public.fn_travar_bling_id_de_produto(p_organizacao_id, p_bling_id);

    select e.produto_id into v_existente
      from public.produtos_excluidos_no_bling e
     where e.organizacao_id = p_organizacao_id and e.bling_id = p_bling_id;
    if found then
        return query select 'ja_registrado'::text, v_existente;
        return;
    end if;

    select p.id, p.situacao into v_produto_id, v_situacao
      from public.produtos p
     where p.organizacao_id = p_organizacao_id and p.bling_id = p_bling_id
       for update;

    insert into public.produtos_excluidos_no_bling (organizacao_id, bling_id, produto_id, excluido_no_bling_em)
    values (p_organizacao_id, p_bling_id, v_produto_id, p_excluido_no_bling_em);

    if v_produto_id is null then
        return query select 'registrado_sem_produto'::text, null::uuid;
        return;
    end if;

    if v_situacao <> 'arquivado' then
        perform set_config('orbita.arquivamento_de_produto', v_produto_id::text, true);
        update public.produtos p
           set situacao = 'arquivado', arquivado_em = now(), arquivado_por = null
         where p.id = v_produto_id;
        perform set_config('orbita.arquivamento_de_produto', '', true);
    end if;

    return query select 'registrado'::text, v_produto_id;
end;
$$;

revoke all on function public.registrar_exclusao_de_produto_no_bling(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.registrar_exclusao_de_produto_no_bling(uuid, text, timestamptz) to service_role;
