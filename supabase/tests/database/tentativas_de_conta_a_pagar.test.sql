-- tentativas_de_conta_a_pagar.test.sql
-- PRE-001, migration 73: a intenção de criar a conta a pagar existe antes do
-- POST, e o banco — não um `if` no TypeScript — decide se a mesma operação
-- pode ser enviada de novo.
--
-- REINTRODUZIR O DEFEITO: troque o `\ir` da migration 73 por nada; todas as
-- asserções falham (a tabela e a função não existem). Para provar só o
-- conflito de conteúdo, remova o ramo `if v_existente.digest is distinct from
-- p_digest` da função: 9-12 falham. Para a pendência idêntica, remova o índice
-- `uq_tentativas_conta_pagar_pendencia`: 13-15 falham. Para "indeterminada
-- nunca vira recusada", remova o `raise` final do gatilho de transição: 24-26
-- falham.

begin;

-- Esqueleto: só a coluna que `tentativas_conta_pagar.titulo_id` referencia.
create table public.titulos_financeiros (
    id uuid primary key default gen_random_uuid()
);

insert into auth.users (id, email)
values ('73000000-0000-4000-8000-000000000001', 'owner-a-t73@orbita.test'),
       ('73000000-0000-4000-8000-000000000002', 'owner-b-t73@orbita.test');

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/21_convites_papeis_capacidades.sql
\ir ../../../database/73_tentativas_de_conta_a_pagar.sql

insert into public.organizacoes (id, nome, slug)
values ('73100000-0000-4000-8000-000000000001', 'Org T73 A', 'org-t73-a'),
       ('73100000-0000-4000-8000-000000000002', 'Org T73 B', 'org-t73-b');

insert into public.membros_organizacao (organizacao_id, user_id, papel)
values ('73100000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', 'owner'),
       ('73100000-0000-4000-8000-000000000002', '73000000-0000-4000-8000-000000000002', 'owner');

insert into public.titulos_financeiros (id) values ('73300000-0000-4000-8000-000000000001');

select plan(40);

-- Digests fixos: 64 hex, como o servidor calcula.
create temp table d as
select repeat('a', 64) as um, repeat('b', 64) as dois, repeat('c', 64) as tres, repeat('e', 64) as quatro;

-- ----------------------------------------------------------------------------
-- 1-4. Primeira reivindicação: a intenção nasce em_voo, época 1.
-- ----------------------------------------------------------------------------
create temp table r1 as
select * from public.reivindicar_tentativa_conta_pagar(
    '73100000-0000-4000-8000-000000000001', '73200000-0000-4000-8000-000000000001',
    (select um from d), 1200.00, '2026-09-10', '2026-08-29', null);

select is((select desfecho from r1), 'nova', '1. chave nova: desfecho nova');
select is((select estado from r1), 'em_voo', '2. a intenção nasce em_voo, antes de qualquer POST');
select is((select epoca from r1), 1, '3. quem reivindicou é o dono da época 1');
select isnt((select tentativa_id from r1), null, '4. devolve o id da tentativa');

-- ----------------------------------------------------------------------------
-- 5-8. Mesma chave, mesmo digest: é a MESMA operação — nada é inserido, e o
--      estado gravado volta (em_voo: quem chamou não envia).
-- ----------------------------------------------------------------------------
create temp table r2 as
select * from public.reivindicar_tentativa_conta_pagar(
    '73100000-0000-4000-8000-000000000001', '73200000-0000-4000-8000-000000000001',
    (select um from d), 1200.00, '2026-09-10', '2026-08-29', null);

select is((select desfecho from r2), 'repetida', '5. mesma chave + mesmo digest: repetida');
select is((select estado from r2), 'em_voo', '6. devolve o estado gravado (em voo), sem reabrir');
select is((select tentativa_id from r2), (select tentativa_id from r1), '7. aponta para a mesma tentativa');
select is((select count(*)::int from public.tentativas_conta_pagar
            where organizacao_id = '73100000-0000-4000-8000-000000000001'), 1,
          '8. nenhuma linha nova');

-- ----------------------------------------------------------------------------
-- 9-12. Mesma chave, OUTRO digest: conflito. Não executa e não devolve nada
--       da outra operação.
-- ----------------------------------------------------------------------------
create temp table r3 as
select * from public.reivindicar_tentativa_conta_pagar(
    '73100000-0000-4000-8000-000000000001', '73200000-0000-4000-8000-000000000001',
    (select dois from d), 999.00, '2026-09-10', '2026-08-29', null);

select is((select desfecho from r3), 'conflito_de_conteudo', '9. mesma chave + outro digest: conflito');
select is((select tentativa_id from r3), null, '10. o conflito não devolve o id da outra operação');
select is((select estado from r3), null, '11. nem o estado dela');
select is((select digest from public.tentativas_conta_pagar
            where chave = '73200000-0000-4000-8000-000000000001'), (select um from d),
          '12. o conflito não altera a tentativa gravada');

