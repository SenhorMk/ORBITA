-- 85_identidade_local_chatwoot.sql
-- Forward-only. MSG-002 (expand): os espelhos do Chatwoot ganham um UUID local
-- estável e uma identidade remota presa à organização e à conexão, sem remover
-- nenhuma chave ou caminho legado.
--
-- ESTADO ANTERIOR (medido no laboratório com a cadeia canônica 01-84):
--   - `chatwoot_contacts`, `chatwoot_conversations` e `chatwoot_messages` usam o
--     id numérico do Chatwoot como PRIMARY KEY global (`id int`), e as FKs
--     legadas (`contact_id`, `conversation_id`) apontam para esse id. Duas
--     instalações do Chatwoot numeram a partir de 1, então o id 5 de uma colide
--     com o id 5 de outra.
--   - O webhook grava com `upsert` pela PK e sempre informa `organizacao_id` e
--     `conexao_id`. O sync manual (`/api/chatwoot/sync`) informa a organização,
--     mas nunca a conexão: as linhas que ele cria ficam com `conexao_id` nulo.
--   - Nada impede o `upsert` de uma organização B com o id 5 de reescrever a
--     linha 5 da organização A, inclusive o `organizacao_id`: o gatilho da
--     migration 27 só preenche a organização quando ela vem nula, e o
--     `service_role` ignora a RLS. É o vazamento entre tenants que este ticket
--     fecha no caminho legado.
--
-- O QUE MUDA:
--   1. Colunas novas: `id_local uuid` (UUID local, nasce uma vez e não muda) e
--      `id_externo text` (o id do Chatwoot como texto) nas três tabelas;
--      `contato_id_local` na conversa e `conversa_id_local` na mensagem, com FK
--      composta `(organizacao_id, *_id_local)`. Um vínculo local nunca atravessa
--      organizações.
--   2. Identidade remota única por `(organizacao_id, conexao_id, id_externo)`.
--      Enquanto a PK legada existir, `id_externo = id::text` (CHECK).
--   3. Um gatilho mantém as colunas novas a partir das escritas legadas: o
--      código atual continua gravando só as colunas antigas. Ele também:
--        - infere a conexão quando ela vem nula, só por prova: conversa pelo
--          mapeamento de inbox da organização (ou pelo contato), mensagem pela
--          conversa, contato pela conexão única das suas conversas;
--        - recusa trocar a conexão de uma linha de uma instalação para outra e
--          recusa conexão que não seja Chatwoot da mesma organização;
--        - recusa um vínculo novo com pai de outra conexão (`23503`). Num
--          backfill, o mesmo caso não aborta: a linha fica em quarentena.
--      Uma escrita que só completa a identidade preserva `updated_at`: o
--      backfill não reinicia o relógio de retenção nem reordena a caixa.
--   4. A organização de contato, conversa e mensagem não muda depois de
--      definida (`fn_organizacao_da_integracao_imutavel`, migration 84). O
--      `upsert` da organização B no id 5 da organização A passa a falhar com
--      `23514`, em vez de mover a linha.
--   5. `backfill_identidade_local_chatwoot(lote)` preenche em lotes
--      idempotentes e retomáveis, sob advisory lock. Esta migration o roda até
--      o fim. Linha sem prova de conexão ou com pai divergente fica legível e
--      aparece em `chatwoot_identidade_em_quarentena`; nada é adivinhado.
--
-- O QUE NÃO MUDA (contração é do MSG-004; os callers migram no MSG-003A):
--   - PKs, FKs e índices legados, as policies de leitura por membership e o
--     contrato das rotas. O navegador continua só lendo (medido: nenhum grant
--     de escrita em `authenticated`/`anon`; a autoverificação confere).
--   - Nenhum conteúdo, organização, `user_id` ou `updated_at` existente muda.
--     Só `conexao_id` passa de nulo a uma conexão provada.
--
-- RECUPERAÇÃO: forward-only. Se a escrita legada quebrar, a linha recusada era
-- uma colisão entre instalações ou organizações e o erro é o comportamento
-- correto. Desfazer o gatilho reabre o vazamento: não se faz. Ver
-- docs/operations/msg-002-runbook.md.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Preflight: um espelho que já aponta para conexão de outra organização ou de
-- outro provedor é corrupção, não ambiguidade. Aborta sem corrigir nada.
-- ---------------------------------------------------------------------------
do $$
declare
    v_violacoes integer;
