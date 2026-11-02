-- CORTE S88 (MSG-004): este é o pgTAP final da migration 85, sem alteração, e
-- afirma a fase expand (PK legada `id`, upsert por `on conflict (id)`, sync
-- sem conexão aceito). Roda com o ledger cortado na ordem 88; com a 87 (ordem
-- 90) aplicada ele falha por desenho. O estado depois da contração está em
-- supabase/tests/final/identidade_local_chatwoot.test.sql e
-- chaves_globais_chatwoot.test.sql. Comando: docs/operations/msg-004-runbook.md §10.
--
-- identidade_local_chatwoot.test.sql
-- MSG-002, contra o schema canônico completo (migration 85).
--
-- Duas instalações do Chatwoot numeram contatos, conversas e mensagens a partir
-- do mesmo id. No ORBITA: cada linha ganha um UUID local que não muda, a
-- identidade remota é única por organização + conexão, um vínculo local nunca
-- atravessa organização nem conexão, e a escrita legada (o webhook e o sync de
-- hoje) continua funcionando e preenche o modelo novo sozinha. Enquanto a PK
-- legada existir (até o MSG-004), o id remoto repetido é recusado em vez de
-- mover a linha de uma organização ou instalação para outra; sem ela (simulado
-- em 37-44), as duas instalações coexistem pelas chaves novas.
--
-- REINTRODUZIR O DEFEITO (contraprovas executadas aqui, em savepoints):
--   drop trigger trg_organizacao_do_chatwoot_contato_imutavel  → 33: B toma o contato 5 de A
--   drop constraint fk_chatwoot_conversations_contato_local    → 34: conversa de A liga no contato de B
--   resolver de vínculo sem o filtro de conexão                → 35-36: a instalação 2 liga no contato da 1
--   drop index uq_chatwoot_contacts_identidade_remota          → 44: a mesma identidade remota duas vezes

begin;

select plan(50);

insert into auth.users (id, email) values
    ('e2000000-0000-4000-8000-0000000000a1', 'dono-a-m2@orbita.test'),
    ('e2000000-0000-4000-8000-0000000000b1', 'dono-b-m2@orbita.test');
insert into public.organizacoes (id, nome, slug, status) values
    ('e2000000-0000-4000-8000-00000000000a', 'Org A M2', 'org-a-m2', 'active'),
    ('e2000000-0000-4000-8000-00000000000b', 'Org B M2', 'org-b-m2', 'active');
insert into public.membros_organizacao (organizacao_id, user_id, papel) values
    ('e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000a1', 'owner'),
    ('e2000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-0000000000b1', 'owner');
-- c1 e c2: duas instalações do Chatwoot na organização A. c3: a de B. c4: Bling de A.
insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status) values
    ('e2000000-0000-4000-8000-0000000000c1', 'e2000000-0000-4000-8000-00000000000a', 'chatwoot', 'Principal', 'conectado'),
    ('e2000000-0000-4000-8000-0000000000c2', 'e2000000-0000-4000-8000-00000000000a', 'chatwoot', 'Segunda', 'conectado'),
    ('e2000000-0000-4000-8000-0000000000c3', 'e2000000-0000-4000-8000-00000000000b', 'chatwoot', 'Principal', 'conectado'),
    ('e2000000-0000-4000-8000-0000000000c4', 'e2000000-0000-4000-8000-00000000000a', 'bling', 'Principal', 'conectado');
-- A e B expõem o inbox 1; o mapeamento é por organização.
insert into public.chatwoot_inboxes (organizacao_id, conexao_id, inbox_id, account_id) values
    ('e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c1', 1, '1'),
    ('e2000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-0000000000c3', 1, '1');

-- Veneno para a falha no meio do lote (26-27): só dispara com a marca abaixo.
create function public.msg002_veneno_de_lote() returns trigger language plpgsql set search_path = '' as $f$
begin
    if current_setting('msg002.veneno', true) = 'on' and new.id = 10 then
        raise exception 'falha injetada no meio do lote' using errcode = 'XX000';
    end if;
    return new;
end $f$;
create trigger zz_msg002_veneno_de_lote before update on public.chatwoot_contacts
    for each row execute function public.msg002_veneno_de_lote();