-- ----------------------------------------------------------------------------
-- 13-15. Outra chave para o MESMO lançamento enquanto o primeiro está
--        pendente: recusada, apontando a pendência (o recarregar da página).
-- ----------------------------------------------------------------------------
create temp table r4 as
select * from public.reivindicar_tentativa_conta_pagar(
    '73100000-0000-4000-8000-000000000001', '73200000-0000-4000-8000-000000000002',
    (select um from d), 1200.00, '2026-09-10', '2026-08-29', null);

select is((select desfecho from r4), 'pendencia_identica', '13. outra chave, mesmo lançamento pendente: pendência');
select is((select chave_pendente from r4), '73200000-0000-4000-8000-000000000001'::uuid,
          '14. aponta a chave pendente');
select is((select count(*)::int from public.tentativas_conta_pagar
            where chave = '73200000-0000-4000-8000-000000000002'), 0,
          '15. a segunda chave não chega a existir');

-- ----------------------------------------------------------------------------
-- 16-19. Isolamento: a mesma chave e o mesmo digest em outra organização são
--        outra operação; nenhuma leitura cruza a organização.
-- ----------------------------------------------------------------------------
create temp table rb as
select * from public.reivindicar_tentativa_conta_pagar(
    '73100000-0000-4000-8000-000000000002', '73200000-0000-4000-8000-000000000001',
    (select um from d), 1200.00, '2026-09-10', '2026-08-29', null);

select is((select desfecho from rb), 'nova', '16. mesma chave em outra organização: tentativa nova dela');
select isnt((select tentativa_id from rb), (select tentativa_id from r1), '17. não é a tentativa da organização A');

update public.tentativas_conta_pagar set estado = 'confirmada', bling_conta_id = '555'
 where id = (select tentativa_id from rb);

create temp table ra_de_novo as
select * from public.reivindicar_tentativa_conta_pagar(
    '73100000-0000-4000-8000-000000000001', '73200000-0000-4000-8000-000000000001',
    (select um from d), 1200.00, '2026-09-10', '2026-08-29', null);

select is((select estado from ra_de_novo), 'em_voo', '18. A continua vendo o próprio estado, não o de B');
select is((select bling_conta_id from ra_de_novo), null, '19. o id remoto de B não vaza para A');

-- ----------------------------------------------------------------------------
-- 20-23. Desfecho e transições permitidas.
-- ----------------------------------------------------------------------------
update public.tentativas_conta_pagar set estado = 'nao_enviada', motivo = 'credencial_indisponivel'
 where id = (select tentativa_id from r1) and estado = 'em_voo' and epoca = 1;

create temp table reaberta as
select * from public.reivindicar_tentativa_conta_pagar(
    '73100000-0000-4000-8000-000000000001', '73200000-0000-4000-8000-000000000001',
    (select um from d), 1200.00, '2026-09-10', '2026-08-30', null);

select is((select desfecho from reaberta), 'reaberta', '20. nao_enviada: a mesma chave reabre');
select is((select epoca from reaberta), 2, '21. reabrir cria um dono novo (época 2)');
select is((select data_emissao from public.tentativas_conta_pagar where id = (select tentativa_id from r1)),
          '2026-08-30'::date, '22. a emissão passa a ser a do novo envio');

update public.tentativas_conta_pagar set estado = 'indeterminada', motivo = 'sem_resposta'
 where id = (select tentativa_id from r1) and estado = 'em_voo' and epoca = 1;
select is((select estado from public.tentativas_conta_pagar where id = (select tentativa_id from r1)), 'em_voo',
          '23. o dono antigo (época 1) não grava desfecho depois da reabertura');

update public.tentativas_conta_pagar set estado = 'indeterminada', motivo = 'sem_resposta'
 where id = (select tentativa_id from r1) and estado = 'em_voo' and epoca = 2;

-- ----------------------------------------------------------------------------
-- 24-27. indeterminada não sai do lugar nesta migration, e repetir não reenvia.
-- ----------------------------------------------------------------------------
select throws_ok(
    $$update public.tentativas_conta_pagar set estado = 'recusada'
       where chave = '73200000-0000-4000-8000-000000000001'
         and organizacao_id = '73100000-0000-4000-8000-000000000001'$$,
    '23514', null, '24. indeterminada nunca vira recusada');
select throws_ok(
    $$update public.tentativas_conta_pagar set estado = 'em_voo', epoca = epoca + 1
       where chave = '73200000-0000-4000-8000-000000000001'
         and organizacao_id = '73100000-0000-4000-8000-000000000001'$$,
    '23514', null, '25. indeterminada não reabre para um novo POST');
select throws_ok(
    $$update public.tentativas_conta_pagar set estado = 'confirmada', bling_conta_id = '999'
       where chave = '73200000-0000-4000-8000-000000000001'
         and organizacao_id = '73100000-0000-4000-8000-000000000001'$$,
    '23514', null, '26. nem é confirmada sem reconciliação (PRE-002)');