begin
    select count(*) into v_violacoes
      from (select organizacao_id, conexao_id from public.chatwoot_contacts
            union all
            select organizacao_id, conexao_id from public.chatwoot_conversations
            union all
            select organizacao_id, conexao_id from public.chatwoot_messages) e
      left join public.conexoes_integracao c on c.id = e.conexao_id
     where e.conexao_id is not null
       and (c.id is null or c.provedor <> 'chatwoot' or c.organizacao_id is distinct from e.organizacao_id);
    if v_violacoes > 0 then
        raise exception 'MSG-002: % linha(s) de espelho Chatwoot apontam para conexao de outra organizacao ou provedor; quarentena manual antes desta migration', v_violacoes;
    end if;
end;
$$;

-- Retrato do legado, comparado no fim: mesmas linhas, mesmo conteúdo, mesmo
-- `updated_at`. `conexao_id` fica de fora porque pode passar de nulo a provado.
create temp table msg002_retrato_legado on commit drop as
select 'chatwoot_contacts'::text as tabela, count(*) as linhas,
       md5(coalesce(string_agg(row(c.id, c.user_id, c.organizacao_id, c.name, c.email, c.phone_number,
                                   c.phone_normalizado, c.avatar_url, c.created_at, c.updated_at)::text, '|' order by c.id), '')) as digest
  from public.chatwoot_contacts c
union all
select 'chatwoot_conversations', count(*),
       md5(coalesce(string_agg(row(v.id, v.user_id, v.organizacao_id, v.display_id, v.contact_id, v.status,
                                   v.inbox_id, v.channel, v.created_at, v.updated_at)::text, '|' order by v.id), ''))
  from public.chatwoot_conversations v
union all
select 'chatwoot_messages', count(*),
       md5(coalesce(string_agg(row(m.id, m.user_id, m.organizacao_id, m.conversation_id, m.content, m.message_type,
                                   m.sender_name, m.sender_id, m.sender_type, m.created_at, m.updated_at)::text, '|' order by m.id), ''))
  from public.chatwoot_messages m;

-- ---------------------------------------------------------------------------
-- Expand: colunas anuláveis e sem default (não reescreve a tabela). O default
-- vale só para linhas novas; as existentes vêm do backfill em lotes.
-- ---------------------------------------------------------------------------
alter table public.chatwoot_contacts
    add column id_local uuid,
    add column id_externo text;
alter table public.chatwoot_conversations
    add column id_local uuid,
    add column id_externo text,
    add column contato_id_local uuid;
alter table public.chatwoot_messages
    add column id_local uuid,
    add column id_externo text,
    add column conversa_id_local uuid;

alter table public.chatwoot_contacts alter column id_local set default gen_random_uuid();
alter table public.chatwoot_conversations alter column id_local set default gen_random_uuid();
alter table public.chatwoot_messages alter column id_local set default gen_random_uuid();

comment on column public.chatwoot_contacts.id_local is
    'MSG-002: UUID local estavel do contato. Nunca muda; e a referencia que o MSG-003A passa a usar.';
comment on column public.chatwoot_contacts.id_externo is
    'MSG-002: id do Chatwoot como texto. Unico por (organizacao_id, conexao_id); igual a id::text ate o MSG-004.';
comment on column public.chatwoot_conversations.contato_id_local is
    'MSG-002: contato local da conversa, na mesma organizacao (FK composta) e na mesma conexao (gatilho).';
comment on column public.chatwoot_messages.conversa_id_local is
    'MSG-002: conversa local da mensagem, na mesma organizacao (FK composta) e na mesma conexao (gatilho).';

-- ---------------------------------------------------------------------------
-- Prova de conexão. Cada função devolve uma conexão só quando a prova é única;
-- caso contrário, nulo (quarentena).
-- ---------------------------------------------------------------------------

-- Contato: a conexão única entre as suas conversas, gravada na conversa ou dada
-- pelo mapeamento de inbox da organização.
create function public.chatwoot_conexao_do_contato(p_organizacao_id uuid, p_contact_id integer)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
    select case when count(distinct x.conexao_id) = 1 then (array_agg(x.conexao_id))[1] end
      from (select coalesce(v.conexao_id, i.conexao_id) as conexao_id
              from public.chatwoot_conversations v
              left join public.chatwoot_inboxes i
                on i.organizacao_id = v.organizacao_id and i.inbox_id = v.inbox_id
             where v.contact_id = p_contact_id
               and v.organizacao_id = p_organizacao_id) x
     where x.conexao_id is not null;
