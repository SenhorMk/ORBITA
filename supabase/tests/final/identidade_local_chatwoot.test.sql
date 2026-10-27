-- identidade_local_chatwoot.test.sql
-- MSG-002 (identidade local) e MSG-004 (contração), contra o schema canônico
-- completo.
--
-- Duas instalações do Chatwoot numeram contatos, conversas e mensagens a partir
-- do mesmo id. No ORBITA: cada linha tem um UUID local que não muda e é a PK, a
-- identidade remota é única por organização + conexão, um vínculo local nunca
-- atravessa organização nem conexão. Depois do MSG-004 o id remoto repetido
-- coexiste em outra organização ou instalação (7-11, 37-43) em vez de ser
-- recusado, e linha nova sem conexão provada é recusada (21-25): não nasce mais
-- quarentena. Linhas legadas (anteriores ao MSG-004) são fabricadas com o
-- gatilho desligado para provar o backfill (26-30).
--
-- REINTRODUZIR O DEFEITO (contraprovas executadas aqui, em savepoints):
--   drop trigger trg_organizacao_do_chatwoot_contato_imutavel  → 33: B toma o contato 12 de A
--   drop constraint fk_chatwoot_conversations_contato_local
--     + gatilho trg_sync_chatwoot_conversations_organizacao       → 34: conversa de A liga no contato de B
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
-- O inbox 1 existe nas três instalações (o mapeamento é por conexão); o inbox
-- 2 só em c1.
insert into public.chatwoot_inboxes (organizacao_id, conexao_id, inbox_id, account_id) values
    ('e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c1', 1, '1'),
    ('e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c2', 1, '2'),
    ('e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c1', 2, '1'),
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
       (select id_local from public.chatwoot_conversations where id = 50) as conversa_a_local,
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
-- 7-12. O mesmo id remoto em outra organização ou instalação coexiste; nada
-- da instalação existente muda.
-- ----------------------------------------------------------------------------
select lives_ok(
    $$insert into public.chatwoot_contacts (id, organizacao_id, conexao_id, name)
      values (5, 'e2000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-0000000000c3', 'Contato B 5')$$,
    '7. o contato 5 de B coexiste com o contato 5 de A');
select lives_ok(
    $$insert into public.chatwoot_contacts (id, organizacao_id, conexao_id, name)
      values (5, 'e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c2', 'Contato A2')$$,
    '8. a segunda instalação de A tem o seu próprio contato 5');
select throws_ok(
    format($$insert into public.chatwoot_conversations (id, organizacao_id, conexao_id, contact_id, contato_id_local, status)
             values (51, 'e2000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-0000000000c3', 5, %L, 'open')$$,
           (select contato_a_local from retrato)),
    '23503', null, '9. conversa de B não aponta para o contato 5 de A');
insert into public.chatwoot_conversations (id, organizacao_id, conexao_id, contact_id, status, inbox_id)
values (50, 'e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c2', 5, 'open', 1);
insert into public.chatwoot_messages (id, organizacao_id, conexao_id, conversation_id, content)
values (500, 'e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c2', 50, 'mensagem de A2');
select is((select v.contato_id_local from public.chatwoot_conversations v
            where v.conexao_id = 'e2000000-0000-4000-8000-0000000000c2' and v.id_externo = '50'),
          (select c.id_local from public.chatwoot_contacts c
            where c.conexao_id = 'e2000000-0000-4000-8000-0000000000c2' and c.id_externo = '5'),
          '10. a conversa 50 da segunda instalação liga no contato 5 da segunda, não da primeira');
select is((select m.conversa_id_local from public.chatwoot_messages m
            where m.conexao_id = 'e2000000-0000-4000-8000-0000000000c2' and m.id_externo = '500'),
          (select v.id_local from public.chatwoot_conversations v
            where v.conexao_id = 'e2000000-0000-4000-8000-0000000000c2' and v.id_externo = '50'),
          '11. a mensagem 500 da segunda instalação entra na conversa 50 da segunda');
select is((select row(c.*)::text from public.chatwoot_contacts c where c.id_local = (select contato_a_local from retrato)),
          (select contato_a from retrato),
          '12. o contato 5 de A1 ficou intacto');

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
    format($$update public.chatwoot_conversations set contato_id_local = %L where id_local = %L$$,
           (select contato_b_local from retrato), (select conversa_a_local from retrato)),
    '23503', null, '15. conversa de A não recebe o UUID do contato de B (FK composta)');
select throws_ok(
    format($$update public.chatwoot_conversations set organizacao_id = 'e2000000-0000-4000-8000-00000000000b' where id_local = %L$$,
           (select conversa_a_local from retrato)),
    '23514', null, '16. conversa não muda de organização');