-- O servidor grava. Daqui em diante é o `service_role`, como nas rotas.
set local role service_role;

-- c1 recebe pelo webhook: contato 5, conversa 50, mensagem 500. c3 (B): 7, 70, 700.
insert into public.chatwoot_contacts (id, organizacao_id, conexao_id, name) values
    (5, 'e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c1', 'Contato A'),
    (7, 'e2000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-0000000000c3', 'Contato B');
insert into public.chatwoot_conversations (id, organizacao_id, conexao_id, contact_id, status, inbox_id) values
    (50, 'e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c1', 5, 'open', 1),
    (70, 'e2000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-0000000000c3', 7, 'open', 1);
insert into public.chatwoot_messages (id, organizacao_id, conexao_id, conversation_id, content) values
    (500, 'e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c1', 50, 'mensagem de A'),
    (700, 'e2000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-0000000000c3', 70, 'mensagem de B');

create temp table retrato as
select (select row(c.*)::text from public.chatwoot_contacts c where c.id = 5) as contato_a,
       (select id_local from public.chatwoot_contacts where id = 5) as contato_a_local,
       (select id_local from public.chatwoot_contacts where id = 7) as contato_b_local,
       (select id_local from public.chatwoot_messages where id = 500) as mensagem_a_local;

-- ----------------------------------------------------------------------------
-- 1-6. O modelo expandido nasce preenchido pela escrita legada.
-- ----------------------------------------------------------------------------
select is((select count(*)::int from public.chatwoot_contacts where id in (5, 7) and id_local is not null), 2,
          '1. contato legado ganha UUID local no INSERT');
select is((select id_externo from public.chatwoot_messages where id = 500), '500',
          '2. id_externo é o id do Chatwoot como texto');
select is((select contato_id_local from public.chatwoot_conversations where id = 50),
          (select contato_a_local from retrato), '3. conversa liga ao UUID local do seu contato');
select is((select conversa_id_local from public.chatwoot_messages where id = 500),
          (select id_local from public.chatwoot_conversations where id = 50), '4. mensagem liga ao UUID local da sua conversa');
select is((select count(*)::int from public.chatwoot_identidade_em_quarentena), 0,
          '5. escrita com conexão verificada não deixa nada em quarentena');
select is((select count(distinct id_local)::int from (select id_local from public.chatwoot_contacts
                                                       union all select id_local from public.chatwoot_conversations
                                                       union all select id_local from public.chatwoot_messages) u), 6,
          '6. seis linhas, seis UUIDs distintos');

-- ----------------------------------------------------------------------------
-- 7-12. Colisão de id remoto com a PK legada: a outra instalação é recusada e
-- a linha existente não muda.
-- ----------------------------------------------------------------------------
select throws_ok(
    $$insert into public.chatwoot_contacts (id, organizacao_id, conexao_id, name)
      values (5, 'e2000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-0000000000c3', 'Contato B com id de A')
      on conflict (id) do update set organizacao_id = excluded.organizacao_id, conexao_id = excluded.conexao_id, name = excluded.name$$,
    '23514', null, '7. upsert do contato 5 vindo de B não move o contato 5 de A');
select throws_ok(
    $$insert into public.chatwoot_contacts (id, organizacao_id, conexao_id, name)
      values (5, 'e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c2', 'Contato da segunda instalação')
      on conflict (id) do update set organizacao_id = excluded.organizacao_id, conexao_id = excluded.conexao_id, name = excluded.name$$,
    '23514', null, '8. upsert do contato 5 vindo da segunda instalação de A não troca a conexão');
select throws_ok(
    $$insert into public.chatwoot_conversations (id, organizacao_id, conexao_id, contact_id, status)
      values (51, 'e2000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-0000000000c3', 5, 'open')$$,
    '23503', null, '9. conversa de B não aponta para o contato 5 de A');
select throws_ok(
    $$insert into public.chatwoot_conversations (id, organizacao_id, conexao_id, contact_id, status)
      values (52, 'e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c2', 5, 'open')$$,
    '23503', 'O contato da conversa e de outra conexao Chatwoot ou e ambiguo.',
    '10. conversa da segunda instalação não liga no contato 5 da primeira');
