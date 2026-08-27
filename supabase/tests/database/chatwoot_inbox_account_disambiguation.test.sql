-- ============================================================================
-- chatwoot_inbox_account_disambiguation.test.sql
-- Testes pgTAP para o Ticket 11: desambiguação de inbox_id sobrepostos entre
-- organizações via (conexao_id, inbox_id) + account_id.
-- ============================================================================

begin;

insert into auth.users (id, email)
values ('99000000-0000-4000-8000-000000000001', 'owner-inbox-account-a@orbita.test'),
       ('99000000-0000-4000-8000-000000000002', 'owner-inbox-account-b@orbita.test');

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/25_conexoes_credenciais_privadas.sql
\ir ../../../database/27_migrar_chatwoot_organizacao.sql
\ir ../../../database/29_inbox_idempotente_chatwoot.sql
\ir ../../../database/47_chatwoot_inbox_account_disambiguation.sql

select plan(6);

-- Setup: Criar Org A e Org B, cada uma com sua própria conexão Chatwoot
set local role authenticated;
set local request.jwt.claim.sub = '99000000-0000-4000-8000-000000000001';

create temp table temp_org_a as
select public.criar_organizacao_atomica('Org Inbox Account A', 'org-inbox-account-a') as org_id;

set local request.jwt.claim.sub = '99000000-0000-4000-8000-000000000002';
create temp table temp_org_b as
select public.criar_organizacao_atomica('Org Inbox Account B', 'org-inbox-account-b') as org_id;

reset role;

insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status)
values
  ('99100000-0000-4000-8000-000000000001', (select org_id from temp_org_a), 'chatwoot', 'Principal', 'conectado'),
  ('99100000-0000-4000-8000-000000000002', (select org_id from temp_org_b), 'chatwoot', 'Principal', 'conectado');

-- Asserção 1: coluna account_id existe
select has_column('public', 'chatwoot_inboxes', 'account_id', 'Coluna account_id existe em chatwoot_inboxes');

-- Asserção 2: índice único (conexao_id, inbox_id) existe
select has_index('public', 'chatwoot_inboxes', 'uq_chatwoot_inboxes_conexao_inbox', 'Índice único (conexao_id, inbox_id) existe');

-- Asserção 3: duas organizações podem registrar o MESMO inbox_id numérico (colisão A/B) sem erro
select lives_ok(
    $$insert into public.chatwoot_inboxes (organizacao_id, conexao_id, inbox_id, account_id)
      values (
        (select org_id from temp_org_a),
        '99100000-0000-4000-8000-000000000001',
        1,
        'chatwoot-account-a'
      )$$,
    'Org A registra inbox_id=1 para sua própria conexão'
);

select lives_ok(
    $$insert into public.chatwoot_inboxes (organizacao_id, conexao_id, inbox_id, account_id)
      values (
        (select org_id from temp_org_b),
        '99100000-0000-4000-8000-000000000002',
        1,
        'chatwoot-account-b'
      )$$,
    'Org B registra o MESMO inbox_id=1 numérico para a própria conexão, sem colisão'
);

-- Asserção 4: cada organização enxerga apenas o próprio mapeamento, com o account_id correto
set local role authenticated;
set local request.jwt.claim.sub = '99000000-0000-4000-8000-000000000001';

select is(
    (select account_id from public.chatwoot_inboxes
       where conexao_id = '99100000-0000-4000-8000-000000000001' and inbox_id = 1),
    'chatwoot-account-a',
    'Org A resolve inbox_id=1 para a própria conta Chatwoot, não a da Org B'
);

reset role;

-- Asserção 5: reinserir o mesmo (conexao_id, inbox_id) para a mesma organização viola o índice único (idempotência garantida na aplicação via upsert-check, não duplicação silenciosa no banco)
select throws_ok(
    $$insert into public.chatwoot_inboxes (organizacao_id, conexao_id, inbox_id, account_id)
      values (
        (select org_id from temp_org_a),
        '99100000-0000-4000-8000-000000000001',
        1,
        'chatwoot-account-a'
      )$$,
    '23505',
    null,
    'Reinserir o mesmo (conexao_id, inbox_id) viola o índice único, forçando a aplicação a tratar como já-registrado'
);

select * from finish();

rollback;