select throws_ok(
    format($$update public.chatwoot_messages set id_local = gen_random_uuid() where id_local = %L$$, (select mensagem_a_local from retrato)),
    '23514', null, '17. UUID local não muda');
select throws_ok(
    format($$update public.chatwoot_messages set conexao_id = 'e2000000-0000-4000-8000-0000000000c2' where id_local = %L$$,
           (select mensagem_a_local from retrato)),
    '23514', null, '18. mensagem não troca de instalação');

-- ----------------------------------------------------------------------------
-- 19-20. Reprocessamento: o replay do webhook não duplica nem troca o UUID.
-- ----------------------------------------------------------------------------
insert into public.chatwoot_messages (id, organizacao_id, conexao_id, conversation_id, content, updated_at)
values (500, 'e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c1', 50, 'mensagem de A', now())
on conflict (organizacao_id, conexao_id, id_externo) do update set conversation_id = excluded.conversation_id,
    content = excluded.content, updated_at = excluded.updated_at;
select is((select count(*)::int from public.chatwoot_messages
            where organizacao_id = 'e2000000-0000-4000-8000-00000000000a' and conexao_id = 'e2000000-0000-4000-8000-0000000000c1'), 1,
          '19. replay da mensagem 500 não duplica');
select is((select id_local from public.chatwoot_messages
            where conexao_id = 'e2000000-0000-4000-8000-0000000000c1' and id_externo = '500'), (select mensagem_a_local from retrato),
          '20. replay mantém o UUID local');

-- ----------------------------------------------------------------------------
-- 21-25. Escrita sem conexão: só passa com prova única; senão é recusada e não
-- nasce quarentena.
-- ----------------------------------------------------------------------------
select throws_ok(
    $$insert into public.chatwoot_contacts (id, organizacao_id, name) values (8, 'e2000000-0000-4000-8000-00000000000a', 'sem conexão')$$,
    '23514', 'Espelho Chatwoot novo exige organizacao e conexao provadas (public.chatwoot_contacts).',
    '21. contato novo sem conexão é recusado');
insert into public.chatwoot_conversations (id, organizacao_id, contact_id, status, inbox_id)
values (80, 'e2000000-0000-4000-8000-00000000000a', 5, 'open', 2);
insert into public.chatwoot_messages (id, organizacao_id, conversation_id, content)
values (800, 'e2000000-0000-4000-8000-00000000000a', 80, 'pela prova');
select results_eq(
    $$select v.conexao_id, v.contato_id_local, m.conexao_id
        from public.chatwoot_conversations v
        join public.chatwoot_messages m on m.conversa_id_local = v.id_local
       where v.id_externo = '80'$$,
    format($$values ('e2000000-0000-4000-8000-0000000000c1'::uuid, %L::uuid, 'e2000000-0000-4000-8000-0000000000c1'::uuid)$$,
           (select contato_a_local from retrato)),
    '22. inbox 2 (só de c1) prova a conexão; conversa e mensagem ligam em c1');
select throws_ok(
    $$insert into public.chatwoot_conversations (id, organizacao_id, contact_id, status, inbox_id)
      values (81, 'e2000000-0000-4000-8000-00000000000a', 5, 'open', 1)$$,
    '23503', 'O contato da conversa e de outra conexao Chatwoot ou e ambiguo.',
    '23. inbox 1 existe nas duas instalações de A: sem prova, recusado');
select throws_ok(
    $$insert into public.chatwoot_contacts (id, name) values (8, 'sem organização')$$,
    '23514', null, '24. contato novo sem organização é recusado');
select is((select count(*)::int from public.chatwoot_identidade_em_quarentena), 0,
          '25. nenhuma escrita nova entrou em quarentena');

-- ----------------------------------------------------------------------------
-- 26-30. Linhas legadas sem conexão (anteriores ao MSG-004, fabricadas com o
-- gatilho desligado): falha no meio de um lote desfaz o lote; o backfill
-- parcial retoma de onde parou.
-- ----------------------------------------------------------------------------
reset role;
alter table public.chatwoot_contacts disable trigger trg_vincula_identidade_local_chatwoot;
alter table public.chatwoot_conversations disable trigger trg_vincula_identidade_local_chatwoot;
insert into public.chatwoot_contacts (id, id_externo, organizacao_id, name) values
    (9, '9', 'e2000000-0000-4000-8000-00000000000a', 'Sync 9'),
    (10, '10', 'e2000000-0000-4000-8000-00000000000a', 'Sync 10'),
    (11, '11', 'e2000000-0000-4000-8000-00000000000a', 'Sync 11');
