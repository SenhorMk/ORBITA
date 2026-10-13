-- 75_arquivamento_de_produto.sql
--
-- PRE-003: remover um produto da venda não apaga o produto nem o histórico.
--
-- Antes desta migration a ação "excluir produto" apagava a linha: com pedido,
-- a FK `fk_item_produto` (RESTRICT) recusava DEPOIS de o produto já ter sido
-- excluído no Bling; sem pedido, `movimentacao_estoque` (CASCADE) levava junto
-- o histórico de estoque. E o item do pedido não guardava o nome: o histórico
-- dependia da linha do produto existir.
--
-- 1. Ciclo de vida explícito em `produtos`: `ativo` (vendável), `inativo`
--    (inativo no Bling) e `arquivado` (retirado da venda pelo ORBITA). Só
--    `arquivar_produto` leva a `arquivado`, e nenhuma gravação comum (a
--    sincronização, o formulário, o navegador) desfaz o arquivamento.
-- 2. O item do pedido guarda nome e código do produto no momento em que entra
--    no pedido (`produto_nome`, `produto_codigo`), e a gravação de um item já
--    existente não reescreve esse retrato.
-- 3. Um produto com pedido ou movimentação de estoque não é apagado — nem
--    por `DELETE` direto, nem pela cascata da exclusão do usuário que o criou
--    (`produtos.user_id` é `ON DELETE CASCADE`). Só a exclusão da própria
--    organização leva o catálogo junto, como antes.
--
-- Forward-only. Rollback: desligar a ação de arquivar na aplicação; nunca
-- voltar ao hard-delete.

-- ---------------------------------------------------------------------------
-- 1. Ciclo de vida do produto.
-- ---------------------------------------------------------------------------
alter table public.produtos add column if not exists situacao text not null default 'ativo';
alter table public.produtos add column if not exists arquivado_em timestamptz;
alter table public.produtos add column if not exists arquivado_por uuid;

alter table public.produtos drop constraint if exists chk_produto_situacao;
alter table public.produtos
    add constraint chk_produto_situacao check (situacao in ('ativo', 'inativo', 'arquivado'));

alter table public.produtos drop constraint if exists chk_produto_arquivado_tem_data;
alter table public.produtos
    add constraint chk_produto_arquivado_tem_data check ((situacao = 'arquivado') = (arquivado_em is not null));

comment on column public.produtos.situacao is
    'ativo: vendável. inativo: inativo no Bling. arquivado: retirado da venda pelo ORBITA (arquivar_produto); continua no histórico.';

create index if not exists idx_produtos_org_situacao on public.produtos (organizacao_id, situacao);

-- O arquivamento é a única porta para `arquivado`, e não tem volta por
-- gravação comum: a sincronização e o formulário continuam atualizando preço,
-- estoque e nome, mas a situação de um arquivado fica.
create or replace function public.fn_produto_ciclo_de_vida()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if tg_op = 'INSERT' then
        if new.situacao = 'arquivado' then
            raise exception 'Produto nasce ativo ou inativo; arquivar e pelo comando de arquivamento.'
                using errcode = '23514';
        end if;
        return new;
    end if;

    if old.situacao = 'arquivado' then
        new.situacao := 'arquivado';
        new.arquivado_em := old.arquivado_em;
        new.arquivado_por := old.arquivado_por;
        return new;
    end if;

    if new.situacao = 'arquivado'
       and coalesce(current_setting('orbita.arquivamento_de_produto', true), '') is distinct from old.id::text then
        raise exception 'Arquivar produto e so pelo comando de arquivamento.' using errcode = '23514';
    end if;
    return new;
end;
$$;

revoke all on function public.fn_produto_ciclo_de_vida() from public, anon, authenticated;

drop trigger if exists tg_produto_ciclo_de_vida on public.produtos;
create trigger tg_produto_ciclo_de_vida
    before insert or update on public.produtos
    for each row execute function public.fn_produto_ciclo_de_vida();

-- ---------------------------------------------------------------------------
-- 2. O item guarda o retrato do produto.
-- ---------------------------------------------------------------------------
alter table public.itens_pedido add column if not exists produto_nome text;
alter table public.itens_pedido add column if not exists produto_codigo text;

-- O retrato dos itens que já existem é o produto de hoje: é o melhor que o
-- banco sabe, e a linha do produto continua existindo.
update public.itens_pedido i
   set produto_nome = p.nome, produto_codigo = p.codigo
  from public.produtos p
 where p.id = i.produto_id
   and i.produto_nome is null;

alter table public.itens_pedido alter column produto_nome set not null;