$$;

-- Conversa: o mapeamento de inbox da organização; sem ele, a conexão do contato.
create function public.chatwoot_conexao_da_conversa(p_organizacao_id uuid, p_inbox_id integer, p_contact_id integer)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
    select coalesce(
        (select i.conexao_id from public.chatwoot_inboxes i
          where i.organizacao_id = p_organizacao_id and i.inbox_id = p_inbox_id),
        (select c.conexao_id from public.chatwoot_contacts c
          where c.id = p_contact_id and c.organizacao_id = p_organizacao_id));
$$;

-- Mensagem: a conexão da conversa.
create function public.chatwoot_conexao_da_mensagem(p_organizacao_id uuid, p_conversation_id integer)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
    select v.conexao_id from public.chatwoot_conversations v
     where v.id = p_conversation_id and v.organizacao_id = p_organizacao_id;
$$;

-- Vínculo local: o pai com aquele id remoto, na mesma organização e na mesma
-- conexão (ou ainda sem conexão provada). Mais de um candidato é ambiguidade:
-- nulo, nunca um palpite.
create function public.chatwoot_contato_local(p_organizacao_id uuid, p_conexao_id uuid, p_contact_id integer)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
    select case when count(*) = 1 then (array_agg(c.id_local))[1] end
      from public.chatwoot_contacts c
     where c.id = p_contact_id
       and c.organizacao_id = p_organizacao_id
       and (p_conexao_id is null or c.conexao_id is null or c.conexao_id = p_conexao_id);
$$;

create function public.chatwoot_conversa_local(p_organizacao_id uuid, p_conexao_id uuid, p_conversation_id integer)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
    select case when count(*) = 1 then (array_agg(v.id_local))[1] end
      from public.chatwoot_conversations v
     where v.id = p_conversation_id
       and v.organizacao_id = p_organizacao_id
       and (p_conexao_id is null or v.conexao_id is null or v.conexao_id = p_conexao_id);
$$;

-- ---------------------------------------------------------------------------
-- Gatilho de identidade. O nome começa por `trg_v` para disparar depois de
-- `trg_sync_chatwoot_*_organizacao` (migration 27), que ainda pode preencher a
-- organização a partir do `user_id`.
--
-- "Estrito" = a escrita afirma o vínculo (INSERT, ou UPDATE que muda a conexão
-- ou o pai). Só então um pai em outra conexão é recusado; uma escrita que não
-- mexe no vínculo (o backfill, um replay) deixa a linha em quarentena.
-- ---------------------------------------------------------------------------
create function public.fn_vincula_identidade_local_chatwoot()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_conexao_informada uuid := new.conexao_id;
    v_estrito boolean := tg_op = 'INSERT';
    v_completou boolean := false;
    v_vinculo text;
    v_organizacao_id uuid;
    v_provedor text;
