-- 65_checkpoint_de_sync_por_organizacao.sql
-- Forward-only.
--
-- ---------------------------------------------------------------------------
-- INVARIANTE
-- ---------------------------------------------------------------------------
-- O checkpoint de sincronização é identificado por `(organizacao_id, entidade)`.
-- `user_id` é o ator que gravou — dado de auditoria, nunca chave de tenancy.
--
-- Enquanto a chave primária foi `(user_id, entidade)`, as duas coisas estavam
-- trocadas: o mesmo ator sincronizando a MESMA entidade em duas organizações
-- colidia na primária e a segunda organização não conseguia ter checkpoint
-- próprio. A migration 32 acrescentou `organizacao_id` e a 55 tornou
-- `(organizacao_id, entidade)` um índice único total e inferível, mas a
-- primária histórica continuou de pé ao lado — e é ela que decide.
--
-- `organizacao_id` passa a ser `NOT NULL` porque a política de RLS
-- (`sync_state_org_all`) já exige `organizacao_id is not null` para liberar a
-- linha: uma linha sem organização não é visível a ninguém e não pertence a
-- tenant nenhum.
--
-- REINTRODUZIR O DEFEITO: devolva a primária para `(user_id, entidade)`. O
-- pgTAP `checkpoint_de_sync_por_organizacao.test.sql` falha no caso em que o
-- mesmo ator tem checkpoint da mesma entidade em duas organizações.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Nenhuma linha órfã pode sobreviver à contração.
-- ---------------------------------------------------------------------------
-- Falha alto em vez de apagar: uma linha sem organização é um checkpoint que
-- ninguém sabe de quem é, e escolher um dono por conta própria seria inventar
-- tenancy.
do $$
declare
    v_orfas integer;
begin
    select count(*) into v_orfas from public.sync_state where organizacao_id is null;
    if v_orfas > 0 then
        raise exception
            'sync_state tem % linha(s) sem organizacao_id; atribua a organização de cada checkpoint antes de aplicar esta migration.',
            v_orfas;
    end if;
end $$;

alter table public.sync_state
    alter column organizacao_id set not null;

-- ---------------------------------------------------------------------------
-- 2. A primária passa a ser a chave de tenancy.
-- ---------------------------------------------------------------------------
-- Promove o índice único que a migration 55 já criou, em vez de criar um
-- segundo índice idêntico sobre as mesmas colunas.
do $$
declare
    v_pk_nome text;
    v_pk_def  text;
begin
    select conname, pg_get_constraintdef(oid)
      into v_pk_nome, v_pk_def
      from pg_constraint
     where conrelid = 'public.sync_state'::regclass and contype = 'p';

    if v_pk_def = 'PRIMARY KEY (organizacao_id, entidade)' then
        return;
    end if;

    if v_pk_nome is not null then
        execute format('alter table public.sync_state drop constraint %I', v_pk_nome);
    end if;

    if exists (
        select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relname = 'uq_sync_state_org_entidade' and c.relkind = 'i' and n.nspname = 'public'
    ) then
        alter table public.sync_state
            add constraint sync_state_pkey primary key using index uq_sync_state_org_entidade;
    else
        alter table public.sync_state
            add constraint sync_state_pkey primary key (organizacao_id, entidade);
    end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. O ator continua obrigatório, e continua sendo só o ator.
-- ---------------------------------------------------------------------------
comment on column public.sync_state.user_id is
    'Ator que gravou este checkpoint. Auditoria — NUNCA chave de tenancy: a identidade do checkpoint é (organizacao_id, entidade).';
comment on column public.sync_state.organizacao_id is
    'Tenant do checkpoint. Junto com `entidade`, forma a chave primária.';