insert into public.chatwoot_conversations (id, id_externo, organizacao_id, contact_id, contato_id_local, status, inbox_id)
select x.conversa, x.conversa::text, 'e2000000-0000-4000-8000-00000000000a', x.contato, c.id_local, 'open', 2
  from (values (90, 9), (100, 10), (110, 11)) x(conversa, contato)
  join public.chatwoot_contacts c on c.id = x.contato and c.organizacao_id = 'e2000000-0000-4000-8000-00000000000a';
alter table public.chatwoot_contacts enable trigger trg_vincula_identidade_local_chatwoot;
alter table public.chatwoot_conversations enable trigger trg_vincula_identidade_local_chatwoot;
set local role service_role;

set local msg002.veneno = 'on';
select throws_ok($$select * from public.backfill_identidade_local_chatwoot(3)$$,
                 'XX000', 'falha injetada no meio do lote', '26. a falha no contato 10 aborta o lote');
select is((select count(*)::int from public.chatwoot_contacts where id_externo in ('9', '10', '11') and conexao_id is null), 3,
          '27. os outros contatos do mesmo lote voltaram atrás');
set local msg002.veneno = 'off';
select is((select atualizadas from public.backfill_identidade_local_chatwoot(2) where tabela = 'chatwoot_contacts'), 2,
          '28. lote de 2 processa dois dos três');
select is((select count(*)::int from public.chatwoot_contacts where conexao_id is null), 1,
          '29. um continua pendente: backfill parcial');
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
update public.chatwoot_contacts set organizacao_id = 'e2000000-0000-4000-8000-00000000000b', name = 'Contato B com id de A'
 where id_externo = '12';
select is((select organizacao_id from public.chatwoot_contacts where id_externo = '12'), 'e2000000-0000-4000-8000-00000000000b'::uuid,
          '33. CONTRAPROVA: sem a organização imutável, B toma o contato 12 de A');
rollback to savepoint contraprova;

alter table public.chatwoot_conversations drop constraint fk_chatwoot_conversations_contato_local;
alter table public.chatwoot_conversations disable trigger trg_sync_chatwoot_conversations_organizacao;
update public.chatwoot_conversations set contato_id_local = (select contato_b_local from retrato)
 where id_local = (select conversa_a_local from retrato);
select is((select contato_id_local from public.chatwoot_conversations where id_local = (select conversa_a_local from retrato)),
          (select contato_b_local from retrato),
          '34. CONTRAPROVA: sem a FK composta (e sem o gatilho da 27), a conversa de A liga no contato de B');
rollback to savepoint contraprova;

-- O contato 13 só existe em c1; a conversa 52 de c2 que o cita deveria ser recusada.
create or replace function public.chatwoot_contato_local(p_organizacao_id uuid, p_conexao_id uuid, p_contact_id integer)
returns uuid language sql stable security invoker set search_path = '' as $f$
    select c.id_local from public.chatwoot_contacts c
     where c.id_externo = p_contact_id::text and c.organizacao_id = p_organizacao_id;
$f$;
set local role service_role;
insert into public.chatwoot_contacts (id, organizacao_id, conexao_id, name)
values (13, 'e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c1', 'Contato A 13');
insert into public.chatwoot_conversations (id, organizacao_id, conexao_id, contact_id, status)
values (52, 'e2000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-0000000000c2', 13, 'open');
select is((select contato_id_local from public.chatwoot_conversations where id_externo = '52'),
          (select id_local from public.chatwoot_contacts where id_externo = '13'),
          '35. CONTRAPROVA: sem o filtro de conexão, a conversa da instalação 2 liga no contato da 1');
select isnt_empty($$select 1 from public.chatwoot_identidade_em_quarentena where motivo = 'conexao_divergente_do_contato'$$,
          '36. e a quarentena acusa a divergência que o filtro teria impedido');
reset role;
rollback to savepoint contraprova;
release savepoint contraprova;

-- ----------------------------------------------------------------------------
-- 37-44. PROVA PRIORITÁRIA no schema contraído: três instalações com os mesmos
-- ids 5/50/500 coexistem e não se misturam.
-- ----------------------------------------------------------------------------
savepoint pos_contracao;
set local role service_role;
insert into public.chatwoot_conversations (id, organizacao_id, conexao_id, contact_id, status) values
    (50, 'e2000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-0000000000c3', 5, 'open');
insert into public.chatwoot_messages (id, organizacao_id, conexao_id, conversation_id, content) values
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
