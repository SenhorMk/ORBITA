-- convite_nominal_identidade.test.sql
-- Ticket 06: o convite é nominal, e não é mecanismo de mudança de papel.
--
-- A migration 63 muda duas coisas em `aceitar_convite_organizacao`, e este
-- teste prova as duas — junto com tudo o que a 49 já garantia e que não podia
-- regredir (expiração, uso único, entitlement, status de ciclo de vida).
--
-- REINTRODUZIR OS DEFEITOS:
--   - apague o bloco de identidade da migration 63 → a seção 1 falha (a conta
--     errada volta a entrar, consumindo o convite de outra pessoa);
--   - troque `do nothing` por `do update set papel` → a seção 3 falha (o owner
--     é rebaixado a member por um convite de member).

begin;

insert into auth.users (id, email)
values
    ('63000000-0000-4000-8000-000000000001', 'owner-nominal@orbita.test'),
    ('63000000-0000-4000-8000-000000000002', 'convidada-nominal@orbita.test'),
    ('63000000-0000-4000-8000-000000000003', 'estranho-nominal@orbita.test')
on conflict do nothing;

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/21_convites_papeis_capacidades.sql
\ir ../../../database/33_planos_limites_entitlements.sql
\ir ../../../database/34_integrar_stripe_assinaturas.sql
\ir ../../../database/35_suspensao_retencao_encerramento.sql
\ir ../../../database/49_entitlement_reserva_atomica_ordering.sql
\ir ../../../database/63_convite_nominal_identidade_e_papel_preservado.sql

grant usage on schema public to authenticated, anon;
grant all on all tables in schema public to authenticated, service_role;
grant execute on function public.aceitar_convite_organizacao(text) to authenticated, service_role;
grant execute on function public.criar_convite_organizacao(uuid, text, text, text) to authenticated, service_role;

select plan(14);

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
-- 2. A CONTA CERTA ACEITA, UMA VEZ SÓ.
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
-- 3. O CONVITE NÃO MUDA O PAPEL DE QUEM JÁ É MEMBRO — NEM O DA OWNER.
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
-- 4. CONVITE EXPIRADO FALHA, E NÃO É CONSUMIDO.
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
