-- convite_nominal_identidade.test.sql
-- Ticket 06: o convite é nominal, exige e-mail PROVADO, e não é mecanismo de
-- mudança de papel.
--
-- As migrations 63 e 64 mudam três coisas em `aceitar_convite_organizacao`, e
-- este teste prova as três — junto com tudo o que a 49 já garantia e que não
-- podia regredir (expiração, uso único, entitlement, status de ciclo de vida).
--
-- REINTRODUZIR OS DEFEITOS:
--   - apague o bloco de identidade → a seção 1 falha (a conta errada volta a
--     entrar, consumindo o convite de outra pessoa);
--   - apague a condição `email_confirmed_at is null` da migration 64 → a seção
--     2 falha (quem apenas *digitou* o endereço do convite no cadastro passa a
--     aceitá-lo);
--   - troque `do nothing` por `do update set papel` → a seção 4 falha (o owner
--     é rebaixado a member por um convite de member).

begin;

-- O `auth.users` do laboratório é o esqueleto da imagem base do Supabase, e a
-- coluna `email_confirmed_at` só existe lá porque o preparo do laboratório a
-- acrescenta antes das migrations (`alinharStubDeAuthComProducao`, em
-- `scripts/database-lab.mjs`, que explica por quê). Ela nasce nula, então nada
-- aqui é afrouxado: quem não for semeado como confirmado continua recusado.

-- `email_confirmed_at` entra EXPLÍCITO em cada usuário, e é o eixo do teste.
-- Semear todo mundo como confirmado — ou pior, semear `null` e mesmo assim
-- chamar o cenário de "e-mail verificado" — faria o caso (b) medir outra coisa
-- e o teste passaria sem provar nada. A convidada de e-mail não confirmado
-- existe justamente para ser recusada.
insert into auth.users (id, email, email_confirmed_at)
values
    ('63000000-0000-4000-8000-000000000001', 'owner-nominal@orbita.test', now()),
    ('63000000-0000-4000-8000-000000000002', 'convidada-nominal@orbita.test', now()),
    ('63000000-0000-4000-8000-000000000003', 'estranho-nominal@orbita.test', now()),
    ('63000000-0000-4000-8000-000000000004', 'nao-confirmada@orbita.test', null)
on conflict do nothing;

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/21_convites_papeis_capacidades.sql
\ir ../../../database/33_planos_limites_entitlements.sql
\ir ../../../database/34_integrar_stripe_assinaturas.sql
\ir ../../../database/35_suspensao_retencao_encerramento.sql
\ir ../../../database/49_entitlement_reserva_atomica_ordering.sql
\ir ../../../database/63_convite_nominal_identidade_e_papel_preservado.sql
\ir ../../../database/64_convite_exige_email_confirmado.sql

grant usage on schema public to authenticated, anon;
grant all on all tables in schema public to authenticated, service_role;
grant execute on function public.aceitar_convite_organizacao(text) to authenticated, service_role;
grant execute on function public.criar_convite_organizacao(uuid, text, text, text) to authenticated, service_role;

select plan(19);

-- A confirmação semeada é a premissa do teste: se ela não valer, o caso (b)
-- não estaria medindo confirmação, e o (a) passaria por acidente.
select is(
    (select count(*)::int from auth.users
      where id in ('63000000-0000-4000-8000-000000000002'::uuid, '63000000-0000-4000-8000-000000000004'::uuid)
        and email_confirmed_at is not null),
    1,
    'Premissa do teste: das duas convidadas, exatamente uma tem e-mail confirmado'
);

-- Setup: a owner cria a organização e convida a colaboradora pelo e-mail dela.
set local role authenticated;
set local request.jwt.claim.sub = '63000000-0000-4000-8000-000000000001';

create temp table temp_org as
select public.criar_organizacao_atomica('Org Nominal', 'org-nominal-t06') as org_id;