comment on column public.itens_pedido.produto_nome is
    'Nome do produto quando o item entrou no pedido. Não muda com o cadastro nem com o arquivamento.';

-- O retrato vem SEMPRE do produto, nunca do chamador; e um item que já existe
-- só ganha retrato novo se trocar de produto.
create or replace function public.fn_item_pedido_retrato_do_produto()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if tg_op = 'UPDATE' and new.produto_id = old.produto_id and old.produto_nome is not null then
        new.produto_nome := old.produto_nome;
        new.produto_codigo := old.produto_codigo;
        return new;
    end if;
    -- Produto inexistente: deixa para `tg_validar_estoque_disponivel` recusar
    -- com a mensagem de sempre.
    select p.nome, p.codigo into new.produto_nome, new.produto_codigo
      from public.produtos p
     where p.id = new.produto_id;
    return new;
end;
$$;

revoke all on function public.fn_item_pedido_retrato_do_produto() from public, anon, authenticated;

drop trigger if exists tg_item_pedido_retrato_do_produto on public.itens_pedido;
create trigger tg_item_pedido_retrato_do_produto
    before insert or update on public.itens_pedido
    for each row execute function public.fn_item_pedido_retrato_do_produto();

-- ---------------------------------------------------------------------------
-- 3. Produto com histórico não é apagado.
--
-- A única exclusão que leva um produto com histórico é a da própria
-- organização: na cascata dela, a linha da organização já não existe quando
-- este gatilho roda. Qualquer outra — o DELETE direto, ou a cascata de
-- `auth.users` quando o usuário que criou o produto é excluído — encontra a
-- organização viva e é recusada se houver pedido ou movimentação. Remover um
-- membro da organização não exclui o usuário e não toca nos produtos.
-- ---------------------------------------------------------------------------
create or replace function public.fn_produto_com_historico_nao_e_excluido()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if exists (select 1 from public.organizacoes o where o.id = old.organizacao_id)
       and (exists (select 1 from public.itens_pedido i where i.produto_id = old.id)
            or exists (select 1 from public.movimentacao_estoque m where m.produto_id = old.id)) then
        raise exception 'Produto com pedido ou movimentacao de estoque nao e excluido; arquive-o.'
            using errcode = '23503';
    end if;
    return old;
end;
$$;

revoke all on function public.fn_produto_com_historico_nao_e_excluido() from public, anon, authenticated;

drop trigger if exists tg_produto_com_historico_nao_e_excluido on public.produtos;
create trigger tg_produto_com_historico_nao_e_excluido
    before delete on public.produtos
    for each row execute function public.fn_produto_com_historico_nao_e_excluido();

-- ---------------------------------------------------------------------------
-- 4. O comando de arquivamento.
--
-- Trava a linha, decide contra o estado já gravado e é idempotente: arquivar
-- de novo responde `ja_arquivado` sem mudar nada. Não mexe em estoque nem em
-- reserva. A permissão para `arquivado` vale só para este produto, nesta
-- transação.
-- ---------------------------------------------------------------------------
create or replace function public.arquivar_produto(
    p_organizacao_id uuid,
    p_produto_id uuid,
    p_ator_id uuid
)
returns table (desfecho text, situacao_anterior text, arquivado_em timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_situacao text;
    v_arquivado_em timestamptz;
begin
    if p_organizacao_id is null or p_produto_id is null or p_ator_id is null then
        raise exception 'Organizacao, produto e ator sao obrigatorios.' using errcode = '22023';
    end if;

    select p.situacao, p.arquivado_em into v_situacao, v_arquivado_em
      from public.produtos p
     where p.id = p_produto_id and p.organizacao_id = p_organizacao_id
       for update;
    if not found then
        raise exception 'Produto nao encontrado nesta organizacao.' using errcode = 'P0002';
    end if;

    if v_situacao = 'arquivado' then
        return query select 'ja_arquivado'::text, v_situacao, v_arquivado_em;
        return;
    end if;

    perform set_config('orbita.arquivamento_de_produto', p_produto_id::text, true);
    update public.produtos p
       set situacao = 'arquivado', arquivado_em = now(), arquivado_por = p_ator_id
     where p.id = p_produto_id and p.organizacao_id = p_organizacao_id
    returning p.arquivado_em into v_arquivado_em;
    perform set_config('orbita.arquivamento_de_produto', '', true);

    return query select 'arquivado'::text, v_situacao, v_arquivado_em;
end;
$$;

revoke all on function public.arquivar_produto(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.arquivar_produto(uuid, uuid, uuid) to service_role;