begin
    if tg_op = 'UPDATE' then
        if old.id_local is not null and new.id_local is distinct from old.id_local then
            raise exception 'O id_local de %.% nao muda depois de definido.', tg_table_schema, tg_table_name
                using errcode = '23514';
        end if;
        if old.conexao_id is not null and new.conexao_id is not null and new.conexao_id <> old.conexao_id then
            raise exception 'A linha de %.% pertence a outra conexao Chatwoot; ids iguais de instalacoes diferentes nao se fundem.',
                tg_table_schema, tg_table_name
                using errcode = '23514';
        end if;
        v_estrito := v_conexao_informada is distinct from old.conexao_id;
    end if;

    new.id_local := coalesce(new.id_local, gen_random_uuid());
    new.id_externo := new.id::text;

    if tg_table_name = 'chatwoot_contacts' then
        if new.conexao_id is null and new.organizacao_id is not null then
            new.conexao_id := public.chatwoot_conexao_do_contato(new.organizacao_id, new.id);
        end if;

    elsif tg_table_name = 'chatwoot_conversations' then
        if new.conexao_id is null and new.organizacao_id is not null then
            new.conexao_id := public.chatwoot_conexao_da_conversa(new.organizacao_id, new.inbox_id, new.contact_id);
        end if;
        if tg_op = 'UPDATE' and (new.contact_id is distinct from old.contact_id
                                 or new.contato_id_local is distinct from old.contato_id_local) then
            v_estrito := true;
        end if;
        if new.contato_id_local is null
           or (tg_op = 'UPDATE' and new.contact_id is distinct from old.contact_id
               and new.contato_id_local is not distinct from old.contato_id_local) then
            new.contato_id_local := public.chatwoot_contato_local(new.organizacao_id, new.conexao_id, new.contact_id);
        elsif exists (select 1 from public.chatwoot_contacts c
                       where c.id_local = new.contato_id_local
                         and c.organizacao_id = new.organizacao_id
                         and (c.id <> new.contact_id
                              or (c.conexao_id is not null and new.conexao_id is not null
                                  and c.conexao_id <> new.conexao_id))) then
            raise exception 'A conversa aponta para um contato local que nao e o seu contato legado ou e de outra conexao.'
                using errcode = '23503';
        end if;
        if new.contato_id_local is null and v_estrito then
            raise exception 'O contato da conversa e de outra conexao Chatwoot ou e ambiguo.'
                using errcode = '23503';
        end if;

    elsif tg_table_name = 'chatwoot_messages' then
        if new.conexao_id is null and new.organizacao_id is not null then
            new.conexao_id := public.chatwoot_conexao_da_mensagem(new.organizacao_id, new.conversation_id);
        end if;
        if tg_op = 'UPDATE' and (new.conversation_id is distinct from old.conversation_id
                                 or new.conversa_id_local is distinct from old.conversa_id_local) then
            v_estrito := true;
        end if;
        if new.conversa_id_local is null
           or (tg_op = 'UPDATE' and new.conversation_id is distinct from old.conversation_id
               and new.conversa_id_local is not distinct from old.conversa_id_local) then
            new.conversa_id_local := public.chatwoot_conversa_local(new.organizacao_id, new.conexao_id, new.conversation_id);
        elsif exists (select 1 from public.chatwoot_conversations v
                       where v.id_local = new.conversa_id_local
                         and v.organizacao_id = new.organizacao_id
                         and (v.id <> new.conversation_id
                              or (v.conexao_id is not null and new.conexao_id is not null
                                  and v.conexao_id <> new.conexao_id))) then
            raise exception 'A mensagem aponta para uma conversa local que nao e a sua conversa legada ou e de outra conexao.'
                using errcode = '23503';
        end if;
        if new.conversa_id_local is null and v_estrito then
            raise exception 'A conversa da mensagem e de outra conexao Chatwoot ou e ambigua.'
                using errcode = '23503';
        end if;
    end if;

    if new.conexao_id is not null and (tg_op = 'INSERT' or new.conexao_id is distinct from old.conexao_id) then
        select c.organizacao_id, c.provedor into v_organizacao_id, v_provedor
          from public.conexoes_integracao c
         where c.id = new.conexao_id;
        if v_provedor is distinct from 'chatwoot' or v_organizacao_id is distinct from new.organizacao_id then
            raise exception 'Espelho Chatwoot so aponta para conexao Chatwoot da mesma organizacao.'
                using errcode = '23503';
        end if;
    end if;

    -- Completar a identidade não é atividade: mantém o `updated_at` que o
    -- gatilho `tg_*_updated_at` acabou de trocar por now().
    if tg_op = 'UPDATE' then
        -- A coluna de vínculo é de uma tabela só; `to_jsonb` evita citar campo
        -- que o registro das outras não tem.
        v_vinculo := case tg_table_name when 'chatwoot_conversations' then 'contato_id_local'
                                        when 'chatwoot_messages' then 'conversa_id_local' end;
        v_completou := old.id_local is null
            or (old.conexao_id is null and new.conexao_id is not null)
            or coalesce(to_jsonb(old) ->> v_vinculo is null and to_jsonb(new) ->> v_vinculo is not null, false);
        if v_completou
           and (to_jsonb(new) - array['id_local', 'id_externo', 'conexao_id', 'contato_id_local', 'conversa_id_local', 'updated_at'])
             = (to_jsonb(old) - array['id_local', 'id_externo', 'conexao_id', 'contato_id_local', 'conversa_id_local', 'updated_at']) then
            new.updated_at := old.updated_at;
        end if;
    end if;

    return new;
end;
$$;

create trigger trg_vincula_identidade_local_chatwoot
    before insert or update on public.chatwoot_contacts
    for each row execute function public.fn_vincula_identidade_local_chatwoot();
