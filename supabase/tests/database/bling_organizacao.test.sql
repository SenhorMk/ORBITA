-- bling_organizacao.test.sql
-- Ticket 30: Conexão Bling por organização, locks atômicos e ciclo de vida OAuth

begin;

insert into auth.users (id, email)
values ('95000000-0000-4000-8000-000000000001', 'owner-bling@orbita.test'),
       ('95000000-0000-4000-8000-000000000002', 'other-bling@orbita.test');

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/25_conexoes_credenciais_privadas.sql
\ir ../../../database/26_migrar_bling_organizacao.sql

select plan(9);

-- 1. Setup: Criar Org e Conexão Bling
set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-4000-8000-000000000001';

create temp table temp_org_bling as
select public.criar_organizacao_atomica('Bling Org', 'bling-org') as org_id;

insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status)
values ('95100000-0000-4000-8000-000000000001', (select org_id from temp_org_bling), 'bling', 'Principal', 'conectado');

-- Asserção 1: Conexão Bling pertence à organização correta
select is(
    (select organizacao_id from public.conexoes_integracao where id = '95100000-0000-4000-8000-000000000001'::uuid),
    (select org_id from temp_org_bling),
    'Conexao Bling pertence a organizacao autorizada'
);

-- Asserção 2: Service Role (postgres) adquire lock atômico de rotação de token
reset role;

select is(
    public.acquire_conexao_token_lock('95100000-0000-4000-8000-000000000001'::uuid, 30),
    true,
    'Service role adquire lock atomico da conexao com sucesso'
);

-- Asserção 3: Segunda tentativa de lock imediata retorna false (concorrência bloqueada)
select is(
    public.acquire_conexao_token_lock('95100000-0000-4000-8000-000000000001'::uuid, 30),
    false,
    'Segunda tentativa de aquisicao de lock retorna false enquanto ativo'
);

-- Asserção 4: Liberação do lock
select is(
    public.release_conexao_token_lock('95100000-0000-4000-8000-000000000001'::uuid),
    true,
    'Liberacao do lock da conexao com sucesso'
);

-- Asserção 5: Após liberação, lock pode ser adquirido novamente
select is(
    public.acquire_conexao_token_lock('95100000-0000-4000-8000-000000000001'::uuid, 30),
    true,
    'Lock pode ser readquirido apos liberacao'
);

-- Asserção 6: Liberação final do lock
select is(
    public.release_conexao_token_lock('95100000-0000-4000-8000-000000000001'::uuid),
    true,
    'Liberacao final do lock para backfill'
);

-- Asserção 7: Backfill migra credenciais legadas para o modelo organizacional
create table if not exists public.integracoes_bling (
    user_id uuid primary key references auth.users(id) on delete cascade,
    client_id text not null,
    client_secret text not null,
    access_token text,
    refresh_token text,
    token_expires_at timestamptz,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

insert into public.integracoes_bling (user_id, client_id, client_secret, access_token, refresh_token)
values ('95000000-0000-4000-8000-000000000001', 'legacy-client-id', 'legacy-secret', 'legacy-access-token', 'legacy-refresh-token')
on conflict (user_id) do update
set client_id = excluded.client_id,
    client_secret = excluded.client_secret,
    access_token = excluded.access_token,
    refresh_token = excluded.refresh_token;

select is(
    (select migrados_conexoes >= 1 from public.migrar_bling_para_organizacoes()),
    true,
    'Backfill de migracao Bling executa e migra conexao'
);

-- Asserção 8: Usuário autenticado NÃO pode invocar lock diretamente (Data API bloqueada)
set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-4000-8000-000000000001';

select throws_ok(
    $$select public.acquire_conexao_token_lock('95100000-0000-4000-8000-000000000001'::uuid, 30)$$,
    '42501',
    null,
    'Usuario comum/Data API eh bloqueado de chamar acquire_conexao_token_lock'
);

-- Asserção 9: Usuário autenticado NÃO pode invocar liberação de lock diretamente
select throws_ok(
    $$select public.release_conexao_token_lock('95100000-0000-4000-8000-000000000001'::uuid)$$,
    '42501',
    null,
    'Usuario comum/Data API eh bloqueado de chamar release_conexao_token_lock'
);

select * from finish();
rollback;
