-- convites_organizacao.test.sql
-- Ticket 25: Convites, papéis e capacidades organizacionais

begin;

insert into auth.users (id, email)
values ('96000000-0000-4000-8000-000000000001', 'owner-invites@orbita.test'),
       ('96000000-0000-4000-8000-000000000002', 'collab-invites@orbita.test'),
       ('96000000-0000-4000-8000-000000000003', 'stranger-invites@orbita.test');

\ir .generated/20_organizacao_membership_ativa.inc
\ir .generated/21_convites_papeis_capacidades.inc

select plan(7);

-- 1. Owner cria organização
set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-4000-8000-000000000001';

create temp table temp_org as
select public.criar_organizacao_atomica('Org Convites', 'org-convites') as org_id;

-- 2. Owner cria convite para colaborador
create temp table temp_convite as
select public.criar_convite_organizacao(
    (select org_id from temp_org),
    'collab-invites@orbita.test',
    'member',
    'token-seguro-1234567890abcdef'
) as convite_id;

select is(
    (select count(*) from public.convites_organizacao where token = 'token-seguro-1234567890abcdef'),
    1::bigint,
    'Convite foi criado pelo owner com sucesso'
);

-- 3. Estranho tenta criar convite na organização (deve falhar)
set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-4000-8000-000000000003';

select throws_ok(
    format($$select public.criar_convite_organizacao('%s', 'outro@orbita.test', 'member', 'token-stranger-xyz')$$, (select org_id from temp_org)),
    '42501',
    null,
    'Usuario de fora e impedido de criar convites na organizacao'
);

-- 4. Colaborador aceita o convite
set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-4000-8000-000000000002';

select is(
    (select public.aceitar_convite_organizacao('token-seguro-1234567890abcdef')),
    (select org_id from temp_org),
    'Colaborador aceita o convite e recebe o ID da organizacao'
);

select is(
    (select papel from public.membros_organizacao where user_id = '96000000-0000-4000-8000-000000000002'::uuid and organizacao_id = (select org_id from temp_org)),
    'member',
    'Membership criada com papel correto pre-determinado pelo convite'
);

-- 5. Tentativa de reusar o mesmo convite (uso único estrito)
select throws_ok(
    $$select public.aceitar_convite_organizacao('token-seguro-1234567890abcdef')$$,
    '22000',
    null,
    'Convite de uso unico nao pode ser reutilizado'
);

-- 6. Owner revoga o membro com efeito imediato
set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-4000-8000-000000000001';

select is(
    (select public.revogar_membro_organizacao((select org_id from temp_org), '96000000-0000-4000-8000-000000000002'::uuid)),
    true,
    'Membro foi revogado com sucesso pelo owner'
);

select is(
    (select count(*) from public.membros_organizacao where user_id = '96000000-0000-4000-8000-000000000002'::uuid and organizacao_id = (select org_id from temp_org)),
    0::bigint,
    'Membership do membro revogado foi excluida imediatamente'
);

select * from finish();
rollback;
