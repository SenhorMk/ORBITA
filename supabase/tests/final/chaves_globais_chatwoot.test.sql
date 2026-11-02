-- chaves_globais_chatwoot.test.sql
-- MSG-004, contra o schema canônico completo: sem chave global pelo id do
-- Chatwoot, duas organizações e duas instalações da mesma organização
-- coexistem com os mesmos ids remotos em espelhos, inbox de eventos, retenção,
-- consulta e leitura do navegador, sem leitura ou escrita cruzada.
--
-- Cenário: A1 e A2 são duas instalações da organização A; B1 é a de B. As três
-- têm o contato 5, a conversa 50 e a mensagem 500 (A1 e A2 no inbox 1).
--
-- REINTRODUZIR O DEFEITO (contraprovas executadas aqui, em savepoints):
--   índice de eventos por (organizacao_id, idempotency_key)     → 21: A1 e A2 colidem
--   RPC de eventos sem o filtro de conexão                     → 22: a mensagem de A2 vira duplicata de A1
--   leitura do navegador por id remoto, não pelo UUID          → 29: conversas 50 de A1 e A2 misturadas
--   exclusão de retenção por id remoto + organização           → 38: apaga o contato 5 de A2, em hold
--   integridade da baseline cruzando por id                     → 43: acusa vínculo cruzado inexistente
--   gatilho sem a guarda de adoção legada                       → 47: A2 adota a linha legada de A1

begin;

select plan(48);

insert into auth.users (id, email) values
    ('e4000000-0000-4000-8000-0000000000a1', 'dono-a-m4@orbita.test'),
    ('e4000000-0000-4000-8000-0000000000b1', 'dono-b-m4@orbita.test');
insert into public.organizacoes (id, nome, slug, status) values
    ('e4000000-0000-4000-8000-00000000000a', 'Org A M4', 'org-a-m4', 'active'),
    ('e4000000-0000-4000-8000-00000000000b', 'Org B M4', 'org-b-m4', 'active');
insert into public.membros_organizacao (organizacao_id, user_id, papel) values
    ('e4000000-0000-4000-8000-00000000000a', 'e4000000-0000-4000-8000-0000000000a1', 'owner'),
    ('e4000000-0000-4000-8000-00000000000b', 'e4000000-0000-4000-8000-0000000000b1', 'owner');
insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status) values
    ('e4000000-0000-4000-8000-0000000000c1', 'e4000000-0000-4000-8000-00000000000a', 'chatwoot', 'A1', 'conectado'),
    ('e4000000-0000-4000-8000-0000000000c2', 'e4000000-0000-4000-8000-00000000000a', 'chatwoot', 'A2', 'conectado'),
    ('e4000000-0000-4000-8000-0000000000c3', 'e4000000-0000-4000-8000-00000000000b', 'chatwoot', 'B1', 'conectado');

set local role service_role;

-- ----------------------------------------------------------------------------
-- 1-6. Catálogo: a chave é o UUID local; o id remoto só vale com organização +
-- conexão.
-- ----------------------------------------------------------------------------
select col_is_pk('public', 'chatwoot_contacts', 'id_local', '1. PK do contato é id_local');
select col_is_pk('public', 'chatwoot_messages', 'id_local', '2. PK da mensagem é id_local');
select is((select count(*)::int from pg_constraint
            where contype = 'f' and confrelid in ('public.chatwoot_contacts'::regclass, 'public.chatwoot_conversations'::regclass)
              and conname not in ('fk_chatwoot_conversations_contato_local', 'fk_chatwoot_messages_conversa_local')), 0,
          '3. nenhuma FK pelo id remoto');
select hasnt_index('public', 'chatwoot_contacts', 'uq_chatwoot_contacts_org_id', '4. sem o único (organizacao_id, id)');
select hasnt_index('public', 'chatwoot_inboxes', 'uq_chatwoot_inboxes_org_inbox', '5. inbox único só por conexão');
select has_index('public', 'inbox_eventos_chatwoot', 'uq_inbox_eventos_chatwoot_conexao_key',
                 array['organizacao_id', 'conexao_id', 'idempotency_key'], '6. dedup de eventos por organização + conexão + chave');