select throws_ok(
    $$insert into public.chatwoot_messages (id, organizacao_id, conexao_id, conversation_id, content)
      values (501, 'e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c2', 50, 'x')$$,
    '23503', 'A conversa da mensagem e de outra conexao Chatwoot ou e ambigua.',
    '11. mensagem da segunda instalação não entra na conversa 50 da primeira');
select is((select row(c.*)::text from public.chatwoot_contacts c where c.id = 5), (select contato_a from retrato),
          '12. o contato 5 de A ficou intacto depois das recusas');

-- ----------------------------------------------------------------------------
-- 13-18. Conexão errada e vínculo forjado.
-- ----------------------------------------------------------------------------
select throws_ok(
    $$insert into public.chatwoot_contacts (id, organizacao_id, conexao_id, name)
      values (6, 'e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c3', 'x')$$,
    '23503', 'Espelho Chatwoot so aponta para conexao Chatwoot da mesma organizacao.',
    '13. contato de A não aponta para a conexão de B');
select throws_ok(
    $$insert into public.chatwoot_contacts (id, organizacao_id, conexao_id, name)
      values (6, 'e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c4', 'x')$$,
    '23503', 'Espelho Chatwoot so aponta para conexao Chatwoot da mesma organizacao.',
    '14. contato não aponta para conexão Bling');
select throws_ok(
    format($$update public.chatwoot_conversations set contato_id_local = %L where id = 50$$, (select contato_b_local from retrato)),
    '23503', null, '15. conversa de A não recebe o UUID do contato de B (FK composta)');
select throws_ok(
    $$update public.chatwoot_conversations set organizacao_id = 'e2000000-0000-4000-8000-00000000000b' where id = 50$$,
    '23514', null, '16. conversa não muda de organização');
select throws_ok(
    $$update public.chatwoot_messages set id_local = gen_random_uuid() where id = 500$$,
    '23514', null, '17. UUID local não muda');
select throws_ok(
    $$update public.chatwoot_messages set conexao_id = 'e2000000-0000-4000-8000-0000000000c2' where id = 500$$,
    '23514', null, '18. mensagem não troca de instalação');

-- ----------------------------------------------------------------------------
-- 19-20. Reprocessamento: o replay do webhook não duplica nem troca o UUID.
-- ----------------------------------------------------------------------------
insert into public.chatwoot_messages (id, organizacao_id, conexao_id, conversation_id, content, updated_at)
values (500, 'e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c1', 50, 'mensagem de A', now())
on conflict (id) do update set organizacao_id = excluded.organizacao_id, conexao_id = excluded.conexao_id,
    conversation_id = excluded.conversation_id, content = excluded.content, updated_at = excluded.updated_at;
select is((select count(*)::int from public.chatwoot_messages where organizacao_id = 'e2000000-0000-4000-8000-00000000000a'), 1,
          '19. replay da mensagem 500 não duplica');
select is((select id_local from public.chatwoot_messages where id = 500), (select mensagem_a_local from retrato),
          '20. replay mantém o UUID local');

-- ----------------------------------------------------------------------------
-- 21-25. O sync de hoje não informa a conexão. Conversa e mensagem a provam
-- pelo inbox; o contato fica em quarentena até o backfill achar a prova, que
-- não reinicia o `updated_at`.
-- ----------------------------------------------------------------------------
insert into public.chatwoot_contacts (id, organizacao_id, name, updated_at)
values (8, 'e2000000-0000-4000-8000-00000000000a', 'Contato do sync', '2026-01-01 00:00:00+00');
insert into public.chatwoot_conversations (id, organizacao_id, contact_id, status, inbox_id)
values (80, 'e2000000-0000-4000-8000-00000000000a', 8, 'open', 1);
insert into public.chatwoot_messages (id, organizacao_id, conversation_id, content)
values (800, 'e2000000-0000-4000-8000-00000000000a', 80, 'pelo sync');

