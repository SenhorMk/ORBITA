-- 87_contrair_chaves_globais_chatwoot.sql (ordem 90, depois da 86 do MSG-007)
--
-- Forward-only. MSG-004 (contract): os espelhos do Chatwoot deixam de usar o id
-- numérico do Chatwoot como chave. Duas instalações (na mesma organização ou em
-- organizações diferentes) passam a coexistir com os mesmos ids remotos.
--
-- ESTADO ANTERIOR (medido no laboratório com a cadeia 01-85, ledger 88):
--   - PK `id int` global nas três tabelas; FKs legadas `contact_id` →
--     contatos(id) e `conversation_id` → conversas(id); índices únicos
--     `uq_chatwoot_*_org_id (organizacao_id, id)`; CHECK `id_externo = id::text`.
--   - `uq_chatwoot_*_identidade_remota (organizacao_id, conexao_id, id_externo)`
--     com NULLS DISTINCT: só a PK global impedia duas linhas legadas iguais.
--   - Gatilhos da migration 27 (conversa/mensagem) procuram o pai só pelo id
--     remoto, em qualquer organização.
--   - Funções da 85 que inferem conexão ou vínculo por `id`: com ids repetidos,
--     `chatwoot_conexao_da_mensagem` devolveria a primeira linha (palpite) e as
--     subconsultas escalares de `chatwoot_conexao_da_conversa` quebrariam.
--   - O backfill da 85 atualiza `where id in (...)`: sem a PK, tocaria linhas
--     de outras organizações com o mesmo id.
--   - Retenção (51): candidato, exclusão e reaplicação no restore por `id` +
--     organização. Duas instalações da mesma organização → o contato 5 de uma
--     apagaria o contato 5 da outra.
--   - `verificar_integridade_baseline` (19) cruza mensagem e conversa por id.
--   - `chatwoot_inboxes`: único por `(organizacao_id, inbox_id)`; a segunda
--     instalação da organização perde o mapeamento do inbox 1 (o 23505 é
--     engolido pelo registro).
--   - `inbox_eventos_chatwoot`: dedup por `(organizacao_id, idempotency_key)`,
--     e a chave é feita só de ids remotos. A mensagem 500 da segunda instalação
--     seria tratada como duplicata da primeira e descartada com 200.
--
-- O QUE MUDA:
--   1. PK = `id_local` nas três tabelas; FKs legadas e `uq_chatwoot_*_org_id`
--      saem. O vínculo é só a FK composta `(organizacao_id, *_id_local)`.
--   2. Identidade remota única por `(organizacao_id, conexao_id, id_externo)`
--      com NULLS NOT DISTINCT: uma linha legada sem conexão também não se
--      duplica.
--   3. `id`, `contact_id` e `conversation_id` ficam como dado (eco do id remoto
--      que o adapter já grava), sem papel de chave. O CHECK `id_externo =
--      id::text` fica: é a coerência desse eco. Remover as colunas é limpeza
--      posterior, quando o rollback de código para o MSG-003B não for mais
--      necessário.
--   4. Quarentena fail-closed:
--        - linha nova sem organização ou sem conexão provada é recusada
--          (`23514`); não nasce mais quarentena;
--        - linha legada (sem conexão) só é adotada pela conexão que a prova
--          aponta ou pela única conexão Chatwoot da organização;
--        - em organização com mais de uma conexão Chatwoot, uma linha legada
--          não recebe conteúdo novo sem ser adotada (`23514`).
--   5. Inferências e backfill passam a usar a identidade local; nenhuma busca
--      devolve "a primeira" linha: mais de um candidato é nulo.
--   6. Gatilhos da 27: a organização herdada vem do pai pelo UUID local.
--   7. Inbox: único por `(conexao_id, inbox_id)` (já existia); sai o único por
--      organização. Eventos: dedup por organização + conexão + chave.
--   8. Retenção do contato Chatwoot pelo UUID local; legal holds numéricos são
--      traduzidos; tombstone numérico antigo só reaplica sobre a linha que
--      existia quando foi gravado; hold numérico novo é recusado.
--   9. `verificar_integridade_baseline` cruza mensagem e conversa pelo UUID.
--
-- PREFLIGHT (aborta sem mudar nada): toda relação legada precisa estar
-- representada pela FK composta antes de a FK legada sair. Conversa sem
-- `contato_id_local`, mensagem sem `conversa_id_local` ou espelho sem
-- organização impedem a migration (runbook: resolver a quarentena antes).
--
-- RECUPERAÇÃO: forward-only. O código do MSG-003B continua compatível com este
-- schema (rollback de código não exige SQL). Ver docs/operations/msg-004-runbook.md.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Preflight.
-- ---------------------------------------------------------------------------
do $$
declare
    v_sem_contato bigint;
    v_sem_conversa bigint;
    v_sem_organizacao bigint;
    v_vinculo_divergente bigint;
begin
    select count(*) into v_sem_contato from public.chatwoot_conversations where contato_id_local is null;
    select count(*) into v_sem_conversa from public.chatwoot_messages where conversa_id_local is null;
    select (select count(*) from public.chatwoot_contacts where organizacao_id is null)
         + (select count(*) from public.chatwoot_conversations where organizacao_id is null)
         + (select count(*) from public.chatwoot_messages where organizacao_id is null)
      into v_sem_organizacao;
    -- O vínculo local tem de ser o mesmo pai da FK legada que vai sair.
    select (select count(*) from public.chatwoot_conversations v
              join public.chatwoot_contacts c on c.id_local = v.contato_id_local
             where c.id <> v.contact_id or c.organizacao_id is distinct from v.organizacao_id)
         + (select count(*) from public.chatwoot_messages m
              join public.chatwoot_conversations v on v.id_local = m.conversa_id_local
             where v.id <> m.conversation_id or v.organizacao_id is distinct from m.organizacao_id)
      into v_vinculo_divergente;
    if v_sem_contato + v_sem_conversa + v_sem_organizacao + v_vinculo_divergente > 0 then
        raise exception 'MSG-004: relacao legada sem identidade local (conversas sem contato local=%, mensagens sem conversa local=%, sem organizacao=%, vinculo divergente=%); resolver a quarentena antes desta migration',
            v_sem_contato, v_sem_conversa, v_sem_organizacao, v_vinculo_divergente;
    end if;