-- ----------------------------------------------------------------------------
-- 7-14. Três instalações, mesmos ids, árvores separadas (escrita do webhook e
-- do sync: o adapter grava id, id_externo, organização, conexão e o pai local).
-- ----------------------------------------------------------------------------
insert into public.chatwoot_inboxes (organizacao_id, conexao_id, inbox_id, account_id) values
    ('e4000000-0000-4000-8000-00000000000a', 'e4000000-0000-4000-8000-0000000000c1', 1, '1'),
    ('e4000000-0000-4000-8000-00000000000a', 'e4000000-0000-4000-8000-0000000000c2', 1, '7'),
    ('e4000000-0000-4000-8000-00000000000b', 'e4000000-0000-4000-8000-0000000000c3', 1, '1');

create temp table instalacao (org uuid, conexao uuid, dono uuid, nome text) on commit drop;
insert into instalacao values
    ('e4000000-0000-4000-8000-00000000000a', 'e4000000-0000-4000-8000-0000000000c1', 'e4000000-0000-4000-8000-0000000000a1', 'A1'),
    ('e4000000-0000-4000-8000-00000000000a', 'e4000000-0000-4000-8000-0000000000c2', 'e4000000-0000-4000-8000-0000000000a1', 'A2'),
    ('e4000000-0000-4000-8000-00000000000b', 'e4000000-0000-4000-8000-0000000000c3', 'e4000000-0000-4000-8000-0000000000b1', 'B1');
grant select on instalacao to authenticated;

insert into public.chatwoot_contacts (id, id_externo, organizacao_id, conexao_id, user_id, name, created_at, updated_at)
select 5, '5', org, conexao, dono, 'Contato 5 de ' || nome, '2020-01-01', '2020-01-01' from instalacao;
insert into public.chatwoot_conversations (id, id_externo, organizacao_id, conexao_id, user_id, contact_id, contato_id_local, status, inbox_id)
select 50, '50', i.org, i.conexao, i.dono, 5, c.id_local, 'open', 1
  from instalacao i join public.chatwoot_contacts c on c.conexao_id = i.conexao and c.id_externo = '5';
insert into public.chatwoot_messages (id, id_externo, organizacao_id, conexao_id, user_id, conversation_id, conversa_id_local, content)
select 500, '500', i.org, i.conexao, i.dono, 50, v.id_local, 'mensagem 500 de ' || i.nome
  from instalacao i join public.chatwoot_conversations v on v.conexao_id = i.conexao and v.id_externo = '50';

create temp table arvore on commit drop as
select i.nome, c.id_local as contato, v.id_local as conversa, m.id_local as mensagem
  from instalacao i
  join public.chatwoot_contacts c on c.conexao_id = i.conexao and c.id_externo = '5'
  join public.chatwoot_conversations v on v.conexao_id = i.conexao and v.id_externo = '50'
  join public.chatwoot_messages m on m.conexao_id = i.conexao and m.id_externo = '500';
grant select on arvore to authenticated;

select is((select count(distinct contato)::int + count(distinct conversa)::int + count(distinct mensagem)::int from arvore), 9,
          '7. três instalações, nove UUIDs locais distintos');
select is((select count(*)::int from public.chatwoot_messages m
             join public.chatwoot_conversations v on v.id_local = m.conversa_id_local
             join public.chatwoot_contacts c on c.id_local = v.contato_id_local
            where m.id_externo = '500' and m.conexao_id = v.conexao_id and v.conexao_id = c.conexao_id), 3,
          '8. cada mensagem 500 chega ao contato 5 da própria instalação');
-- Reprocessamento do sync de A2 pelo UUID resolvido no seu escopo.
update public.chatwoot_messages set content = 'sync de A2'
 where organizacao_id = 'e4000000-0000-4000-8000-00000000000a' and id_local = (select mensagem from arvore where nome = 'A2')
   and conexao_id = 'e4000000-0000-4000-8000-0000000000c2';