create trigger trg_vincula_identidade_local_chatwoot
    before insert or update on public.chatwoot_conversations
    for each row execute function public.fn_vincula_identidade_local_chatwoot();
create trigger trg_vincula_identidade_local_chatwoot
    before insert or update on public.chatwoot_messages
    for each row execute function public.fn_vincula_identidade_local_chatwoot();

create trigger trg_organizacao_do_chatwoot_contato_imutavel
    before update of organizacao_id on public.chatwoot_contacts
    for each row execute function public.fn_organizacao_da_integracao_imutavel();
create trigger trg_organizacao_da_chatwoot_conversa_imutavel
    before update of organizacao_id on public.chatwoot_conversations
    for each row execute function public.fn_organizacao_da_integracao_imutavel();
create trigger trg_organizacao_da_chatwoot_mensagem_imutavel
    before update of organizacao_id on public.chatwoot_messages
    for each row execute function public.fn_organizacao_da_integracao_imutavel();

-- ---------------------------------------------------------------------------
-- Backfill em lotes. Cada chamada processa até `p_lote` linhas por tabela, sob
-- advisory lock (duas execuções não se sobrepõem) e `skip locked` (não espera
-- uma escrita do webhook em andamento; a linha fica para a próxima chamada).
-- Seleciona linha sem UUID ou em quarentena que agora tem prova; por isso
-- termina e pode ser repetida a qualquer momento. Cada chamada é uma
-- transação: uma falha desfaz só o lote corrente.
-- ---------------------------------------------------------------------------
create function public.backfill_identidade_local_chatwoot(p_lote integer default 1000)
returns table (tabela text, atualizadas integer, pendentes bigint)
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_atualizadas integer;
begin
    if p_lote is null or p_lote < 1 or p_lote > 10000 then
        raise exception 'Lote do backfill deve estar entre 1 e 10000.' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('orbita:msg-002:backfill-identidade-chatwoot', 0));

    -- `set id_local = id_local` basta: o gatilho completa o resto.
    update public.chatwoot_contacts c
       set id_local = c.id_local
     where c.id in (select x.id from public.chatwoot_contacts x
                     where x.id_local is null
                        or (x.conexao_id is null and x.organizacao_id is not null
                            and public.chatwoot_conexao_do_contato(x.organizacao_id, x.id) is not null)
                     order by x.id
                     limit p_lote
                       for update skip locked);
    get diagnostics v_atualizadas = row_count;
    tabela := 'chatwoot_contacts';
    atualizadas := v_atualizadas;
    select count(*) into pendentes from public.chatwoot_contacts where id_local is null;
    return next;

    update public.chatwoot_conversations v
       set id_local = v.id_local
     where v.id in (select x.id from public.chatwoot_conversations x
                     where x.id_local is null
                        or (x.organizacao_id is not null
                            and ((x.conexao_id is null
                                  and public.chatwoot_conexao_da_conversa(x.organizacao_id, x.inbox_id, x.contact_id) is not null)
                                 or (x.contato_id_local is null
                                     and public.chatwoot_contato_local(
                                             x.organizacao_id,
                                             coalesce(x.conexao_id, public.chatwoot_conexao_da_conversa(x.organizacao_id, x.inbox_id, x.contact_id)),
                                             x.contact_id) is not null)))
                     order by x.id
                     limit p_lote
                       for update skip locked);
    get diagnostics v_atualizadas = row_count;
    tabela := 'chatwoot_conversations';
    atualizadas := v_atualizadas;
    select count(*) into pendentes from public.chatwoot_conversations where id_local is null;
    return next;

    update public.chatwoot_messages m
       set id_local = m.id_local
     where m.id in (select x.id from public.chatwoot_messages x
                     where x.id_local is null
                        or (x.organizacao_id is not null
                            and ((x.conexao_id is null
                                  and public.chatwoot_conexao_da_mensagem(x.organizacao_id, x.conversation_id) is not null)
                                 or (x.conversa_id_local is null
                                     and public.chatwoot_conversa_local(
                                             x.organizacao_id,
                                             coalesce(x.conexao_id, public.chatwoot_conexao_da_mensagem(x.organizacao_id, x.conversation_id)),
                                             x.conversation_id) is not null)))
                     order by x.id
                     limit p_lote
                       for update skip locked);
    get diagnostics v_atualizadas = row_count;
    tabela := 'chatwoot_messages';
    atualizadas := v_atualizadas;
    select count(*) into pendentes from public.chatwoot_messages where id_local is null;
    return next;