select results_eq(
    $$select v.conexao_id, m.conexao_id, v.contato_id_local = c.id_local
        from public.chatwoot_conversations v
        join public.chatwoot_messages m on m.conversation_id = v.id
        join public.chatwoot_contacts c on c.id = v.contact_id
       where v.id = 80$$,
    $$values ('e2000000-0000-4000-8000-0000000000c1'::uuid, 'e2000000-0000-4000-8000-0000000000c1'::uuid, true)$$,
    '21. conversa e mensagem do sync provam a conexão pelo inbox e se ligam');
select results_eq(
    $$select tabela, motivo from public.chatwoot_identidade_em_quarentena$$,
    $$values ('chatwoot_contacts'::text, 'conexao_nao_comprovada'::text)$$,
    '22. o contato sem conexão fica em quarentena, legível');
select results_eq(
    $$select tabela, atualizadas, pendentes from public.backfill_identidade_local_chatwoot(100)$$,
    $$values ('chatwoot_contacts'::text, 1, 0::bigint), ('chatwoot_conversations', 0, 0), ('chatwoot_messages', 0, 0)$$,
    '23. o backfill resolve só o contato que agora tem prova');
select results_eq(
    $$select conexao_id, updated_at from public.chatwoot_contacts where id = 8$$,
    $$values ('e2000000-0000-4000-8000-0000000000c1'::uuid, '2026-01-01 00:00:00+00'::timestamptz)$$,
    '24. contato ganha a conexão das suas conversas sem trocar o updated_at');
select is((select sum(atualizadas)::int from public.backfill_identidade_local_chatwoot(100)), 0,
          '25. rodar de novo não faz nada (idempotente)');

-- ----------------------------------------------------------------------------
-- 26-30. Falha no meio de um lote desfaz o lote; o backfill parcial retoma de
-- onde parou.
-- ----------------------------------------------------------------------------
insert into public.chatwoot_contacts (id, organizacao_id, name) values
    (9, 'e2000000-0000-4000-8000-00000000000a', 'Sync 9'),
    (10, 'e2000000-0000-4000-8000-00000000000a', 'Sync 10'),
    (11, 'e2000000-0000-4000-8000-00000000000a', 'Sync 11');
insert into public.chatwoot_conversations (id, organizacao_id, contact_id, status, inbox_id) values
    (90, 'e2000000-0000-4000-8000-00000000000a', 9, 'open', 1),
    (100, 'e2000000-0000-4000-8000-00000000000a', 10, 'open', 1),
    (110, 'e2000000-0000-4000-8000-00000000000a', 11, 'open', 1);

set local msg002.veneno = 'on';
select throws_ok($$select * from public.backfill_identidade_local_chatwoot(2)$$,
                 'XX000', 'falha injetada no meio do lote', '26. a falha no contato 10 aborta o lote');
select is((select count(*)::int from public.chatwoot_contacts where id in (9, 10, 11) and conexao_id is null), 3,
          '27. o contato 9, do mesmo lote, voltou atrás');
set local msg002.veneno = 'off';
select is((select atualizadas from public.backfill_identidade_local_chatwoot(2) where tabela = 'chatwoot_contacts'), 2,
          '28. lote de 2 processa 9 e 10');
select is((select array_agg(id order by id) from public.chatwoot_contacts where conexao_id is null), array[11],
          '29. o 11 continua pendente: backfill parcial');
select is((select atualizadas from public.backfill_identidade_local_chatwoot(2) where tabela = 'chatwoot_contacts'), 1,
          '30. a chamada seguinte retoma e termina');

-- ----------------------------------------------------------------------------
-- 31-32. O navegador: lê só a própria organização e não escreve.
-- ----------------------------------------------------------------------------
reset role;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'e2000000-0000-4000-8000-0000000000b1';
select results_eq(
    $$select id_externo from public.chatwoot_messages$$,
    $$values ('700'::text)$$,
    '31. owner de B lê só a mensagem de B');
select throws_ok(
    $$insert into public.chatwoot_messages (id, organizacao_id, conversation_id, content)
      values (701, 'e2000000-0000-4000-8000-00000000000b', 70, 'do navegador')$$,
    '42501', 'permission denied for table chatwoot_messages', '32. o navegador não grava no espelho');
reset role;