end;
$$;

-- Retrato do conteúdo, comparado no fim: a contração não muda nenhuma linha.
create temp table msg004_retrato on commit drop as
select 'chatwoot_contacts'::text as tabela, count(*) as linhas,
       md5(coalesce(string_agg(row(c.id_local, c.id_externo, c.organizacao_id, c.conexao_id, c.name, c.email,
                                   c.phone_number, c.updated_at)::text, '|' order by c.id_local), '')) as digest
  from public.chatwoot_contacts c
union all
select 'chatwoot_conversations', count(*),
       md5(coalesce(string_agg(row(v.id_local, v.id_externo, v.organizacao_id, v.conexao_id, v.contato_id_local,
                                   v.status, v.updated_at)::text, '|' order by v.id_local), ''))
  from public.chatwoot_conversations v
union all
select 'chatwoot_messages', count(*),
       md5(coalesce(string_agg(row(m.id_local, m.id_externo, m.organizacao_id, m.conexao_id, m.conversa_id_local,
                                   m.content, m.updated_at)::text, '|' order by m.id_local), ''))
  from public.chatwoot_messages m;

-- ---------------------------------------------------------------------------
-- 1. Chaves: sai o id remoto, entra o UUID local.
-- ---------------------------------------------------------------------------
alter table public.chatwoot_messages drop constraint chatwoot_messages_conversation_id_fkey;
alter table public.chatwoot_conversations drop constraint chatwoot_conversations_contact_id_fkey;

alter table public.chatwoot_contacts drop constraint chatwoot_contacts_pkey;
alter table public.chatwoot_conversations drop constraint chatwoot_conversations_pkey;
alter table public.chatwoot_messages drop constraint chatwoot_messages_pkey;

-- O índice único do UUID (85) vira a PK; o nome segue a convenção da tabela.
alter table public.chatwoot_contacts
    add constraint chatwoot_contacts_pkey primary key using index uq_chatwoot_contacts_id_local;
alter table public.chatwoot_conversations
    add constraint chatwoot_conversations_pkey primary key using index uq_chatwoot_conversations_id_local;
alter table public.chatwoot_messages
    add constraint chatwoot_messages_pkey primary key using index uq_chatwoot_messages_id_local;

drop index public.uq_chatwoot_contacts_org_id;
drop index public.uq_chatwoot_conversations_org_id;
drop index public.uq_chatwoot_messages_org_id;

-- 2. Identidade remota: NULLS NOT DISTINCT, então a linha legada sem conexão
--    também é única por organização + id remoto.
drop index public.uq_chatwoot_contacts_identidade_remota;
drop index public.uq_chatwoot_conversations_identidade_remota;
drop index public.uq_chatwoot_messages_identidade_remota;
create unique index uq_chatwoot_contacts_identidade_remota
    on public.chatwoot_contacts(organizacao_id, conexao_id, id_externo) nulls not distinct;
create unique index uq_chatwoot_conversations_identidade_remota
    on public.chatwoot_conversations(organizacao_id, conexao_id, id_externo) nulls not distinct;
create unique index uq_chatwoot_messages_identidade_remota
    on public.chatwoot_messages(organizacao_id, conexao_id, id_externo) nulls not distinct;

comment on column public.chatwoot_contacts.id is
    'MSG-004: eco do id do Chatwoot (= id_externo), sem papel de chave. A chave e id_local.';
comment on column public.chatwoot_conversations.contact_id is
    'MSG-004: eco do id do contato no Chatwoot, sem FK. O vinculo e contato_id_local.';
comment on column public.chatwoot_messages.conversation_id is
    'MSG-004: eco do id da conversa no Chatwoot, sem FK. O vinculo e conversa_id_local.';
comment on column public.chatwoot_contacts.id_externo is
    'MSG-002/004: id do Chatwoot como texto. Unico por (organizacao_id, conexao_id), nunca global.';

-- ---------------------------------------------------------------------------
-- 3. Prova de conexão sem palpite. Mais de um candidato → nulo.
-- ---------------------------------------------------------------------------
drop function public.chatwoot_conexao_do_contato(uuid, integer);
drop function public.chatwoot_conexao_da_conversa(uuid, integer, integer);
drop function public.chatwoot_conexao_da_mensagem(uuid, integer);

-- A única conexão Chatwoot da organização (qualquer status: uma conexão
-- desligada ainda é uma segunda instalação).
create function public.chatwoot_conexao_unica(p_organizacao_id uuid)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
    select case when count(*) = 1 then (array_agg(c.id))[1] end
      from public.conexoes_integracao c
     where c.organizacao_id = p_organizacao_id
       and c.provedor = 'chatwoot';
$$;

-- Inbox: o mapeamento só prova a conexão se for único na organização.
create function public.chatwoot_conexao_do_inbox(p_organizacao_id uuid, p_inbox_id integer)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
    select case when count(*) = 1 then (array_agg(i.conexao_id))[1] end
      from public.chatwoot_inboxes i
     where i.organizacao_id = p_organizacao_id
       and i.inbox_id = p_inbox_id
       and i.conexao_id is not null;
$$;

-- Contato: a conexão única das conversas ligadas a ele pelo UUID local (gravada
-- na conversa ou dada pelo mapeamento único do inbox).
create function public.chatwoot_conexao_do_contato(p_organizacao_id uuid, p_contato_id_local uuid)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
    select case when count(distinct x.conexao_id) = 1 then (array_agg(x.conexao_id))[1] end
      from (select coalesce(v.conexao_id, public.chatwoot_conexao_do_inbox(v.organizacao_id, v.inbox_id)) as conexao_id
              from public.chatwoot_conversations v
             where v.contato_id_local = p_contato_id_local
               and v.organizacao_id = p_organizacao_id) x
     where x.conexao_id is not null;
$$;

-- Conversa: o inbox; sem ele, o contato local.
create function public.chatwoot_conexao_da_conversa(p_organizacao_id uuid, p_inbox_id integer, p_contato_id_local uuid)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
    select coalesce(
        public.chatwoot_conexao_do_inbox(p_organizacao_id, p_inbox_id),
        (select c.conexao_id from public.chatwoot_contacts c
          where c.id_local = p_contato_id_local and c.organizacao_id = p_organizacao_id));
$$;