select results_eq($$select a.nome, m.content from arvore a join public.chatwoot_messages m on m.id_local = a.mensagem order by a.nome$$,
                  $$values ('A1'::text, 'mensagem 500 de A1'::text), ('A2', 'sync de A2'), ('B1', 'mensagem 500 de B1')$$,
                  '9. o replay do sync de A2 só muda a mensagem de A2');
-- Status pelo webhook de A2: só a conversa 50 de A2.
update public.chatwoot_conversations set status = 'resolved'
 where organizacao_id = 'e4000000-0000-4000-8000-00000000000a' and id_local = (select conversa from arvore where nome = 'A2')
   and conexao_id = 'e4000000-0000-4000-8000-0000000000c2';
select results_eq($$select a.nome, v.status from arvore a join public.chatwoot_conversations v on v.id_local = a.conversa order by a.nome$$,
                  $$values ('A1'::text, 'open'::text), ('A2', 'resolved'), ('B1', 'open')$$,
                  '10. status da conversa 50 de A2 não afeta A1 nem B1');
select throws_ok(
    $$insert into public.chatwoot_messages (id, id_externo, organizacao_id, conexao_id, conversation_id, content)
      values (500, '500', 'e4000000-0000-4000-8000-00000000000a', 'e4000000-0000-4000-8000-0000000000c2', 50, 'duplicada')$$,
    '23505', null, '11. a mensagem 500 não entra duas vezes na mesma instalação');
select throws_ok(
    format($$insert into public.chatwoot_messages (id, id_externo, organizacao_id, conexao_id, conversation_id, conversa_id_local, content)
             values (501, '501', 'e4000000-0000-4000-8000-00000000000a', 'e4000000-0000-4000-8000-0000000000c2', 50, %L, 'cruzada')$$,
           (select conversa from arvore where nome = 'A1')),
    '23503', null, '12. mensagem de A2 não entra na conversa de A1');
select throws_ok(
    format($$insert into public.chatwoot_messages (id, id_externo, organizacao_id, conexao_id, conversation_id, conversa_id_local, content)
             values (502, '502', 'e4000000-0000-4000-8000-00000000000b', 'e4000000-0000-4000-8000-0000000000c3', 50, %L, 'cruzada')$$,
           (select conversa from arvore where nome = 'A1')),
    '23503', null, '13. mensagem de B não entra na conversa de A');
select throws_ok(
    $$insert into public.chatwoot_contacts (id, id_externo, organizacao_id, conexao_id, name)
      values (6, '6', 'e4000000-0000-4000-8000-00000000000b', 'e4000000-0000-4000-8000-0000000000c1', 'x')$$,
    '23503', 'Espelho Chatwoot so aponta para conexao Chatwoot da mesma organizacao.',
    '14. B não grava com a conexão de A');

-- ----------------------------------------------------------------------------
-- 15-18. Consulta e envio pelo UUID local (as instruções do store em
-- `resolverPorIdLocal`): a organização vem da sessão; conexão e id remoto, da
-- linha nessa organização.
-- ----------------------------------------------------------------------------
create temp table traducao on commit drop as
select a.nome, v.conexao_id, v2.id_externo
  from arvore a
  join public.chatwoot_conversations v
    on v.organizacao_id = (select org from instalacao i where i.nome = a.nome) and v.id_local = a.conversa
  join public.chatwoot_conversations v2
    on v2.organizacao_id = v.organizacao_id and v2.conexao_id = v.conexao_id and v2.id_local = a.conversa;
select results_eq($$select nome, conexao_id from traducao order by nome$$,
                  $$values ('A1'::text, 'e4000000-0000-4000-8000-0000000000c1'::uuid),
                           ('A2', 'e4000000-0000-4000-8000-0000000000c2'), ('B1', 'e4000000-0000-4000-8000-0000000000c3')$$,
                  '15. cada UUID abre o adapter da sua própria instalação');