-- ----------------------------------------------------------------------------
-- 33-36. Contraprovas: sem cada defesa, o ataque passa.
-- ----------------------------------------------------------------------------
-- O contato 12 de A ainda não tem conversa: com conversa, a FK composta
-- também recusaria a troca (defesa em profundidade).
savepoint contraprova;
insert into public.chatwoot_contacts (id, organizacao_id, conexao_id, name)
values (12, 'e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c1', 'Contato A 12');
drop trigger trg_organizacao_do_chatwoot_contato_imutavel on public.chatwoot_contacts;
insert into public.chatwoot_contacts (id, organizacao_id, conexao_id, name)
values (12, 'e2000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-0000000000c3', 'Contato B com id de A')
on conflict (id) do update set organizacao_id = excluded.organizacao_id, conexao_id = null, name = excluded.name;
select is((select organizacao_id from public.chatwoot_contacts where id = 12), 'e2000000-0000-4000-8000-00000000000b'::uuid,
          '33. CONTRAPROVA: sem a organização imutável, B toma o contato 12 de A');
rollback to savepoint contraprova;

alter table public.chatwoot_conversations drop constraint fk_chatwoot_conversations_contato_local;
update public.chatwoot_conversations set contato_id_local = (select contato_b_local from retrato) where id = 50;
select is((select contato_id_local from public.chatwoot_conversations where id = 50), (select contato_b_local from retrato),
          '34. CONTRAPROVA: sem a FK composta, a conversa de A liga no contato de B');
rollback to savepoint contraprova;

create or replace function public.chatwoot_contato_local(p_organizacao_id uuid, p_conexao_id uuid, p_contact_id integer)
returns uuid language sql stable security invoker set search_path = '' as $f$
    select c.id_local from public.chatwoot_contacts c
     where c.id = p_contact_id and c.organizacao_id = p_organizacao_id;
$f$;
set local role service_role;
insert into public.chatwoot_conversations (id, organizacao_id, conexao_id, contact_id, status)
values (52, 'e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c2', 5, 'open');
select is((select contato_id_local from public.chatwoot_conversations where id = 52), (select contato_a_local from retrato),
          '35. CONTRAPROVA: sem o filtro de conexão, a conversa da instalação 2 liga no contato da 1');
select isnt_empty($$select 1 from public.chatwoot_identidade_em_quarentena where motivo = 'conexao_divergente_do_contato'$$,
          '36. e a quarentena acusa a divergência que o filtro teria impedido');
reset role;
rollback to savepoint contraprova;
release savepoint contraprova;

-- ----------------------------------------------------------------------------
-- 37-44. PROVA PRIORITÁRIA no modelo novo. Simula a contração do MSG-004 (sem
-- PK nem FK legadas por id e sem o gatilho legado que procura o pai só pelo
-- id): três instalações com os mesmos ids 5/50/500 coexistem e não se misturam.
-- ----------------------------------------------------------------------------
savepoint pos_contracao;
alter table public.chatwoot_messages drop constraint chatwoot_messages_conversation_id_fkey;
alter table public.chatwoot_conversations drop constraint chatwoot_conversations_contact_id_fkey;
alter table public.chatwoot_contacts drop constraint chatwoot_contacts_pkey cascade;
alter table public.chatwoot_conversations drop constraint chatwoot_conversations_pkey cascade;
alter table public.chatwoot_messages drop constraint chatwoot_messages_pkey cascade;
-- (organizacao_id, id) também é chave legada: impede duas instalações na mesma
-- organização. O MSG-004 contrai junto com a PK.
drop index public.uq_chatwoot_contacts_org_id;
drop index public.uq_chatwoot_conversations_org_id;
drop index public.uq_chatwoot_messages_org_id;
alter table public.chatwoot_conversations disable trigger trg_sync_chatwoot_conversations_organizacao;
alter table public.chatwoot_messages disable trigger trg_sync_chatwoot_messages_organizacao;
-- Os planos em cache das funções de vínculo citam os índices removidos.
discard plans;

set local role service_role;
insert into public.chatwoot_contacts (id, organizacao_id, conexao_id, name) values
    (5, 'e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c2', 'Contato A2'),
    (5, 'e2000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-0000000000c3', 'Contato B 5');