-- Mensagem: a conversa local.
create function public.chatwoot_conexao_da_mensagem(p_organizacao_id uuid, p_conversa_id_local uuid)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
    select v.conexao_id from public.chatwoot_conversations v
     where v.id_local = p_conversa_id_local and v.organizacao_id = p_organizacao_id;
$$;

-- Vínculo local pelo id remoto do pai, dentro da organização e da conexão (ou
-- ainda sem conexão). Mesma assinatura da 85; a busca passa a ser por
-- `id_externo`, que não é mais único fora de organização + conexão.
create or replace function public.chatwoot_contato_local(p_organizacao_id uuid, p_conexao_id uuid, p_contact_id integer)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
    select case when count(*) = 1 then (array_agg(c.id_local))[1] end
      from public.chatwoot_contacts c
     where c.id_externo = p_contact_id::text
       and c.organizacao_id = p_organizacao_id
       and (p_conexao_id is null or c.conexao_id is null or c.conexao_id = p_conexao_id);
$$;

create or replace function public.chatwoot_conversa_local(p_organizacao_id uuid, p_conexao_id uuid, p_conversation_id integer)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
    select case when count(*) = 1 then (array_agg(v.id_local))[1] end
      from public.chatwoot_conversations v
     where v.id_externo = p_conversation_id::text
       and v.organizacao_id = p_organizacao_id
       and (p_conexao_id is null or v.conexao_id is null or v.conexao_id = p_conexao_id);
$$;

-- ---------------------------------------------------------------------------
-- 4. Gatilho de identidade (mesmo nome e ordem da 85), agora sem chave global
--    e com a quarentena fail-closed.
-- ---------------------------------------------------------------------------
create or replace function public.fn_vincula_identidade_local_chatwoot()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_conexao_informada uuid := new.conexao_id;
    v_estrito boolean := tg_op = 'INSERT';
    v_completou boolean := false;
    v_conteudo_mudou boolean := false;
    v_vinculo text;
    v_prova uuid;
    v_organizacao_id uuid;
    v_provedor text;
    v_identidade constant text[] := array['id_local', 'id_externo', 'conexao_id', 'contato_id_local',
                                          'conversa_id_local', 'updated_at'];
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
        v_conteudo_mudou := (to_jsonb(new) - v_identidade) <> (to_jsonb(old) - v_identidade);
    end if;

    new.id_local := coalesce(new.id_local, gen_random_uuid());
    new.id_externo := new.id::text;

    if tg_table_name = 'chatwoot_contacts' then
        v_prova := public.chatwoot_conexao_do_contato(new.organizacao_id, new.id_local);

    elsif tg_table_name = 'chatwoot_conversations' then
        if tg_op = 'UPDATE' and (new.contact_id is distinct from old.contact_id
                                 or new.contato_id_local is distinct from old.contato_id_local) then
            v_estrito := true;
        end if;
        v_prova := public.chatwoot_conexao_da_conversa(new.organizacao_id, new.inbox_id, new.contato_id_local);
        if new.conexao_id is null then
            new.conexao_id := v_prova;
        end if;
        if new.contato_id_local is null
           or (tg_op = 'UPDATE' and new.contact_id is distinct from old.contact_id
               and new.contato_id_local is not distinct from old.contato_id_local) then
            new.contato_id_local := public.chatwoot_contato_local(new.organizacao_id, new.conexao_id, new.contact_id);
        elsif exists (select 1 from public.chatwoot_contacts c
                       where c.id_local = new.contato_id_local
                         and c.organizacao_id = new.organizacao_id
                         and (c.id_externo <> new.contact_id::text
                              or (c.conexao_id is not null and new.conexao_id is not null
                                  and c.conexao_id <> new.conexao_id))) then
            raise exception 'A conversa aponta para um contato local que nao e o seu contato remoto ou e de outra conexao.'
                using errcode = '23503';
        end if;
        if new.contato_id_local is null and v_estrito then
            raise exception 'O contato da conversa e de outra conexao Chatwoot ou e ambiguo.'
                using errcode = '23503';
        end if;

    elsif tg_table_name = 'chatwoot_messages' then
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
                         and (v.id_externo <> new.conversation_id::text
                              or (v.conexao_id is not null and new.conexao_id is not null
                                  and v.conexao_id <> new.conexao_id))) then
            raise exception 'A mensagem aponta para uma conversa local que nao e a sua conversa remota ou e de outra conexao.'
                using errcode = '23503';
        end if;
        if new.conversa_id_local is null and v_estrito then
            raise exception 'A conversa da mensagem e de outra conexao Chatwoot ou e ambigua.'
                using errcode = '23503';
        end if;
        v_prova := public.chatwoot_conexao_da_mensagem(new.organizacao_id, new.conversa_id_local);
        if new.conexao_id is null then
            new.conexao_id := v_prova;
        end if;
    end if;

    -- Contato: a prova só completa uma linha que já existe (o INSERT do contato
    -- não tem conversas ligadas a ele ainda).
    if tg_table_name = 'chatwoot_contacts' and new.conexao_id is null then
        new.conexao_id := v_prova;
    end if;

    -- Quarentena fail-closed (MSG-004).
    if tg_op = 'INSERT' and (new.organizacao_id is null or new.conexao_id is null) then
        raise exception 'Espelho Chatwoot novo exige organizacao e conexao provadas (%.%).', tg_table_schema, tg_table_name
            using errcode = '23514';
    end if;
    if tg_op = 'UPDATE' and old.conexao_id is null then
        if v_conexao_informada is not null
           and v_conexao_informada is distinct from coalesce(v_prova, public.chatwoot_conexao_unica(new.organizacao_id)) then
            raise exception 'Linha legada de %.% so e adotada pela conexao provada ou pela unica conexao Chatwoot da organizacao.',
                tg_table_schema, tg_table_name
                using errcode = '23514';
        end if;
        if new.conexao_id is null and v_conteudo_mudou
           and (select count(*) from public.conexoes_integracao c
                 where c.organizacao_id = new.organizacao_id and c.provedor = 'chatwoot') > 1 then
            raise exception 'Linha legada de %.% sem conexao provada nao recebe conteudo numa organizacao com mais de uma conexao Chatwoot.',
                tg_table_schema, tg_table_name
                using errcode = '23514';
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

    -- Completar a identidade não é atividade: mantém o `updated_at` anterior.
    if tg_op = 'UPDATE' then
        v_vinculo := case tg_table_name when 'chatwoot_conversations' then 'contato_id_local'
                                        when 'chatwoot_messages' then 'conversa_id_local' end;
        v_completou := (old.conexao_id is null and new.conexao_id is not null)
            or coalesce(to_jsonb(old) ->> v_vinculo is null and to_jsonb(new) ->> v_vinculo is not null, false);
        if v_completou and not v_conteudo_mudou then
            new.updated_at := old.updated_at;
        end if;
    end if;

    return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Backfill da 85: seleciona e atualiza pelo UUID local (o id não é mais
--    único) e usa as provas sem palpite.
-- ---------------------------------------------------------------------------
create or replace function public.backfill_identidade_local_chatwoot(p_lote integer default 1000)
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

    update public.chatwoot_contacts c
       set id_local = c.id_local
     where c.id_local in (select x.id_local from public.chatwoot_contacts x
                           where x.conexao_id is null and x.organizacao_id is not null
                             and public.chatwoot_conexao_do_contato(x.organizacao_id, x.id_local) is not null
                           order by x.id_local
                           limit p_lote
                             for update skip locked);
    get diagnostics v_atualizadas = row_count;
    tabela := 'chatwoot_contacts';
    atualizadas := v_atualizadas;
    select count(*) into pendentes from public.chatwoot_contacts where conexao_id is null;
    return next;

    update public.chatwoot_conversations v
       set id_local = v.id_local
     where v.id_local in (select x.id_local from public.chatwoot_conversations x
                           where x.conexao_id is null and x.organizacao_id is not null
                             and public.chatwoot_conexao_da_conversa(x.organizacao_id, x.inbox_id, x.contato_id_local) is not null
                           order by x.id_local
                           limit p_lote
                             for update skip locked);
    get diagnostics v_atualizadas = row_count;
    tabela := 'chatwoot_conversations';
    atualizadas := v_atualizadas;
    select count(*) into pendentes from public.chatwoot_conversations where conexao_id is null;
    return next;

    update public.chatwoot_messages m
       set id_local = m.id_local
     where m.id_local in (select x.id_local from public.chatwoot_messages x
                           where x.conexao_id is null and x.organizacao_id is not null
                             and public.chatwoot_conexao_da_mensagem(x.organizacao_id, x.conversa_id_local) is not null
                           order by x.id_local
                           limit p_lote
                             for update skip locked);
    get diagnostics v_atualizadas = row_count;
    tabela := 'chatwoot_messages';
    atualizadas := v_atualizadas;
    select count(*) into pendentes from public.chatwoot_messages where conexao_id is null;
    return next;