select is((select count(distinct id_externo)::int from traducao), 1, '16. e todas traduzem para o mesmo id remoto 50, cada uma no seu escopo');
select is_empty(format($$select 1 from public.chatwoot_conversations
                          where organizacao_id = 'e4000000-0000-4000-8000-00000000000b' and id_local = %L$$,
                       (select conversa from arvore where nome = 'A1')),
                '17. o UUID de A na sessão de B não é encontrado (404 sem efeito)');
select is_empty(format($$select 1 from public.chatwoot_conversations
                          where organizacao_id = 'e4000000-0000-4000-8000-00000000000a'
                            and conexao_id = 'e4000000-0000-4000-8000-0000000000c1' and id_local = %L$$,
                       (select conversa from arvore where nome = 'A2')),
                '18. o UUID de A2 não é traduzido no escopo de A1');

-- ----------------------------------------------------------------------------
-- 19-23. Inbox de eventos: a chave é feita de ids remotos, então a duplicata é
-- por instalação.
-- ----------------------------------------------------------------------------
create temp table evento on commit drop as
select 'A1'::text as nome, r.* from public.registrar_evento_inbox_chatwoot(
    'e4000000-0000-4000-8000-00000000000a', 'e4000000-0000-4000-8000-0000000000c1', null, 1,
    'event_message_created_msg_500_conv_50', 'message_created', '{}'::jsonb) r;
insert into evento select 'A2', r.* from public.registrar_evento_inbox_chatwoot(
    'e4000000-0000-4000-8000-00000000000a', 'e4000000-0000-4000-8000-0000000000c2', null, 1,
    'event_message_created_msg_500_conv_50', 'message_created', '{}'::jsonb) r;
insert into evento select 'A1 de novo', r.* from public.registrar_evento_inbox_chatwoot(
    'e4000000-0000-4000-8000-00000000000a', 'e4000000-0000-4000-8000-0000000000c1', null, 1,
    'event_message_created_msg_500_conv_50', 'message_created', '{}'::jsonb) r;
select results_eq($$select nome, is_duplicate from evento order by nome$$,
                  $$values ('A1'::text, false), ('A1 de novo', true), ('A2', false)$$,
                  '19. a mensagem 500 de A2 não é duplicata da de A1; a reentrega de A1 é');
select is((select evento_id from evento where nome = 'A1 de novo'), (select evento_id from evento where nome = 'A1'),
          '20. a reentrega devolve o mesmo evento');

reset role;
savepoint contraprova_evento;
delete from public.inbox_eventos_chatwoot where organizacao_id = 'e4000000-0000-4000-8000-00000000000a';
drop index public.uq_inbox_eventos_chatwoot_conexao_key;
create unique index uq_contraprova on public.inbox_eventos_chatwoot(organizacao_id, idempotency_key);
select throws_ok($$select * from public.registrar_evento_inbox_chatwoot(
    'e4000000-0000-4000-8000-00000000000a', 'e4000000-0000-4000-8000-0000000000c2', null, 1,
    'event_message_updated_msg_500_conv_50', 'message_updated', '{}'::jsonb) a
    cross join public.registrar_evento_inbox_chatwoot(
    'e4000000-0000-4000-8000-00000000000a', 'e4000000-0000-4000-8000-0000000000c1', null, 1,
    'event_message_updated_msg_500_conv_50', 'message_updated', '{}'::jsonb) b$$,
    '23505', null, '21. CONTRAPROVA: com o único antigo por organização, A1 e A2 colidem');
rollback to savepoint contraprova_evento;
create or replace function public.registrar_evento_inbox_chatwoot(
    p_organizacao_id uuid, p_conexao_id uuid, p_user_id uuid, p_inbox_id bigint,
    p_idempotency_key text, p_event_type text, p_payload jsonb)
returns table (evento_id uuid, status text, is_duplicate boolean, cached_response jsonb)
language plpgsql security definer set search_path = public as $f$
declare v record;
begin
    select e.id, e.status, e.response_body into v from public.inbox_eventos_chatwoot e
     where e.organizacao_id = p_organizacao_id and e.idempotency_key = p_idempotency_key;
    if found then return query select v.id, v.status, true, v.response_body; return; end if;
    return query select null::uuid, 'received'::text, false, null::jsonb;