-- O e-mail entra com espaços e caixa alta de propósito: a criação normaliza com
-- `lower(trim())`, e a aceitação tem de comparar pela MESMA normalização.
create temp table temp_convite as
select public.criar_convite_organizacao(
    (select org_id from temp_org),
    '  Convidada-Nominal@Orbita.TEST  ',
    'member',
    'token-nominal-convidada-0123456789ab'
) as convite_id;

select is(
    (select email from public.convites_organizacao where token = 'token-nominal-convidada-0123456789ab'),
    'convidada-nominal@orbita.test',
    'A criacao do convite normaliza o e-mail do destinatario'
);

-- ---------------------------------------------------------------------------
-- 1. A CONTA ERRADA NÃO ACEITA, E NÃO DEIXA RASTRO.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = '63000000-0000-4000-8000-000000000003';

select throws_ok(
    $$select public.aceitar_convite_organizacao('token-nominal-convidada-0123456789ab')$$,
    '42501',
    null,
    'Conta autenticada com outro e-mail nao aceita o convite nominal'
);

reset role;

select is(
    (select status from public.convites_organizacao where token = 'token-nominal-convidada-0123456789ab'),
    'pending',
    'A recusa por identidade nao consome o convite: ele continua pending'
);

select is(
    (select count(*)::int from public.membros_organizacao
      where organizacao_id = (select org_id from temp_org)
        and user_id = '63000000-0000-4000-8000-000000000003'::uuid),
    0,
    'A recusa por identidade nao cria membership para a conta errada'
);

select is(
    (select count(*)::int from public.membros_organizacao where organizacao_id = (select org_id from temp_org)),
    1,
    'A recusa por identidade nao reserva vaga: a organizacao segue com so a owner'
);

-- ---------------------------------------------------------------------------
-- 2. O E-MAIL CERTO, MAS NÃO CONFIRMADO, TAMBÉM NÃO ACEITA.
--
-- Este é o caso que a migration 64 existe para fechar. Sem ela, quem souber o
-- endereço de um convite pendente cria uma conta com esse endereço, não
-- confirma nada, e entra: `auth.users.email` sozinho é o que a pessoa digitou,
-- não o que ela provou possuir.
--
-- O convite aqui é OUTRO, dirigido ao endereço não confirmado, para separar
-- "recusada por não ser a destinatária" de "recusada por não ter confirmado".
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = '63000000-0000-4000-8000-000000000001';

create temp table temp_convite_nao_confirmada as
select public.criar_convite_organizacao(
    (select org_id from temp_org),
    'nao-confirmada@orbita.test',
    'member',
    'token-nominal-nao-confirmada-99887766'
) as convite_id;

set local role authenticated;
set local request.jwt.claim.sub = '63000000-0000-4000-8000-000000000004';

select throws_ok(
    $$select public.aceitar_convite_organizacao('token-nominal-nao-confirmada-99887766')$$,
    '42501',
    null,
    'Conta com o e-mail EXATO do convite, mas sem confirmacao, nao aceita'
);

reset role;

select is(
    (select status from public.convites_organizacao where token = 'token-nominal-nao-confirmada-99887766'),
    'pending',
    'A recusa por e-mail nao confirmado nao consome o convite'
);

select is(
    (select count(*)::int from public.membros_organizacao
      where organizacao_id = (select org_id from temp_org)
        and user_id = '63000000-0000-4000-8000-000000000004'::uuid),
    0,
    'A recusa por e-mail nao confirmado nao cria membership'
);

select is(
    (select count(*)::int from public.membros_organizacao where organizacao_id = (select org_id from temp_org)),
    1,
    'A recusa por e-mail nao confirmado nao reserva vaga'
);

-- ---------------------------------------------------------------------------
-- 3. A CONTA CERTA, COM E-MAIL CONFIRMADO, ACEITA — UMA VEZ SÓ.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = '63000000-0000-4000-8000-000000000002';