end;
$$;

comment on function public.backfill_identidade_local_chatwoot(integer) is
    'MSG-004: completa a conexao de linhas legadas que ganharam prova. pendentes = linhas ainda sem conexao (quarentena).';

-- ---------------------------------------------------------------------------
-- 6. Gatilhos da migration 27: a organização herdada vem do pai pelo UUID
--    local. O resto (fallback por user_id) não muda.
-- ---------------------------------------------------------------------------
create or replace function public.fn_sync_chatwoot_conversations_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org_id uuid;
    v_contact_org_id uuid;
    v_owner_user_id uuid;
begin
    if new.contato_id_local is not null then
        select organizacao_id into v_contact_org_id
        from public.chatwoot_contacts
        where id_local = new.contato_id_local;

        if new.organizacao_id is null and v_contact_org_id is not null then
            new.organizacao_id := v_contact_org_id;
        end if;

        if new.organizacao_id is not null and v_contact_org_id is not null and new.organizacao_id <> v_contact_org_id then
            raise exception 'Cross-tenant violation: a conversa pertence a uma organizacao diferente do contato'
                using errcode = '23503';
        end if;
    end if;

    if new.organizacao_id is null and new.user_id is not null then
        select organizacao_id into v_org_id
        from public.membros_organizacao
        where user_id = new.user_id
        order by (case when papel = 'owner' then 1 else 2 end), created_at asc
        limit 1;

        if v_org_id is not null then
            new.organizacao_id := v_org_id;
        end if;
    end if;

    if new.user_id is null and new.organizacao_id is not null then
        select user_id into v_owner_user_id
        from public.membros_organizacao
        where organizacao_id = new.organizacao_id
          and papel = 'owner'
        limit 1;

        if v_owner_user_id is not null then
            new.user_id := v_owner_user_id;
        end if;
    end if;

    return new;
end;
$$;

create or replace function public.fn_sync_chatwoot_messages_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org_id uuid;
    v_conv_org_id uuid;
    v_owner_user_id uuid;
begin
    if new.conversa_id_local is not null then
        select organizacao_id into v_conv_org_id
        from public.chatwoot_conversations
        where id_local = new.conversa_id_local;

        if new.organizacao_id is null and v_conv_org_id is not null then
            new.organizacao_id := v_conv_org_id;
        end if;

        if new.organizacao_id is not null and v_conv_org_id is not null and new.organizacao_id <> v_conv_org_id then
            raise exception 'Cross-tenant violation: a mensagem pertence a uma organizacao diferente da conversa'
                using errcode = '23503';
        end if;
    end if;

    if new.organizacao_id is null and new.user_id is not null then
        select organizacao_id into v_org_id
        from public.membros_organizacao
        where user_id = new.user_id
        order by (case when papel = 'owner' then 1 else 2 end), created_at asc
        limit 1;

        if v_org_id is not null then
            new.organizacao_id := v_org_id;
        end if;
    end if;

    if new.user_id is null and new.organizacao_id is not null then
        select user_id into v_owner_user_id
        from public.membros_organizacao
        where organizacao_id = new.organizacao_id
          and papel = 'owner'
        limit 1;

        if v_owner_user_id is not null then
            new.user_id := v_owner_user_id;
        end if;
    end if;

    return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Inbox e eventos por instalação.
-- ---------------------------------------------------------------------------
drop index public.uq_chatwoot_inboxes_org_inbox;

drop index public.uq_inbox_eventos_chatwoot_org_key;
create unique index uq_inbox_eventos_chatwoot_conexao_key
    on public.inbox_eventos_chatwoot(organizacao_id, conexao_id, idempotency_key) nulls not distinct;