end $f$;
select is((select is_duplicate from public.registrar_evento_inbox_chatwoot(
    'e4000000-0000-4000-8000-00000000000a', 'e4000000-0000-4000-8000-0000000000c2', null, 1,
    'event_message_created_msg_500_conv_50', 'message_created', '{}'::jsonb)), true,
    '22. CONTRAPROVA: sem o filtro de conexão, o evento de A2 já seria a duplicata de A1');
rollback to savepoint contraprova_evento;
release savepoint contraprova_evento;
select is((select count(*)::int from public.inbox_eventos_chatwoot
            where organizacao_id = 'e4000000-0000-4000-8000-00000000000a'), 2, '23. dois eventos, um por instalação');
set local role service_role;

-- ----------------------------------------------------------------------------
-- 24-29. Navegador e Realtime: RLS por organização e filtro pelo UUID da
-- conversa aberta (`conversa_id_local=eq.<uuid>`).
-- ----------------------------------------------------------------------------
select set_config('m4.conversa_a2', (select conversa::text from arvore where nome = 'A2'), true),
       set_config('m4.conversa_b1', (select conversa::text from arvore where nome = 'B1'), true);
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'e4000000-0000-4000-8000-0000000000a1';
select results_eq(format($$select content from public.chatwoot_messages where conversa_id_local = %L$$,
                          current_setting('m4.conversa_a2')),
                  $$values ('sync de A2'::text)$$, '24. A abre a conversa 50 de A2 e vê só a mensagem de A2');
select is_empty(format($$select 1 from public.chatwoot_messages where conversa_id_local = %L$$, current_setting('m4.conversa_b1')),
                '25. A com o UUID da conversa de B não vê nada');
select is_empty($$select 1 from public.chatwoot_contacts where organizacao_id = 'e4000000-0000-4000-8000-00000000000b'$$,
                '26. A não lê contatos de B');
select throws_ok($$update public.chatwoot_conversations set status = 'open' where id_externo = '50'$$,
                 '42501', null, '27. o navegador não muda status');
set local request.jwt.claim.sub = 'e4000000-0000-4000-8000-0000000000b1';
select results_eq($$select content from public.chatwoot_messages where id_externo = '500'$$,
                  $$values ('mensagem 500 de B1'::text)$$, '28. B lê só a sua mensagem 500');
set local request.jwt.claim.sub = 'e4000000-0000-4000-8000-0000000000a1';
select is((select count(*)::int from public.chatwoot_messages where conversation_id = 50), 2,
          '29. CONTRAPROVA: pelo id remoto, A veria as mensagens das conversas 50 de A1 e A2 misturadas');
set local role service_role;

-- ----------------------------------------------------------------------------
-- 30-40. Retenção do contato Chatwoot pelo UUID local.
-- ----------------------------------------------------------------------------
reset role;
insert into public.retention_runs (id, organizacao_id, categoria, policy_versao, modo, cutoff)
values ('e4000000-0000-4000-8000-0000000000f1', 'e4000000-0000-4000-8000-00000000000a', 'chatwoot_contato_inativo', 1,
        'execute', '2021-01-01');
create temp table selecionados on commit drop as
select * from public.retencao_selecionar_e_reivindicar_lote(
    'e4000000-0000-4000-8000-0000000000f1', 'e4000000-0000-4000-8000-00000000000a', 'chatwoot_contato_inativo',
    'chatwoot_contacts', '2021-01-01', 100);
select set_eq($$select entidade_id from selecionados$$,
              $$select contato::text from arvore where nome in ('A1', 'A2')$$,
              '30. os dois contatos 5 de A entram no lote, cada um pelo seu UUID');
select throws_ok($$select public.retencao_marcar_legal_hold('e4000000-0000-4000-8000-00000000000a', 'chatwoot_contato_inativo',
                                                             '5', 'id remoto', null)$$,
                 '22023', null, '31. legal hold pelo id remoto é recusado (não protegeria ninguém)');
select isnt(public.retencao_marcar_legal_hold('e4000000-0000-4000-8000-00000000000a', 'chatwoot_contato_inativo',
                                              (select contato::text from arvore where nome = 'A2'), 'processo', null),
            null, '32. legal hold pelo UUID de A2');
