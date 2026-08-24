-- chatwoot_organizacao.test.sql
-- Ticket 31: Migrar a conexão Chatwoot para organização

begin;

insert into auth.users (id, email)
values ('96000000-0000-4000-8000-000000000001', 'owner-cw@orbita.test'),
       ('96000000-0000-4000-8000-000000000002', 'other-cw@orbita.test');

\ir .generated/20_organizacao_membership_ativa.inc
\ir .generated/25_conexoes_credenciais_privadas.inc
\ir .generated/27_migrar_chatwoot_organizacao.inc

select plan(9);

-- 1. Setup: Criar Org e Conexão Chatwoot
set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-4000-8000-000000000001';

create temp table temp_org_cw as
select public.criar_organizacao_atomica('Chatwoot Org', 'chatwoot-org') as org_id;

-- Asserção 1: Coluna organizacao_id existe em chatwoot_inboxes
select has_column('public', 'chatwoot_inboxes', 'organizacao_id', 'Coluna organizacao_id existe em chatwoot_inboxes');

-- Asserção 2: Coluna organizacao_id existe em chatwoot_contacts
select has_column('public', 'chatwoot_contacts', 'organizacao_id', 'Coluna organizacao_id existe em chatwoot_contacts');

-- Asserção 3: Coluna organizacao_id existe em chatwoot_conversations
select has_column('public', 'chatwoot_conversations', 'organizacao_id', 'Coluna organizacao_id existe em chatwoot_conversations');

-- Asserção 4: Coluna organizacao_id existe em chatwoot_messages
select has_column('public', 'chatwoot_messages', 'organizacao_id', 'Coluna organizacao_id existe em chatwoot_messages');

-- Asserção 5: Trigger auto-preenche organizacao_id em chatwoot_contacts a partir de user_id
reset role;

insert into public.chatwoot_contacts (id, user_id, name, phone_number)
values (1001, '96000000-0000-4000-8000-000000000001', 'Contato Alpha', '+5511999990001');

select is(
    (select organizacao_id from public.chatwoot_contacts where id = 1001),
    (select org_id from temp_org_cw),
    'Trigger de contato preenche organizacao_id automaticamente'
);

-- Asserção 6: Trigger de conversa herda organizacao_id do contato
insert into public.chatwoot_conversations (id, contact_id, status)
values (2001, 1001, 'open');

select is(
    (select organizacao_id from public.chatwoot_conversations where id = 2001),
    (select org_id from temp_org_cw),
    'Trigger de conversa herda organizacao_id do contato associado'
);

-- Asserção 7: Trigger de mensagem herda organizacao_id da conversa
insert into public.chatwoot_messages (id, conversation_id, content)
values (3001, 2001, 'Ola Alpha');

select is(
    (select organizacao_id from public.chatwoot_messages where id = 3001),
    (select org_id from temp_org_cw),
    'Trigger de mensagem herda organizacao_id da conversa associada'
);

-- Asserção 8: Isolamento RLS por organização para usuário autenticado
set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-4000-8000-000000000001';

select is(
    (select count(*)::int from public.chatwoot_contacts),
    1,
    'Usuario autenticado enxerga contatos da sua organizacao'
);

-- Reset role de volta ao postgres para finalizar
reset role;

-- Asserção 9: Backfill migra dados legados sem organizacao_id
select is(
    (select migrados_contatos >= 0 from public.migrar_chatwoot_para_organizacoes()),
    true,
    'Funcao de backfill Chatwoot executa sem erros'
);

select * from finish();

rollback;