create or replace function public.registrar_evento_inbox_chatwoot(
    p_organizacao_id uuid,
    p_conexao_id uuid,
    p_user_id uuid,
    p_inbox_id bigint,
    p_idempotency_key text,
    p_event_type text,
    p_payload jsonb
)
returns table (
    evento_id uuid,
    status text,
    is_duplicate boolean,
    cached_response jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_existente record;
    v_new_id uuid;
begin
    -- A chave é feita de ids remotos: só é duplicata na mesma instalação.
    select id, inbox_eventos_chatwoot.status, response_body into v_existente
    from public.inbox_eventos_chatwoot
    where organizacao_id = p_organizacao_id
      and conexao_id is not distinct from p_conexao_id
      and idempotency_key = p_idempotency_key
    for update;

    if found then
        return query select v_existente.id, v_existente.status, true, v_existente.response_body;
        return;
    end if;

    insert into public.inbox_eventos_chatwoot (
        organizacao_id,
        conexao_id,
        user_id,
        inbox_id,
        idempotency_key,
        event_type,
        payload,
        status,
        attempts
    ) values (
        p_organizacao_id,
        p_conexao_id,
        p_user_id,
        p_inbox_id,
        p_idempotency_key,
        p_event_type,
        p_payload,
        'received',
        0
    )
    returning id into v_new_id;

    return query select v_new_id, 'received'::text, false, null::jsonb;
    return;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Retenção do contato Chatwoot pelo UUID local.
-- ---------------------------------------------------------------------------

-- Holds numéricos ativos ou liberados: antes desta migration `(organizacao_id,
-- id)` era único, então a tradução é exata. Hold de linha que já não existe
-- fica como está (não protege nada).
update public.retention_legal_holds h
   set entidade_id = c.id_local::text
  from public.chatwoot_contacts c
 where h.entidade_id ~ '^[0-9]+$'
   and exists (select 1 from public.retention_policy_registry r
                where r.categoria = h.categoria and r.tabela_alvo = 'chatwoot_contacts')
   and c.organizacao_id = h.organizacao_id
   and c.id = h.entidade_id::integer;

create or replace function public.retencao_marcar_legal_hold(
    p_organizacao_id uuid,
    p_categoria text,
    p_entidade_id text,
    p_motivo text,
    p_criado_por uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id uuid;
begin
    -- Contato Chatwoot é referido pelo UUID local: um id remoto não protege
    -- ninguém (repete-se entre instalações).
    if exists (select 1 from public.retention_policy_registry r
                where r.categoria = p_categoria and r.tabela_alvo = 'chatwoot_contacts')
       and p_entidade_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'Legal hold de contato Chatwoot exige o UUID local do contato.' using errcode = '22023';
    end if;
    insert into public.retention_legal_holds (organizacao_id, categoria, entidade_id, motivo, criado_por)
    values (p_organizacao_id, p_categoria, p_entidade_id, p_motivo, p_criado_por)
    returning id into v_id;
    return v_id;
end;
$$;

create or replace function public.retencao_selecionar_e_reivindicar_lote_impl(
    p_run_id uuid,
    p_organizacao_id uuid,
    p_categoria text,
    p_tabela_alvo text,
    p_cutoff timestamptz,
    p_limit integer default 100
)
returns table (out_entidade_id text, out_relogio timestamptz, out_em_legal_hold boolean, out_ja_processado boolean)
language plpgsql
security definer
set search_path = public
as $$
begin
    if p_limit is null or p_limit <= 0 or p_limit > 1000 then
        raise exception 'p_limit deve estar entre 1 e 1000 (recebido %)', p_limit using errcode = '22023';
    end if;

    if p_tabela_alvo = 'clientes' then
        return query
        with candidatos as (
            select
                c.id::text as v_entidade_id,
                c.updated_at as v_relogio,
                (c.anonimizado_em is not null) as v_ja_processado
            from public.clientes c
            where c.organizacao_id = p_organizacao_id
              and c.updated_at <= p_cutoff
            order by c.updated_at asc
            limit p_limit
            for update of c skip locked
        ),
        reivindicados as (
            insert into public.retention_run_items as rri (run_id, entidade_id, status)
            select p_run_id, cand.v_entidade_id, 'selected'
            from candidatos cand
            on conflict (run_id, entidade_id) do nothing
            returning rri.entidade_id as v_reivindicado_id
        )
        select
            cand.v_entidade_id,
            cand.v_relogio,
            (h.id is not null) as em_legal_hold,
            cand.v_ja_processado
        from candidatos cand
        join reivindicados r on r.v_reivindicado_id = cand.v_entidade_id
        left join public.retention_legal_holds h
            on h.organizacao_id = p_organizacao_id
           and h.categoria = p_categoria
           and h.entidade_id = cand.v_entidade_id
           and h.liberado_em is null;
        return;
    elsif p_tabela_alvo = 'chatwoot_contacts' then
        return query
        with candidatos as (
            select
                cc.id_local::text as v_entidade_id,
                cc.updated_at as v_relogio,
                false as v_ja_processado
            from public.chatwoot_contacts cc
            where cc.organizacao_id = p_organizacao_id
              and cc.updated_at <= p_cutoff
            order by cc.updated_at asc
            limit p_limit
            for update of cc skip locked
        ),
        reivindicados as (
            insert into public.retention_run_items as rri (run_id, entidade_id, status)
            select p_run_id, cand.v_entidade_id, 'selected'
            from candidatos cand
            on conflict (run_id, entidade_id) do nothing
            returning rri.entidade_id as v_reivindicado_id
        )
        select
            cand.v_entidade_id,
            cand.v_relogio,
            (h.id is not null) as em_legal_hold,
            cand.v_ja_processado
        from candidatos cand
        join reivindicados r on r.v_reivindicado_id = cand.v_entidade_id
        left join public.retention_legal_holds h
            on h.organizacao_id = p_organizacao_id
           and h.categoria = p_categoria
           and h.entidade_id = cand.v_entidade_id
           and h.liberado_em is null;
        return;
    else
        raise exception 'tabela_alvo não suportada pelo seletor de retenção: %', p_tabela_alvo
            using errcode = '22023';
    end if;
end;
$$;

create or replace function public.retencao_aplicar_exclusao(
    p_run_id uuid,
    p_organizacao_id uuid,
    p_categoria text,
    p_tabela_alvo text,
    p_entidade_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_hold_ativo boolean;
    v_linhas int;
begin
    select exists (
        select 1 from public.retention_legal_holds h
        where h.organizacao_id = p_organizacao_id
          and h.categoria = p_categoria
          and h.entidade_id = p_entidade_id
          and h.liberado_em is null
    ) into v_hold_ativo;

    if v_hold_ativo then
        return false;
    end if;

    if p_tabela_alvo = 'chatwoot_contacts' then
        -- Item selecionado antes do MSG-004 (id remoto) não é aplicado: o id se
        -- repete entre instalações. Falha visível; a próxima run seleciona pelo UUID.
        if p_entidade_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
            raise exception 'Exclusao de contato Chatwoot exige o UUID local; item legado deve ser selecionado de novo.'
                using errcode = '22023';
        end if;
        delete from public.chatwoot_contacts
        where id_local = p_entidade_id::uuid
          and organizacao_id = p_organizacao_id;
        get diagnostics v_linhas = row_count;
    else
        raise exception 'tabela_alvo não suportada pela exclusão de retenção: %', p_tabela_alvo
            using errcode = '22023';
    end if;

    -- Zero linhas: já eliminado (idempotente) ou não pertence a esta organização.
    insert into public.retention_tombstones (organizacao_id, categoria, entidade_id, acao, run_id)
    values (p_organizacao_id, p_categoria, p_entidade_id, 'deleted', p_run_id)
    on conflict (organizacao_id, categoria, entidade_id) do nothing;

    return true;
end;
$$;

create or replace function public.retencao_reaplicar_tombstones_restore(p_organizacao_id uuid)
returns table (entidade_id text, categoria text, acao text, reaplicado boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_tomb record;
    v_ainda_existe boolean;
    v_policy record;
    v_candidatos integer;
begin
    for v_tomb in
        select t.entidade_id, t.categoria, t.acao, t.efetivado_em
        from public.retention_tombstones t
        where t.organizacao_id = p_organizacao_id
    loop
        select r.tabela_alvo into v_policy
        from public.retention_policy_registry r
        where r.categoria = v_tomb.categoria
        order by r.versao desc
        limit 1;

        if v_policy.tabela_alvo = 'clientes' then
            select exists (
                select 1 from public.clientes c
                where c.id = v_tomb.entidade_id::uuid
                  and c.organizacao_id = p_organizacao_id
                  and c.anonimizado_em is null
            ) into v_ainda_existe;

            if v_ainda_existe then
                update public.clientes
                set nome = 'Titular anonimizado',
                    cpf_cnpj = null,
                    email = null,
                    telefone = null,
                    telefone_normalizado = null,
                    anonimizado_em = now(),
                    updated_at = now()
                where id = v_tomb.entidade_id::uuid
                  and organizacao_id = p_organizacao_id;
            end if;
        elsif v_policy.tabela_alvo = 'chatwoot_contacts' and v_tomb.entidade_id ~ '^[0-9]+$' then
            -- Tombstone gravado antes do MSG-004 (id remoto). Na época o id era
            -- único na organização; vale só para a linha que já existia quando
            -- ele foi gravado. Uma linha mais nova com o mesmo id é de outra
            -- instalação (ou um contato novo) e não é apagada. Mais de uma
            -- candidata antiga é impossível pelo histórico: aborta, sem palpite.
            select count(*) into v_candidatos
              from public.chatwoot_contacts cc
             where cc.organizacao_id = p_organizacao_id
               and cc.id_externo = v_tomb.entidade_id
               and cc.created_at <= v_tomb.efetivado_em;
            if v_candidatos > 1 then
                raise exception 'Tombstone legado de contato Chatwoot casa % linhas; reaplicacao manual.', v_candidatos
                    using errcode = '23514';
            end if;
            v_ainda_existe := v_candidatos = 1;
            if v_ainda_existe then
                delete from public.chatwoot_contacts cc
                 where cc.organizacao_id = p_organizacao_id
                   and cc.id_externo = v_tomb.entidade_id
                   and cc.created_at <= v_tomb.efetivado_em;
            end if;
        elsif v_policy.tabela_alvo = 'chatwoot_contacts' then
            select exists (
                select 1 from public.chatwoot_contacts cc
                where cc.id_local = v_tomb.entidade_id::uuid
                  and cc.organizacao_id = p_organizacao_id
            ) into v_ainda_existe;

            if v_ainda_existe then
                delete from public.chatwoot_contacts
                where id_local = v_tomb.entidade_id::uuid
                  and organizacao_id = p_organizacao_id;
            end if;
        else
            v_ainda_existe := false;
        end if;

        entidade_id := v_tomb.entidade_id;
        categoria := v_tomb.categoria;
        acao := v_tomb.acao;
        reaplicado := coalesce(v_ainda_existe, false);
        return next;
    end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Integridade da baseline: mensagem × conversa pelo UUID local.
-- ---------------------------------------------------------------------------
create or replace function public.verificar_integridade_baseline()
returns table (verificacao text, tabela text, infracoes bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
    return query
    select 'user_id nulo'::text, 'pedidos'::text, count(*) from public.pedidos where user_id is null
    union all
    select 'user_id nulo'::text, 'itens_pedido'::text, count(*) from public.itens_pedido where user_id is null
    union all
    select 'user_id nulo'::text, 'clientes'::text, count(*) from public.clientes where user_id is null
    union all
    select 'user_id nulo'::text, 'produtos'::text, count(*) from public.produtos where user_id is null
    union all
    select 'user_id nulo'::text, 'fornecedores'::text, count(*) from public.fornecedores where user_id is null
    union all
    select 'user_id nulo'::text, 'titulos_financeiros'::text, count(*) from public.titulos_financeiros where user_id is null
    union all
    select 'user_id nulo'::text, 'categorias_financeiras'::text, count(*) from public.categorias_financeiras where user_id is null
    union all
    select 'user_id nulo'::text, 'contas_financeiras'::text, count(*) from public.contas_financeiras where user_id is null
    union all
    select 'user_id nulo'::text, 'documentos_fiscais'::text, count(*) from public.documentos_fiscais where user_id is null
    union all
    select 'user_id nulo'::text, 'movimentacao_estoque'::text, count(*) from public.movimentacao_estoque where user_id is null
    union all
    select 'user_id nulo'::text, 'chatwoot_conversations'::text, count(*) from public.chatwoot_conversations where user_id is null
    union all
    select 'user_id nulo'::text, 'chatwoot_messages'::text, count(*) from public.chatwoot_messages where user_id is null;

    return query
    select 'cross-tenant FK'::text, 'titulos_financeiros -> fornecedores'::text, count(*)
    from public.titulos_financeiros t
    join public.fornecedores f on t.fornecedor_id = f.id
    where t.user_id <> f.user_id
    union all
    select 'cross-tenant FK'::text, 'titulos_financeiros -> categorias_financeiras'::text, count(*)
    from public.titulos_financeiros t
    join public.categorias_financeiras c on t.categoria_id = c.id
    where t.user_id <> c.user_id
    union all
    select 'cross-tenant FK'::text, 'titulos_financeiros -> contas_financeiras'::text, count(*)
    from public.titulos_financeiros t
    join public.contas_financeiras c on t.conta_financeira_id = c.id
    where t.user_id <> c.user_id
    union all
    select 'cross-tenant FK'::text, 'itens_pedido -> pedidos'::text, count(*)
    from public.itens_pedido i
    join public.pedidos p on i.pedido_id = p.id
    where i.user_id <> p.user_id
    union all
    select 'cross-tenant FK'::text, 'documentos_fiscais -> pedidos'::text, count(*)
    from public.documentos_fiscais d
    join public.pedidos p on d.pedido_id = p.id
    where d.user_id <> p.user_id
    union all
    select 'cross-tenant FK'::text, 'chatwoot_messages -> chatwoot_conversations'::text, count(*)
    from public.chatwoot_messages m
    join public.chatwoot_conversations c on m.conversa_id_local = c.id_local
    where m.user_id <> c.user_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privilégios das funções novas ou recriadas (o `create or replace` mantém os
-- grants; `create` nasce com EXECUTE para PUBLIC).
-- ---------------------------------------------------------------------------
revoke all on function public.chatwoot_conexao_unica(uuid) from public, anon, authenticated;
revoke all on function public.chatwoot_conexao_do_inbox(uuid, integer) from public, anon, authenticated;
revoke all on function public.chatwoot_conexao_do_contato(uuid, uuid) from public, anon, authenticated;
revoke all on function public.chatwoot_conexao_da_conversa(uuid, integer, uuid) from public, anon, authenticated;
revoke all on function public.chatwoot_conexao_da_mensagem(uuid, uuid) from public, anon, authenticated;
grant execute on function public.chatwoot_conexao_unica(uuid) to service_role;
grant execute on function public.chatwoot_conexao_do_inbox(uuid, integer) to service_role;
grant execute on function public.chatwoot_conexao_do_contato(uuid, uuid) to service_role;
grant execute on function public.chatwoot_conexao_da_conversa(uuid, integer, uuid) to service_role;
grant execute on function public.chatwoot_conexao_da_mensagem(uuid, uuid) to service_role;
-- As recriadas já são só do servidor na cadeia; repetido para não depender disso.
revoke all on function public.registrar_evento_inbox_chatwoot(uuid, uuid, uuid, bigint, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.retencao_marcar_legal_hold(uuid, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.retencao_selecionar_e_reivindicar_lote_impl(uuid, uuid, text, text, timestamptz, integer)
    from public, anon, authenticated;
revoke all on function public.retencao_aplicar_exclusao(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.retencao_reaplicar_tombstones_restore(uuid) from public, anon, authenticated;
revoke all on function public.verificar_integridade_baseline() from public, anon, authenticated;
grant execute on function public.registrar_evento_inbox_chatwoot(uuid, uuid, uuid, bigint, text, text, jsonb) to service_role;
grant execute on function public.retencao_marcar_legal_hold(uuid, text, text, text, uuid) to service_role;
grant execute on function public.retencao_selecionar_e_reivindicar_lote_impl(uuid, uuid, text, text, timestamptz, integer)
    to service_role;
grant execute on function public.retencao_aplicar_exclusao(uuid, uuid, text, text, text) to service_role;
grant execute on function public.retencao_reaplicar_tombstones_restore(uuid) to service_role;
grant execute on function public.verificar_integridade_baseline() to service_role;

-- ---------------------------------------------------------------------------
-- Autoverificação: aborta se o conteúdo mudou, se sobrou chave ou vínculo pelo
-- id remoto, se um vínculo atravessa organização, se o navegador ganhou escrita
-- ou execução, ou se um gatilho faltar.
-- ---------------------------------------------------------------------------
do $$
declare
    v_texto text;
begin
    select string_agg(r.tabela, ', ') into v_texto
      from msg004_retrato r
      join (select 'chatwoot_contacts'::text as tabela, count(*) as linhas,
                   md5(coalesce(string_agg(row(c.id_local, c.id_externo, c.organizacao_id, c.conexao_id, c.name, c.email,
                                               c.phone_number, c.updated_at)::text, '|' order by c.id_local), '')) as digest
              from public.chatwoot_contacts c
            union all
            select 'chatwoot_conversations', count(*),
                   md5(coalesce(string_agg(row(v.id_local, v.id_externo, v.organizacao_id, v.conexao_id, v.contato_id_local,
                                               v.status, v.updated_at)::text, '|' order by v.id_local), ''))
              from public.chatwoot_conversations v
            union all
            select 'chatwoot_messages', count(*),
                   md5(coalesce(string_agg(row(m.id_local, m.id_externo, m.organizacao_id, m.conexao_id, m.conversa_id_local,
                                               m.content, m.updated_at)::text, '|' order by m.id_local), ''))
              from public.chatwoot_messages m) agora on agora.tabela = r.tabela
     where agora.linhas <> r.linhas or agora.digest <> r.digest;
    if v_texto is not null then
        raise exception 'MSG-004: a contracao mudou linhas em %', v_texto;
    end if;

    -- PK pelo UUID local; nenhuma constraint ou índice único usa o id remoto
    -- fora de organização + conexão.
    select string_agg(t.tabela, ', ') into v_texto
      from (values ('public.chatwoot_contacts'), ('public.chatwoot_conversations'), ('public.chatwoot_messages')) t(tabela)
     where not exists (select 1 from pg_constraint k
                        join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
                       where k.conrelid = t.tabela::regclass and k.contype = 'p'
                         and cardinality(k.conkey) = 1 and a.attname = 'id_local');
    if v_texto is not null then
        raise exception 'MSG-004: PK fora do id_local em %', v_texto;
    end if;

    select string_agg(i.indexrelid::regclass::text, ', ') into v_texto
      from pg_index i
     where i.indisunique
       and i.indrelid in ('public.chatwoot_contacts'::regclass, 'public.chatwoot_conversations'::regclass,
                          'public.chatwoot_messages'::regclass)
       and exists (select 1 from unnest(i.indkey) k(attnum)
                    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
                   where a.attname in ('id', 'id_externo', 'contact_id', 'conversation_id'))
       and not (pg_get_indexdef(i.indexrelid) like '%(organizacao_id, conexao_id, id_externo) NULLS NOT DISTINCT');
    if v_texto is not null then
        raise exception 'MSG-004: indice unico pelo id remoto sem organizacao + conexao: %', v_texto;
    end if;

    select string_agg(k.conname, ', ') into v_texto
      from pg_constraint k
     where k.contype = 'f'
       and k.confrelid in ('public.chatwoot_contacts'::regclass, 'public.chatwoot_conversations'::regclass)
       and k.conname not in ('fk_chatwoot_conversations_contato_local', 'fk_chatwoot_messages_conversa_local');
    if v_texto is not null then
        raise exception 'MSG-004: FK pelo id remoto ainda existe: %', v_texto;
    end if;

    select count(*)::text into v_texto
      from pg_index i
     where i.indrelid = 'public.chatwoot_inboxes'::regclass and i.indisunique
       and pg_get_indexdef(i.indexrelid) like '%(organizacao_id, inbox_id)%';
    if v_texto <> '0' then
        raise exception 'MSG-004: chatwoot_inboxes ainda e unico por organizacao + inbox';
    end if;
    select count(*)::text into v_texto
      from pg_index i
     where i.indrelid = 'public.inbox_eventos_chatwoot'::regclass and i.indisunique
       and pg_get_indexdef(i.indexrelid) like '%(organizacao_id, idempotency_key)%';
    if v_texto <> '0' then
        raise exception 'MSG-004: dedup de eventos ainda ignora a conexao';
    end if;

    -- Nenhum vínculo local atravessa organização (as FKs compostas garantem;
    -- conferido para não depender só delas).
    select ((select count(*) from public.chatwoot_conversations v
               join public.chatwoot_contacts c on c.id_local = v.contato_id_local
              where c.organizacao_id is distinct from v.organizacao_id)
          + (select count(*) from public.chatwoot_messages m
               join public.chatwoot_conversations v on v.id_local = m.conversa_id_local
              where v.organizacao_id is distinct from m.organizacao_id))::text
      into v_texto;
    if v_texto <> '0' then
        raise exception 'MSG-004: % vinculo(s) local(is) atravessam organizacao', v_texto;
    end if;

    select string_agg(t.tabela || ':' || r.rolname, ', ') into v_texto
      from (values ('public.chatwoot_contacts'), ('public.chatwoot_conversations'), ('public.chatwoot_messages'),
                   ('public.chatwoot_inboxes'), ('public.inbox_eventos_chatwoot')) as t(tabela)
     cross join (values ('authenticated'), ('anon')) as r(rolname)
     where has_table_privilege(r.rolname, t.tabela, 'INSERT')
        or has_table_privilege(r.rolname, t.tabela, 'UPDATE')
        or has_table_privilege(r.rolname, t.tabela, 'DELETE')
        or has_table_privilege(r.rolname, t.tabela, 'TRUNCATE');
    if v_texto is not null then
        raise exception 'MSG-004: o navegador escreve em %', v_texto;
    end if;

    select p.oid::regprocedure::text into v_texto
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('chatwoot_conexao_unica', 'chatwoot_conexao_do_inbox', 'chatwoot_conexao_do_contato',
                         'chatwoot_conexao_da_conversa', 'chatwoot_conexao_da_mensagem', 'chatwoot_contato_local',
                         'chatwoot_conversa_local', 'fn_vincula_identidade_local_chatwoot',
                         'backfill_identidade_local_chatwoot', 'registrar_evento_inbox_chatwoot',
                         'retencao_marcar_legal_hold', 'retencao_selecionar_e_reivindicar_lote_impl',
                         'retencao_aplicar_exclusao', 'retencao_reaplicar_tombstones_restore',
                         'verificar_integridade_baseline')
       and (has_function_privilege('authenticated', p.oid, 'execute')
            or has_function_privilege('anon', p.oid, 'execute'))
     limit 1;
    if v_texto is not null then
        raise exception 'MSG-004: o navegador executa %', v_texto;
    end if;

    select t.tgname into v_texto
      from (values ('public.chatwoot_contacts', 'trg_vincula_identidade_local_chatwoot'),
                   ('public.chatwoot_conversations', 'trg_vincula_identidade_local_chatwoot'),
                   ('public.chatwoot_messages', 'trg_vincula_identidade_local_chatwoot'),
                   ('public.chatwoot_conversations', 'trg_sync_chatwoot_conversations_organizacao'),
                   ('public.chatwoot_messages', 'trg_sync_chatwoot_messages_organizacao'),
                   ('public.chatwoot_contacts', 'trg_organizacao_do_chatwoot_contato_imutavel'),
                   ('public.chatwoot_conversations', 'trg_organizacao_da_chatwoot_conversa_imutavel'),
                   ('public.chatwoot_messages', 'trg_organizacao_da_chatwoot_mensagem_imutavel')) as t(tabela, tgname)
     where not exists (select 1 from pg_trigger g
                        where g.tgrelid = t.tabela::regclass and g.tgname = t.tgname and g.tgenabled = 'O')
     limit 1;
    if v_texto is not null then
        raise exception 'MSG-004: gatilho % ausente ou desligado', v_texto;
    end if;

    raise notice 'MSG-004: chaves globais contraidas; quarentena (sem conexao): %',
        coalesce((select string_agg(q.tabela || '=' || q.n, ', ' order by q.tabela)
                    from (select tabela, count(*) as n from public.chatwoot_identidade_em_quarentena group by 1) q), 'vazia');
end;
$$;

notify pgrst, 'reload schema';