select is(public.retencao_aplicar_exclusao('e4000000-0000-4000-8000-0000000000f1', 'e4000000-0000-4000-8000-00000000000a',
                                           'chatwoot_contato_inativo', 'chatwoot_contacts',
                                           (select contato::text from arvore where nome = 'A2')), false,
          '33. o contato de A2 em hold não é excluído');
select is(public.retencao_aplicar_exclusao('e4000000-0000-4000-8000-0000000000f1', 'e4000000-0000-4000-8000-00000000000a',
                                           'chatwoot_contato_inativo', 'chatwoot_contacts',
                                           (select contato::text from arvore where nome = 'A1')), true,
          '34. o contato de A1 é excluído');
select results_eq($$select a.nome, (c.id_local is not null), (v.id_local is not null)
                      from arvore a
                      left join public.chatwoot_contacts c on c.id_local = a.contato
                      left join public.chatwoot_conversations v on v.id_local = a.conversa
                     order by a.nome$$,
                  $$values ('A1'::text, false, false), ('A2', true, true), ('B1', true, true)$$,
                  '35. só a árvore de A1 sumiu (cascata pela FK composta); A2 e B1 intactos');
select throws_ok($$select public.retencao_aplicar_exclusao('e4000000-0000-4000-8000-0000000000f1',
                       'e4000000-0000-4000-8000-00000000000b', 'chatwoot_contato_inativo', 'chatwoot_contacts', '5')$$,
                 '22023', null, '36. item legado pelo id remoto é recusado, sem apagar nada');
select is(public.retencao_aplicar_exclusao('e4000000-0000-4000-8000-0000000000f1', 'e4000000-0000-4000-8000-00000000000b',
                                           'chatwoot_contato_inativo', 'chatwoot_contacts',
                                           (select contato::text from arvore where nome = 'A2'))
          and exists (select 1 from public.chatwoot_contacts c where c.id_local = (select contato from arvore where nome = 'A2')), true,
          '37. o UUID de A2 numa run de B não apaga nada');
savepoint contraprova_retencao;
delete from public.chatwoot_contacts where id = 5 and organizacao_id = 'e4000000-0000-4000-8000-00000000000a';
select is((select count(*)::int from public.chatwoot_contacts c where c.id_local = (select contato from arvore where nome = 'A2')), 0,
          '38. CONTRAPROVA: a exclusão antiga (id + organização) do item de A1 apaga o contato 5 de A2, que está em hold');
rollback to savepoint contraprova_retencao;
release savepoint contraprova_retencao;

-- Restore: um tombstone legado (id remoto, anterior ao MSG-004) vale só para a
-- linha que já existia; o contato 5 de A2 criado depois não é apagado.
insert into public.chatwoot_contacts (id, id_externo, organizacao_id, conexao_id, name, created_at)
values (9, '9', 'e4000000-0000-4000-8000-00000000000a', 'e4000000-0000-4000-8000-0000000000c1', 'restaurado do backup', '2020-01-01');
insert into public.chatwoot_contacts (id, id_externo, organizacao_id, conexao_id, name)
values (9, '9', 'e4000000-0000-4000-8000-00000000000a', 'e4000000-0000-4000-8000-0000000000c2', 'contato 9 novo de A2');
insert into public.retention_tombstones (organizacao_id, categoria, entidade_id, acao, run_id, efetivado_em)
values ('e4000000-0000-4000-8000-00000000000a', 'chatwoot_contato_inativo', '9', 'deleted',
        'e4000000-0000-4000-8000-0000000000f1', '2021-06-01');
select results_eq($$select entidade_id, reaplicado from public.retencao_reaplicar_tombstones_restore('e4000000-0000-4000-8000-00000000000a')
                     where entidade_id = '9'$$,
                  $$values ('9'::text, true)$$, '39. o tombstone legado reaplica sobre o contato 9 restaurado');