end;
$$;

revoke all on function public.chatwoot_conexao_do_contato(uuid, integer) from public, anon, authenticated;
revoke all on function public.chatwoot_conexao_da_conversa(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.chatwoot_conexao_da_mensagem(uuid, integer) from public, anon, authenticated;
revoke all on function public.chatwoot_contato_local(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.chatwoot_conversa_local(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.fn_vincula_identidade_local_chatwoot() from public, anon, authenticated;
revoke all on function public.backfill_identidade_local_chatwoot(integer) from public, anon, authenticated;
grant execute on function public.chatwoot_conexao_do_contato(uuid, integer) to service_role;
grant execute on function public.chatwoot_conexao_da_conversa(uuid, integer, integer) to service_role;
grant execute on function public.chatwoot_conexao_da_mensagem(uuid, integer) to service_role;
grant execute on function public.chatwoot_contato_local(uuid, uuid, integer) to service_role;
grant execute on function public.chatwoot_conversa_local(uuid, uuid, integer) to service_role;
grant execute on function public.backfill_identidade_local_chatwoot(integer) to service_role;

-- Roda o backfill até o fim. Nesta transação as três tabelas estão sob o lock
-- do ALTER TABLE, então nenhum lote é pulado; uma volta sem progresso aborta.
do $$
declare
    v_pendentes bigint;
    v_atualizadas bigint;
begin
    loop
        select sum(b.pendentes), sum(b.atualizadas) into v_pendentes, v_atualizadas
          from public.backfill_identidade_local_chatwoot(1000) b;
        exit when v_atualizadas = 0;
    end loop;
    if v_pendentes > 0 then
        raise exception 'MSG-002: backfill parou com % linha(s) sem id_local', v_pendentes;
    end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Constraints. Os índices únicos nascem depois do backfill (um passe só).
-- ---------------------------------------------------------------------------
alter table public.chatwoot_contacts
    alter column id_local set not null,
    alter column id_externo set not null,
    add constraint ck_chatwoot_contacts_id_externo_legado check (id_externo = id::text);
alter table public.chatwoot_conversations
    alter column id_local set not null,
    alter column id_externo set not null,
    add constraint ck_chatwoot_conversations_id_externo_legado check (id_externo = id::text);
alter table public.chatwoot_messages
    alter column id_local set not null,
    alter column id_externo set not null,
    add constraint ck_chatwoot_messages_id_externo_legado check (id_externo = id::text);

create unique index uq_chatwoot_contacts_id_local on public.chatwoot_contacts(id_local);
create unique index uq_chatwoot_conversations_id_local on public.chatwoot_conversations(id_local);
create unique index uq_chatwoot_messages_id_local on public.chatwoot_messages(id_local);

-- Alvo das FKs compostas: o UUID local dentro da organização.
create unique index uq_chatwoot_contacts_org_id_local on public.chatwoot_contacts(organizacao_id, id_local);
create unique index uq_chatwoot_conversations_org_id_local on public.chatwoot_conversations(organizacao_id, id_local);

-- Identidade remota: o mesmo id do Chatwoot pode existir em outra conexão ou
-- organização, nunca duas vezes na mesma. Sem predicado, para o `upsert` do
-- MSG-003A inferir o conflito (migration 55).
create unique index uq_chatwoot_contacts_identidade_remota
    on public.chatwoot_contacts(organizacao_id, conexao_id, id_externo);
create unique index uq_chatwoot_conversations_identidade_remota
    on public.chatwoot_conversations(organizacao_id, conexao_id, id_externo);
create unique index uq_chatwoot_messages_identidade_remota
    on public.chatwoot_messages(organizacao_id, conexao_id, id_externo);

create index idx_chatwoot_conversations_contato_local on public.chatwoot_conversations(contato_id_local);
create index idx_chatwoot_messages_conversa_local on public.chatwoot_messages(conversa_id_local);

alter table public.chatwoot_conversations
    add constraint fk_chatwoot_conversations_contato_local
    foreign key (organizacao_id, contato_id_local)
    references public.chatwoot_contacts(organizacao_id, id_local)
    on delete cascade;
alter table public.chatwoot_messages
    add constraint fk_chatwoot_messages_conversa_local
    foreign key (organizacao_id, conversa_id_local)
    references public.chatwoot_conversations(organizacao_id, id_local)
    on delete cascade;

-- ---------------------------------------------------------------------------
-- Quarentena: derivada, sempre atual, só para o servidor. Uma linha sai dela
-- quando ganha prova (próxima escrita com conexão ou nova chamada do backfill).
-- ---------------------------------------------------------------------------
create view public.chatwoot_identidade_em_quarentena
with (security_invoker = true)
as
select 'chatwoot_contacts'::text as tabela, c.id_local, c.id_externo, c.organizacao_id, c.conexao_id,
       case when c.organizacao_id is null then 'sem_organizacao' else 'conexao_nao_comprovada' end as motivo
  from public.chatwoot_contacts c
 where c.organizacao_id is null or c.conexao_id is null
union all
select 'chatwoot_conversations', v.id_local, v.id_externo, v.organizacao_id, v.conexao_id,
       case when v.organizacao_id is null then 'sem_organizacao'
            when v.conexao_id is null then 'conexao_nao_comprovada'
            when v.contato_id_local is null then 'contato_nao_vinculado'
            else 'conexao_divergente_do_contato' end
  from public.chatwoot_conversations v
  left join public.chatwoot_contacts c on c.id_local = v.contato_id_local
 where v.organizacao_id is null or v.conexao_id is null or v.contato_id_local is null
    or (c.conexao_id is not null and c.conexao_id <> v.conexao_id)
union all
select 'chatwoot_messages', m.id_local, m.id_externo, m.organizacao_id, m.conexao_id,
       case when m.organizacao_id is null then 'sem_organizacao'
            when m.conexao_id is null then 'conexao_nao_comprovada'
            when m.conversa_id_local is null then 'conversa_nao_vinculada'
            else 'conexao_divergente_da_conversa' end
  from public.chatwoot_messages m
  left join public.chatwoot_conversations v on v.id_local = m.conversa_id_local
 where m.organizacao_id is null or m.conexao_id is null or m.conversa_id_local is null
    or (v.conexao_id is not null and v.conexao_id <> m.conexao_id);

revoke all on public.chatwoot_identidade_em_quarentena from public, anon, authenticated;
grant select on public.chatwoot_identidade_em_quarentena to service_role;

-- ---------------------------------------------------------------------------
-- Autoverificação: aborta se o legado mudou, se faltar UUID ou vínculo
-- resolvível, se um vínculo atravessar organização ou conexão, se o navegador
-- escrever nos espelhos ou executar as funções novas, ou se um gatilho faltar.
-- ---------------------------------------------------------------------------
do $$
declare
    v_texto text;
    v_quarentena text;
begin
    select string_agg(r.tabela, ', ') into v_texto
      from msg002_retrato_legado r
      join (select 'chatwoot_contacts'::text as tabela, count(*) as linhas,
                   md5(coalesce(string_agg(row(c.id, c.user_id, c.organizacao_id, c.name, c.email, c.phone_number,
                                               c.phone_normalizado, c.avatar_url, c.created_at, c.updated_at)::text, '|' order by c.id), '')) as digest
              from public.chatwoot_contacts c
            union all
            select 'chatwoot_conversations', count(*),
                   md5(coalesce(string_agg(row(v.id, v.user_id, v.organizacao_id, v.display_id, v.contact_id, v.status,
                                               v.inbox_id, v.channel, v.created_at, v.updated_at)::text, '|' order by v.id), ''))
              from public.chatwoot_conversations v
            union all
            select 'chatwoot_messages', count(*),
                   md5(coalesce(string_agg(row(m.id, m.user_id, m.organizacao_id, m.conversation_id, m.content, m.message_type,
                                               m.sender_name, m.sender_id, m.sender_type, m.created_at, m.updated_at)::text, '|' order by m.id), ''))
              from public.chatwoot_messages m) agora on agora.tabela = r.tabela
     where agora.linhas <> r.linhas or agora.digest <> r.digest;
    if v_texto is not null then
        raise exception 'MSG-002: o legado mudou durante o backfill em %', v_texto;
    end if;

    select count(*)::text into v_texto
      from public.chatwoot_conversations v
      join public.chatwoot_contacts c on c.id_local = v.contato_id_local
     where c.organizacao_id is distinct from v.organizacao_id
        or c.id <> v.contact_id
        or (c.conexao_id is not null and v.conexao_id is not null and c.conexao_id <> v.conexao_id);
    if v_texto <> '0' then
        raise exception 'MSG-002: % conversa(s) com contato local de outra organizacao, conexao ou id legado', v_texto;
    end if;
    select count(*)::text into v_texto
      from public.chatwoot_messages m
      join public.chatwoot_conversations v on v.id_local = m.conversa_id_local
     where v.organizacao_id is distinct from m.organizacao_id
        or v.id <> m.conversation_id
        or (v.conexao_id is not null and m.conexao_id is not null and v.conexao_id <> m.conexao_id);
    if v_texto <> '0' then
        raise exception 'MSG-002: % mensagem(ns) com conversa local de outra organizacao, conexao ou id legado', v_texto;
    end if;

    if exists (select 1 from public.backfill_identidade_local_chatwoot(1) b where b.atualizadas > 0) then
        raise exception 'MSG-002: o backfill ainda encontra linha resolvivel depois de concluido';
    end if;

    select string_agg(t.tabela || ':' || r.rolname, ', ') into v_texto
      from (values ('public.chatwoot_contacts'), ('public.chatwoot_conversations'), ('public.chatwoot_messages'),
                   ('public.chatwoot_identidade_em_quarentena')) as t(tabela)
     cross join (values ('authenticated'), ('anon')) as r(rolname)
     where has_table_privilege(r.rolname, t.tabela, 'INSERT')
        or has_table_privilege(r.rolname, t.tabela, 'UPDATE')
        or has_table_privilege(r.rolname, t.tabela, 'DELETE')
        or has_table_privilege(r.rolname, t.tabela, 'TRUNCATE')
        or (t.tabela = 'public.chatwoot_identidade_em_quarentena'
            and has_table_privilege(r.rolname, t.tabela, 'SELECT'))
        or exists (select 1 from pg_attribute a
                    where a.attrelid = t.tabela::regclass and a.attnum > 0 and not a.attisdropped
                      and (has_column_privilege(r.rolname, a.attrelid, a.attname, 'INSERT')
                           or has_column_privilege(r.rolname, a.attrelid, a.attname, 'UPDATE')));
    if v_texto is not null then
        raise exception 'MSG-002: o navegador escreve nos espelhos ou le a quarentena (%)', v_texto;
    end if;

    select p.oid::regprocedure::text into v_texto
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('chatwoot_conexao_do_contato', 'chatwoot_conexao_da_conversa', 'chatwoot_conexao_da_mensagem',
                         'chatwoot_contato_local', 'chatwoot_conversa_local',
                         'fn_vincula_identidade_local_chatwoot', 'backfill_identidade_local_chatwoot')
       and (has_function_privilege('authenticated', p.oid, 'execute')
            or has_function_privilege('anon', p.oid, 'execute'))
     limit 1;
    if v_texto is not null then
        raise exception 'MSG-002: o navegador executa %', v_texto;
    end if;

    select t.tgname into v_texto
      from (values ('public.chatwoot_contacts', 'trg_vincula_identidade_local_chatwoot'),
                   ('public.chatwoot_conversations', 'trg_vincula_identidade_local_chatwoot'),
                   ('public.chatwoot_messages', 'trg_vincula_identidade_local_chatwoot'),
                   ('public.chatwoot_contacts', 'trg_organizacao_do_chatwoot_contato_imutavel'),
                   ('public.chatwoot_conversations', 'trg_organizacao_da_chatwoot_conversa_imutavel'),
                   ('public.chatwoot_messages', 'trg_organizacao_da_chatwoot_mensagem_imutavel')) as t(tabela, tgname)
     where not exists (select 1 from pg_trigger g
                        where g.tgrelid = t.tabela::regclass and g.tgname = t.tgname and g.tgenabled = 'O')
     limit 1;
    if v_texto is not null then
        raise exception 'MSG-002: gatilho % ausente ou desligado', v_texto;
    end if;

    select string_agg(q.tabela || '/' || q.motivo || '=' || q.n, ', ' order by q.tabela, q.motivo) into v_quarentena
      from (select tabela, motivo, count(*) as n from public.chatwoot_identidade_em_quarentena group by 1, 2) q;
    raise notice 'MSG-002: identidade local concluida; quarentena: %', coalesce(v_quarentena, 'vazia');
end;
$$;

notify pgrst, 'reload schema';