select is(
    (select public.aceitar_convite_organizacao('token-nominal-convidada-0123456789ab')),
    (select org_id from temp_org),
    'A conta cujo e-mail verificado corresponde ao convite entra na organizacao'
);

select is(
    (select papel from public.membros_organizacao
      where organizacao_id = (select org_id from temp_org)
        and user_id = '63000000-0000-4000-8000-000000000002'::uuid),
    'member',
    'A membership nasce com o papel pre-determinado pelo convite'
);

select throws_ok(
    $$select public.aceitar_convite_organizacao('token-nominal-convidada-0123456789ab')$$,
    '22000',
    null,
    'O convite e de uso unico: a segunda aceitacao da mesma conta falha'
);

-- ---------------------------------------------------------------------------
-- 4. O CONVITE NÃO MUDA O PAPEL DE QUEM JÁ É MEMBRO — NEM O DA OWNER.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = '63000000-0000-4000-8000-000000000001';

-- A owner cria um convite de `member` para o próprio e-dela. Antes da migration
-- 63 isto era suficiente para a organização perder o dono.
create temp table temp_convite_owner as
select public.criar_convite_organizacao(
    (select org_id from temp_org),
    'owner-nominal@orbita.test',
    'member',
    'token-nominal-owner-abcdef987654321'
) as convite_id;

select lives_ok(
    $$select public.aceitar_convite_organizacao('token-nominal-owner-abcdef987654321')$$,
    'A owner aceita o convite valido dirigido a ela sem erro'
);

reset role;

select is(
    (select papel from public.membros_organizacao
      where organizacao_id = (select org_id from temp_org)
        and user_id = '63000000-0000-4000-8000-000000000001'::uuid),
    'owner',
    'O papel de quem ja e membro e preservado integralmente: a owner continua owner'
);

select is(
    (select count(*)::int from public.membros_organizacao where organizacao_id = (select org_id from temp_org)),
    2,
    'Aceitar como membro existente nao duplica membership nem reserva vaga nova'
);

select is(
    (select status from public.convites_organizacao where token = 'token-nominal-owner-abcdef987654321'),
    'accepted',
    'O convite valido de um membro existente e consumido, como manda o contrato'
);

-- ---------------------------------------------------------------------------
-- 5. CONVITE EXPIRADO FALHA, E NÃO É CONSUMIDO.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = '63000000-0000-4000-8000-000000000001';

create temp table temp_convite_expirado as
select public.criar_convite_organizacao(
    (select org_id from temp_org),
    'convidada-nominal@orbita.test',
    'member',
    'token-nominal-expirado-5566778899aa'
) as convite_id;

reset role;

update public.convites_organizacao
set expires_at = now() - interval '1 day'
where token = 'token-nominal-expirado-5566778899aa';

set local role authenticated;
set local request.jwt.claim.sub = '63000000-0000-4000-8000-000000000002';

select throws_ok(
    $$select public.aceitar_convite_organizacao('token-nominal-expirado-5566778899aa')$$,
    '22000',
    null,
    'Convite expirado falha mesmo para a conta certa'
);

reset role;

-- O `update ... set status = 'expired'` que a funcao faz antes do `raise` e
-- DESCARTADO junto com a excecao: a subtransacao inteira volta atras, e o
-- convite continua `pending`. Isso e verdade desde a migration 21 e a 63 nao
-- mexeu nisso — a assercao existe para dizer o que o banco faz de fato, em vez
-- de repetir o que o codigo parece prometer. O que importa para o contrato do
-- Ticket 06 esta garantido: o convite expirado NAO e consumido.
select is(
    (select status from public.convites_organizacao where token = 'token-nominal-expirado-5566778899aa'),
    'pending',
    'O convite expirado nao e consumido: ele nao vira accepted (a marcacao expired volta atras com a excecao)'
);

select * from finish();
rollback;