select results_eq($$select name from public.chatwoot_contacts where organizacao_id = 'e4000000-0000-4000-8000-00000000000a' and id_externo = '9'$$,
                  $$values ('contato 9 novo de A2'::text)$$, '40. e não apaga o contato 9 de A2, mais novo que o tombstone');

-- ----------------------------------------------------------------------------
-- 41-43. Integridade da baseline sem cruzar instalações.
-- ----------------------------------------------------------------------------
select is((select infracoes::int from public.verificar_integridade_baseline()
            where tabela = 'chatwoot_messages -> chatwoot_conversations'), 0,
          '41. nenhuma mensagem em conversa de outro dono');
select is((select count(*)::int from public.chatwoot_messages m
             join public.chatwoot_conversations v on v.id_local = m.conversa_id_local
            where m.organizacao_id <> v.organizacao_id or m.conexao_id <> v.conexao_id), 0,
          '42. nenhum vínculo atravessa organização ou instalação');
select ok((select count(*) from public.chatwoot_messages m
             join public.chatwoot_conversations v on m.conversation_id = v.id
            where m.user_id <> v.user_id) > 0,
          '43. CONTRAPROVA: o cruzamento antigo por id acusaria mensagem de A em conversa de B');

reset role;
-- ----------------------------------------------------------------------------
-- 44-48. Linhas legadas sem conexão (anteriores ao MSG-004): fail-closed.
-- ----------------------------------------------------------------------------
alter table public.chatwoot_contacts disable trigger trg_vincula_identidade_local_chatwoot;
insert into public.chatwoot_contacts (id, id_externo, organizacao_id, name) values
    (20, '20', 'e4000000-0000-4000-8000-00000000000a', 'legado de A'),
    (20, '20', 'e4000000-0000-4000-8000-00000000000b', 'legado de B');
alter table public.chatwoot_contacts enable trigger trg_vincula_identidade_local_chatwoot;
set local role service_role;
select throws_ok($$update public.chatwoot_contacts set conexao_id = 'e4000000-0000-4000-8000-0000000000c2', name = 'adotado por A2'
                    where organizacao_id = 'e4000000-0000-4000-8000-00000000000a' and id_externo = '20'$$,
                 '23514', null, '44. A tem duas instalações: a linha legada sem prova não é adotada');
select throws_ok($$update public.chatwoot_contacts set name = 'conteúdo novo'
                    where organizacao_id = 'e4000000-0000-4000-8000-00000000000a' and id_externo = '20'$$,
                 '23514', null, '45. nem recebe conteúdo sem ser adotada');
select lives_ok($$update public.chatwoot_contacts set conexao_id = 'e4000000-0000-4000-8000-0000000000c3', name = 'adotado por B1'
                   where organizacao_id = 'e4000000-0000-4000-8000-00000000000b' and id_externo = '20'$$,
                '46. B tem uma instalação só: a adoção passa');
reset role;
savepoint contraprova_adocao;
alter table public.chatwoot_contacts disable trigger trg_vincula_identidade_local_chatwoot;
update public.chatwoot_contacts set conexao_id = 'e4000000-0000-4000-8000-0000000000c2', name = 'adotado por A2'
 where organizacao_id = 'e4000000-0000-4000-8000-00000000000a' and id_externo = '20';
select is((select conexao_id from public.chatwoot_contacts
            where organizacao_id = 'e4000000-0000-4000-8000-00000000000a' and id_externo = '20'),
          'e4000000-0000-4000-8000-0000000000c2'::uuid,
          '47. CONTRAPROVA: sem a guarda, A2 adota uma linha que pode ser de A1');
rollback to savepoint contraprova_adocao;
select results_eq($$select organizacao_id, conexao_id, name from public.chatwoot_contacts where id_externo = '20' order by name$$,
                  $$values ('e4000000-0000-4000-8000-00000000000b'::uuid, 'e4000000-0000-4000-8000-0000000000c3'::uuid, 'adotado por B1'::text),
                           ('e4000000-0000-4000-8000-00000000000a', null, 'legado de A')$$,
                  '48. a linha legada de A segue em quarentena, intacta');

select * from finish();
rollback;