create temp table r_indeterminada as
select * from public.reivindicar_tentativa_conta_pagar(
    '73100000-0000-4000-8000-000000000001', '73200000-0000-4000-8000-000000000001',
    (select um from d), 1200.00, '2026-09-10', '2026-08-31', null);
select is((select estado || '/' || desfecho from r_indeterminada), 'indeterminada/repetida',
          '27. repetir uma indeterminada devolve indeterminada, sem reabrir');

-- ----------------------------------------------------------------------------
-- 28-32. Confirmada: exige o id remoto, ganha o título uma vez, e é final.
-- ----------------------------------------------------------------------------
create temp table rc as
select * from public.reivindicar_tentativa_conta_pagar(
    '73100000-0000-4000-8000-000000000001', '73200000-0000-4000-8000-000000000003',
    (select tres from d), 50.00, '2026-09-11', '2026-08-29', 7001);

select throws_ok(
    $$update public.tentativas_conta_pagar set estado = 'confirmada'
       where chave = '73200000-0000-4000-8000-000000000003'$$,
    '23514', null, '28. confirmada sem bling_conta_id é recusada pela constraint');

update public.tentativas_conta_pagar set estado = 'confirmada', bling_conta_id = '88123'
 where id = (select tentativa_id from rc) and estado = 'em_voo' and epoca = 1;
update public.tentativas_conta_pagar set titulo_id = '73300000-0000-4000-8000-000000000001'
 where id = (select tentativa_id from rc) and estado = 'confirmada' and titulo_id is null;

select is((select titulo_id from public.tentativas_conta_pagar where id = (select tentativa_id from rc)),
          '73300000-0000-4000-8000-000000000001'::uuid, '29. a confirmada ganha o vínculo com o título');
select throws_ok(
    $$update public.tentativas_conta_pagar set bling_conta_id = '1'
       where chave = '73200000-0000-4000-8000-000000000003'$$,
    '23514', null, '30. o id remoto de uma confirmada é imutável');
select throws_ok(
    $$update public.tentativas_conta_pagar set estado = 'recusada', bling_conta_id = null
       where chave = '73200000-0000-4000-8000-000000000003'$$,
    '23514', null, '31. confirmada é final');

create temp table rc2 as
select * from public.reivindicar_tentativa_conta_pagar(
    '73100000-0000-4000-8000-000000000001', '73200000-0000-4000-8000-000000000003',
    (select tres from d), 50.00, '2026-09-11', '2026-08-29', 7001);
select is((select estado || '/' || bling_conta_id || '/' || desfecho from rc2), 'confirmada/88123/repetida',
          '32. repetir uma confirmada devolve o id remoto, sem reenviar');

-- ----------------------------------------------------------------------------
-- 33-34. Identidade imutável e recusa final.
-- ----------------------------------------------------------------------------
select throws_ok(
    $$update public.tentativas_conta_pagar set digest = repeat('f', 64)
       where chave = '73200000-0000-4000-8000-000000000003'$$,
    '23514', null, '33. o digest de uma tentativa não muda');

create temp table rr as
select * from public.reivindicar_tentativa_conta_pagar(
    '73100000-0000-4000-8000-000000000001', '73200000-0000-4000-8000-000000000004',
    (select quatro from d), 10.00, '2026-09-12', '2026-08-29', null);
update public.tentativas_conta_pagar set estado = 'recusada', motivo = 'recusa_definitiva'
 where id = (select tentativa_id from rr) and estado = 'em_voo' and epoca = 1;
select throws_ok(
    $$update public.tentativas_conta_pagar set estado = 'em_voo', epoca = epoca + 1
       where chave = '73200000-0000-4000-8000-000000000004'$$,
    '23514', null, '34. recusada não reabre');

-- ----------------------------------------------------------------------------
-- 35-40. Privilégios, RLS e entrada inválida.
-- ----------------------------------------------------------------------------
select ok(not has_table_privilege('authenticated', 'public.tentativas_conta_pagar', 'select'),
          '35. o navegador (authenticated) não lê tentativas');
select ok(not has_table_privilege('anon', 'public.tentativas_conta_pagar', 'insert'),
          '36. anon não escreve tentativas');
select ok(not has_table_privilege('service_role', 'public.tentativas_conta_pagar', 'delete'),
          '37. nem o servidor apaga tentativa: é histórico');
select ok(not has_function_privilege('authenticated',
          'public.reivindicar_tentativa_conta_pagar(uuid, uuid, text, numeric, date, date, bigint)', 'execute'),
          '38. só o servidor reivindica');
select is((select relrowsecurity from pg_class where oid = 'public.tentativas_conta_pagar'::regclass), true,
          '39. RLS ligada');
select throws_ok(
    $$select * from public.reivindicar_tentativa_conta_pagar(
        '73100000-0000-4000-8000-000000000001', '73200000-0000-4000-8000-000000000009',
        'nao-e-hex', 1.00, '2026-09-10', '2026-08-29', null)$$,
    '23514', null, '40. digest fora do formato é recusado pelo banco');

select * from finish();
rollback;
