-- conexoes_credenciais_privadas.test.sql
-- Ticket 29: Conexões e credenciais privadas por organização
-- RLS, isolamento estrito de segredos e validação anti cross-tenant

begin;

insert into auth.users (id, email)
values ('94000000-0000-4000-8000-000000000001', 'owner-conexoes@orbita.test'),
       ('94000000-0000-4000-8000-000000000002', 'collab-conexoes@orbita.test'),
       ('94000000-0000-4000-8000-000000000003', 'stranger-conexoes@orbita.test');

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/21_convites_papeis_capacidades.sql
\ir ../../../database/25_conexoes_credenciais_privadas.sql

select plan(8);

-- 1. Setup: Criar Org A
set local role authenticated;
set local request.jwt.claim.sub = '94000000-0000-4000-8000-000000000001';

create temp table temp_org_a as
select public.criar_organizacao_atomica('Conexoes Org A', 'conexoes-org-a') as org_id;

-- Associar Colaborador na Org A
set local role postgres;
insert into public.membros_organizacao (organizacao_id, user_id, papel)
values ((select org_id from temp_org_a), '94000000-0000-4000-8000-000000000002'::uuid, 'member');

-- Criar Org B para o usuário Stranger
set local role authenticated;
set local request.jwt.claim.sub = '94000000-0000-4000-8000-000000000003';

create temp table temp_org_b as
select public.criar_organizacao_atomica('Conexoes Org B', 'conexoes-org-b') as org_id;

-- 2. Owner da Org A cria Conexão Bling
set local role authenticated;
set local request.jwt.claim.sub = '94000000-0000-4000-8000-000000000001';

insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status, metadata)
values ('94100000-0000-4000-8000-000000000001', (select org_id from temp_org_a), 'bling', 'Bling Principal', 'pendente', '{"ambiente": "producao"}'::jsonb);

-- Asserção 1: Conexão criada com sucesso
select is(
    (select count(*) from public.conexoes_integracao where id = '94100000-0000-4000-8000-000000000001'::uuid),
    1::bigint,
    'Owner da Org A cria conexao de integracao'
);

-- Asserção 2: Colaborador membro da Org A lê Conexão via RLS
set local role authenticated;
set local request.jwt.claim.sub = '94000000-0000-4000-8000-000000000002';

select is(
    (select count(*) from public.conexoes_integracao where id = '94100000-0000-4000-8000-000000000001'::uuid),
    1::bigint,
    'Colaborador membro da Org A enxerga a conexao via RLS'
);

-- Asserção 3: Usuário da Org B não enxerga a Conexão da Org A
set local role authenticated;
set local request.jwt.claim.sub = '94000000-0000-4000-8000-000000000003';

select is(
    (select count(*) from public.conexoes_integracao where id = '94100000-0000-4000-8000-000000000001'::uuid),
    0::bigint,
    'Usuario de outra organizacao eh bloqueado por RLS'
);

-- Asserção 4: Usuário autenticado NÃO tem permissão de SELECT em credenciais_integracao (Data API blindada)
set local role authenticated;
set local request.jwt.claim.sub = '94000000-0000-4000-8000-000000000001';

select throws_ok(
    $$select * from public.credenciais_integracao$$,
    '42501',
    null,
    'Acesso direto da Data API/authenticated a tabela de credenciais eh bloqueado com permission denied'
);

-- Asserção 5: Usuário autenticado NÃO tem permissão de INSERT em credenciais_integracao
select throws_ok(
    $$insert into public.credenciais_integracao (conexao_id, organizacao_id, dados_cifrados)
      values ('94100000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', 'fake-cipher')$$,
    '42501',
    null,
    'Insercao direta da Data API/authenticated em credenciais eh negada'
);

-- Asserção 6: Service Role (postgres) insere credencial cifrada com sucesso
set local role postgres;

select lives_ok(
    $$insert into public.credenciais_integracao (id, conexao_id, organizacao_id, chave_versao, dados_cifrados)
      values ('94200000-0000-4000-8000-000000000001', '94100000-0000-4000-8000-000000000001', (select org_id from temp_org_a), 'v1', '123456789012345678901234:12345678901234567890123456789012:deadbeef')$$,
    'Service role persiste credenciais cifradas no armazenamento privado'
);

-- Asserção 7: Trigger impede criação de credencial apontando para organização inconsistente com a conexão
select throws_ok(
    $$insert into public.credenciais_integracao (conexao_id, organizacao_id, dados_cifrados)
      values ('94100000-0000-4000-8000-000000000001', (select org_id from temp_org_b), '123456789012345678901234:12345678901234567890123456789012:deadbeef')$$,
    '23503',
    null,
    'Trigger bloqueia credencial com organizacao diferente da conexao vinculada'
);

-- Asserção 8: Trigger preenche organizacao_id da credencial automaticamente a partir da conexão
insert into public.credenciais_integracao (id, conexao_id, dados_cifrados)
values ('94200000-0000-4000-8000-000000000002', '94100000-0000-4000-8000-000000000001', 'aabbccddeeff001122334455:aabbccddeeff00112233445566778899:cafebeef')
on conflict (conexao_id) do update set dados_cifrados = excluded.dados_cifrados;

select is(
    (select organizacao_id from public.credenciais_integracao where conexao_id = '94100000-0000-4000-8000-000000000001'::uuid),
    (select org_id from temp_org_a),
    'Credencial herda organizacao_id automaticamente da conexao'
);

select * from finish();
rollback;