insert into public.chatwoot_conversations (id, organizacao_id, conexao_id, contact_id, status) values
    (50, 'e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c2', 5, 'open'),
    (50, 'e2000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-0000000000c3', 5, 'open');
insert into public.chatwoot_messages (id, organizacao_id, conexao_id, conversation_id, content) values
    (500, 'e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c2', 50, 'mensagem de A2'),
    (500, 'e2000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-0000000000c3', 50, 'mensagem de B 500');

select is((select count(distinct id_local)::int from public.chatwoot_contacts where id_externo = '5'), 3,
          '37. três contatos 5 (A1, A2, B), três UUIDs locais');
select is((select count(*)::int
             from public.chatwoot_messages m
             join public.chatwoot_conversations v on v.id_local = m.conversa_id_local
             join public.chatwoot_contacts c on c.id_local = v.contato_id_local
            where m.id_externo = '500'
              and m.conexao_id = v.conexao_id and v.conexao_id = c.conexao_id
              and m.organizacao_id = c.organizacao_id), 3,
          '38. cada mensagem 500 chega ao contato 5 da sua própria instalação');
select is((select content from public.chatwoot_messages where id_local = (select mensagem_a_local from retrato)), 'mensagem de A',
          '39. a mensagem 500 de A1 continua a de A1');
select throws_ok(
    $$insert into public.chatwoot_contacts (id, organizacao_id, conexao_id, name)
      values (5, 'e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c1', 'duplicado')$$,
    '23505', null, '40. a mesma identidade remota não entra duas vezes na mesma conexão');
select throws_ok(
    $$insert into public.chatwoot_messages (id, organizacao_id, conexao_id, conversation_id, content)
      values (501, 'e2000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-0000000000c3', 999, 'orfã')$$,
    '23503', null, '41. mensagem sem conversa na sua conexão é recusada, não ligada a outra');
reset role;

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'e2000000-0000-4000-8000-0000000000b1';
select results_eq($$select content from public.chatwoot_messages where id_externo = '500'$$,
                  $$values ('mensagem de B 500'::text)$$, '42. owner de B lê só a sua mensagem 500');
set local request.jwt.claim.sub = 'e2000000-0000-4000-8000-0000000000a1';
select results_eq($$select content from public.chatwoot_messages where id_externo = '500' order by content$$,
                  $$values ('mensagem de A'::text), ('mensagem de A2')$$, '43. owner de A lê as duas de A, nenhuma de B');
reset role;

drop index public.uq_chatwoot_contacts_identidade_remota;
insert into public.chatwoot_contacts (id, organizacao_id, conexao_id, name)
values (5, 'e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c1', 'duplicado');
select is((select count(*)::int from public.chatwoot_contacts
            where organizacao_id = 'e2000000-0000-4000-8000-00000000000a'
              and conexao_id = 'e2000000-0000-4000-8000-0000000000c1' and id_externo = '5'), 2,
          '44. CONTRAPROVA: sem a chave composta, a identidade remota duplica');
rollback to savepoint pos_contracao;

-- ----------------------------------------------------------------------------
-- 45-50. Catálogo: o modelo existe como desenhado e só o servidor o opera.
-- ----------------------------------------------------------------------------
select col_not_null('public', 'chatwoot_messages', 'id_local', '45. id_local é NOT NULL');
select fk_ok('public', 'chatwoot_messages', array['organizacao_id', 'conversa_id_local'],
             'public', 'chatwoot_conversations', array['organizacao_id', 'id_local'],
             '46. FK composta mensagem → conversa pela organização');
select is(has_function_privilege('authenticated', 'public.backfill_identidade_local_chatwoot(integer)', 'execute'), false,
          '47. o navegador não roda o backfill');
select is(has_table_privilege('authenticated', 'public.chatwoot_identidade_em_quarentena', 'select'), false,
          '48. o navegador não lê a quarentena');
select is(has_function_privilege('service_role', 'public.backfill_identidade_local_chatwoot(integer)', 'execute'), true,
          '49. o servidor roda o backfill');
select throws_ok($$select * from public.backfill_identidade_local_chatwoot(0)$$, '22023', null,
                 '50. lote fora de 1..10000 é recusado');

select * from finish();
rollback;
