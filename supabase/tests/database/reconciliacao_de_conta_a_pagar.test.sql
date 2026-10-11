-- reconciliacao_de_conta_a_pagar.test.sql
-- PRE-002, migration 74: sair de `indeterminada` só com recibo, baixa com
-- identidade própria, recibos append-only.
--
-- REINTRODUZIR O DEFEITO: no gatilho de transição da criação, aceite
-- `indeterminada → confirmada` sem o `exists (...)` do recibo: 6 falha. Aceite
-- `indeterminada → nao_enviada`: 7 falha. Remova o gatilho
-- `tg_reconciliacoes_conta_pagar_imutavel`: 16-17 falham. Remova a verificação
-- de `fn_baixa_conta_pagar_nasce_de_confirmada`: 20-21 falham. Tire
-- `quitacao_solicitada` da identidade imutável: 31 falha. Remova o `exists` de
-- `conta_de_outra_operacao` no registro: 32-33 falham. Remova o índice
-- `uq_tentativas_conta_pagar_conta_remota`: 34 falha. Na listagem, tire a baixa
-- `recusada` do predicado, ou procure o título sem filtrar a organização: 44 e
-- 46 falham. Tire `declaracao_do_operador` do check do método: 47 falha. Tire
-- da função de registro as exigências de borderô/método/motivo e os checks
-- `ck_baixas_conta_pagar_confirmada_tem_bordero` e
-- `ck_reconciliacoes_conta_pagar_baixa_tem_bordero`: 48-57 falham. Tire a
-- exigência de situação remota `Pago` na baixa confirmada: 58-60 falham. Tire
-- `situacao_bling = 2` do predicado da listagem: 44 e 46 falham.

begin;

create table public.titulos_financeiros (
    id uuid primary key default gen_random_uuid(),
    organizacao_id uuid not null,
    situacao text not null default 'aberto',
    situacao_bling smallint
);

insert into auth.users (id, email)
values ('74000000-0000-4000-8000-000000000001', 'owner-a-t74@orbita.test'),
       ('74000000-0000-4000-8000-000000000002', 'owner-b-t74@orbita.test');

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/21_convites_papeis_capacidades.sql
\ir ../../../database/73_tentativas_de_conta_a_pagar.sql
\ir ../../../database/74_reconciliacao_de_conta_a_pagar.sql

insert into public.organizacoes (id, nome, slug)
values ('74100000-0000-4000-8000-000000000001', 'Org T74 A', 'org-t74-a'),
       ('74100000-0000-4000-8000-000000000002', 'Org T74 B', 'org-t74-b');

select plan(67);

create temp table ids as select
    '74100000-0000-4000-8000-000000000001'::uuid as org_a,
    '74100000-0000-4000-8000-000000000002'::uuid as org_b,
    '74000000-0000-4000-8000-000000000001'::uuid as ator;

-- Reivindica e deixa a tentativa no estado pedido, pelo caminho legítimo.
create function pg_temp.tentativa(p_org uuid, p_chave uuid, p_digest text, p_ref text, p_estado text)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
    select tentativa_id into v_id from public.reivindicar_tentativa_conta_pagar(
        p_org, p_chave, p_digest, 100.00, '2026-10-20', '2026-10-09', 7001, p_ref);
    if p_estado = 'confirmada' then
        update public.tentativas_conta_pagar set estado = 'confirmada', bling_conta_id = '880' where id = v_id;
    elsif p_estado <> 'em_voo' then
        update public.tentativas_conta_pagar set estado = p_estado, motivo = 'sem_resposta' where id = v_id;
    end if;
    return v_id;
end $$;

-- ----------------------------------------------------------------------------
-- 1-4. A referência enviada ao Bling.
-- ----------------------------------------------------------------------------
create temp table r1 as select * from public.reivindicar_tentativa_conta_pagar(
    (select org_a from ids), '74200000-0000-4000-8000-000000000001', repeat('a', 64),
    100.00, '2026-10-20', '2026-10-09', 7001, 'ORB-0123456789ABCDEF');
select is((select numero_documento from r1), 'ORB-0123456789ABCDEF', '1. a reivindicação grava e devolve a referência');

create temp table r1_compat as select * from public.reivindicar_tentativa_conta_pagar(
    p_organizacao_id => (select org_a from ids), p_chave => '74200000-0000-4000-8000-000000000009',
    p_digest => repeat('9', 64), p_valor => 1.00, p_data_vencimento => '2026-10-20',
    p_data_emissao => '2026-10-09', p_contato_bling_id => null);
select is((select desfecho || '/' || coalesce(numero_documento, 'sem') from r1_compat), 'nova/sem',
          '2. a chamada da versão anterior (sete argumentos nomeados) continua funcionando, sem referência');

create temp table r_ref_repetida as select * from public.reivindicar_tentativa_conta_pagar(
    (select org_a from ids), '74200000-0000-4000-8000-000000000002', repeat('b', 64),
    1.00, '2026-10-20', '2026-10-09', null, 'ORB-0123456789ABCDEF');
-- O índice único recusa; a função devolve pendência SEM chave a apontar, que o
-- servidor trata como indisponível (falha fechada) — e nenhuma linha nasce.
select ok((select desfecho = 'pendencia_identica' and chave_pendente is null from r_ref_repetida)
          and not exists (select 1 from public.tentativas_conta_pagar where chave = '74200000-0000-4000-8000-000000000002'),
          '3. a mesma referência não serve a duas tentativas da organização');
select throws_ok(
    $$update public.tentativas_conta_pagar set numero_documento = 'ORB-FFFFFFFFFFFFFFFF'
       where chave = '74200000-0000-4000-8000-000000000001'$$,
    '23514', null, '4. a referência é identidade imutável');

-- ----------------------------------------------------------------------------
-- 5-9. A única saída de `indeterminada` é `confirmada`, e só com recibo.
-- ----------------------------------------------------------------------------
update public.tentativas_conta_pagar set estado = 'indeterminada', motivo = 'sem_resposta'
 where chave = '74200000-0000-4000-8000-000000000001';

select throws_ok(
    $$update public.tentativas_conta_pagar set estado = 'confirmada', bling_conta_id = '880'
       where chave = '74200000-0000-4000-8000-000000000001'$$,
    '23514', null, '5. indeterminada → confirmada sem recibo é recusada, mesmo para o service_role');

create temp table rec as select * from public.registrar_reconciliacao_conta_pagar(
    (select org_a from ids), '74200000-0000-4000-8000-000000000001', 'criacao', (select ator from ids),
    'corr-1', 'referencia_no_numero_documento', 'confirmada', null, '880', null, 1, 1);
select is((select resultado || '/' || estado || '/' || bling_conta_id from rec), 'confirmada/confirmada/880',
          '6. com prova, a reconciliação confirma e grava a conta remota');

create temp table t3 as select pg_temp.tentativa((select org_a from ids), '74200000-0000-4000-8000-000000000003', repeat('c', 64),
                         'ORB-1111111111111111', 'indeterminada') as id;
select throws_ok(
    $$update public.tentativas_conta_pagar set estado = 'nao_enviada'
       where chave = '74200000-0000-4000-8000-000000000003'$$,
    '23514', null, '7. busca vazia não vira nao_enviada: a transição não existe');
select throws_ok(
    $$update public.tentativas_conta_pagar set estado = 'em_voo', epoca = epoca + 1
       where chave = '74200000-0000-4000-8000-000000000003'$$,
    '23514', null, '8. nem volta a em_voo para um novo POST');

create temp table manual as select * from public.registrar_reconciliacao_conta_pagar(
    (select org_a from ids), '74200000-0000-4000-8000-000000000003', 'criacao', (select ator from ids),
    'corr-2', 'referencia_no_numero_documento', 'revisao_manual', 'nenhum_candidato', null, null, null, 0);
select is((select resultado || '/' || estado from manual), 'revisao_manual/indeterminada',
          '9. revisão manual grava o recibo e não muda o estado');

-- ----------------------------------------------------------------------------
-- 10-13. Reconciliações concorrentes se serializam: uma conta remota só.
-- ----------------------------------------------------------------------------
create temp table de_novo as select * from public.registrar_reconciliacao_conta_pagar(
    (select org_a from ids), '74200000-0000-4000-8000-000000000001', 'criacao', (select ator from ids),
    'corr-3', 'referencia_no_numero_documento', 'confirmada', null, '880', null, 1, 1);
select is((select resultado from de_novo), 'ja_confirmada', '10. a mesma conta de novo: ja_confirmada');

create temp table outra as select * from public.registrar_reconciliacao_conta_pagar(
    (select org_a from ids), '74200000-0000-4000-8000-000000000001', 'criacao', (select ator from ids),
    'corr-4', 'referencia_no_numero_documento', 'confirmada', null, '999', null, 1, 1);
select is((select resultado || '/' || bling_conta_id from outra), 'divergente/880',
          '11. outra conta remota não substitui a confirmada: divergente');
select is((select bling_conta_id from public.tentativas_conta_pagar
            where chave = '74200000-0000-4000-8000-000000000001'), '880', '12. a conta gravada continua a primeira');
select is((select count(*)::int from public.reconciliacoes_conta_pagar
            where tentativa_id = (select tentativa_id from r1)), 3, '13. cada decisão deixa um recibo');

-- ----------------------------------------------------------------------------
-- 14-15. Isolamento.
-- ----------------------------------------------------------------------------
select throws_ok(
    $$select * from public.registrar_reconciliacao_conta_pagar(
        '74100000-0000-4000-8000-000000000002', '74200000-0000-4000-8000-000000000001', 'criacao',
        '74000000-0000-4000-8000-000000000002', 'corr-5', 'referencia_no_numero_documento', 'confirmada',
        null, '880', null, 1, 1)$$,
    'P0002', null, '14. a organização B não reconcilia a operação de A');
select is((select count(*)::int from public.reconciliacoes_conta_pagar
            where organizacao_id = (select org_b from ids)), 0, '15. e nada é gravado para B');

-- ----------------------------------------------------------------------------
-- 16-18. Recibo append-only.
-- ----------------------------------------------------------------------------
select throws_ok(
    $$update public.reconciliacoes_conta_pagar set resultado = 'revisao_manual'$$,
    '23514', null, '16. recibo não é sobrescrito');
select throws_ok(
    $$delete from public.reconciliacoes_conta_pagar$$,
    '23514', null, '17. recibo não é apagado');
select throws_ok(
    $$select * from public.registrar_reconciliacao_conta_pagar(
        '74100000-0000-4000-8000-000000000001', '74200000-0000-4000-8000-000000000003', 'criacao',
        '74000000-0000-4000-8000-000000000001', 'corr-6', 'referencia_no_numero_documento', 'confirmada',
        null, null, null, 1, 1)$$,
    '22023', null, '18. confirmação sem conta remota é recusada');

-- ----------------------------------------------------------------------------
-- 19-29. A baixa.
-- ----------------------------------------------------------------------------
create temp table b1 as select * from public.reivindicar_baixa_conta_pagar(
    (select org_a from ids), (select tentativa_id from r1), '880', '2026-10-09');
select is((select desfecho || '/' || estado || '/' || epoca from b1), 'nova/em_voo/1', '19. a intenção de baixa nasce antes do POST');

select throws_ok(
    $$select * from public.reivindicar_baixa_conta_pagar(
        '74100000-0000-4000-8000-000000000001',
        (select id from public.tentativas_conta_pagar where chave = '74200000-0000-4000-8000-000000000003'),
        '880', '2026-10-09')$$,
    '23514', null, '20. baixa não nasce de uma criação não confirmada');
select throws_ok(
    $$select * from public.reivindicar_baixa_conta_pagar(
        '74100000-0000-4000-8000-000000000001',
        (select id from public.tentativas_conta_pagar where chave = '74200000-0000-4000-8000-000000000001'),
        '999', '2026-10-09')$$,
    '23514', null, '21. nem para outra conta remota');

create temp table b2 as select * from public.reivindicar_baixa_conta_pagar(
    (select org_a from ids), (select tentativa_id from r1), '880', '2026-10-09');
select is((select desfecho || '/' || baixa_id::text from b2), 'repetida/' || (select baixa_id::text from b1),
          '22. repetir a quitação reutiliza a mesma intenção');

update public.baixas_conta_pagar set estado = 'indeterminada', motivo = 'sem_resposta'
 where id = (select baixa_id from b1) and estado = 'em_voo' and epoca = 1;
select throws_ok(
    $$update public.baixas_conta_pagar set estado = 'em_voo', epoca = epoca + 1
       where tentativa_id = (select id from public.tentativas_conta_pagar where chave = '74200000-0000-4000-8000-000000000001')$$,
    '23514', null, '23. baixa ambígua não reabre para uma nova baixa');
select throws_ok(
    $$update public.baixas_conta_pagar set estado = 'confirmada'
       where tentativa_id = (select id from public.tentativas_conta_pagar where chave = '74200000-0000-4000-8000-000000000001')$$,
    '23514', null, '24. nem é confirmada sem recibo');

create temp table b3 as select * from public.reivindicar_baixa_conta_pagar(
    (select org_a from ids), (select tentativa_id from r1), '880', '2026-10-10');
select is((select desfecho || '/' || estado from b3), 'repetida/indeterminada', '25. indeterminada: a reivindicação não autoriza envio');

create temp table rb as select * from public.registrar_reconciliacao_conta_pagar(
    (select org_a from ids), '74200000-0000-4000-8000-000000000001', 'baixa', (select ator from ids),
    'corr-7', 'leitura_de_borderos', 'confirmada', null, '880', '555', 2, null);
select is((select resultado || '/' || estado from rb), 'confirmada/confirmada', '26. conta quitada no Bling: baixa confirmada');
select is((select bordero_id from public.baixas_conta_pagar where id = (select baixa_id from b1)), '555',
          '27. o borderô observado fica registrado');

create temp table rb2 as select * from public.registrar_reconciliacao_conta_pagar(
    (select org_a from ids), '74200000-0000-4000-8000-000000000001', 'baixa', (select ator from ids),
    'corr-8', 'leitura_de_borderos', 'confirmada', null, '999', '556', 2, null);
select is((select resultado from rb2), 'divergente', '28. a baixa não é confirmada por outra conta remota');
select is((select estado from public.baixas_conta_pagar where id = (select baixa_id from b1)), 'confirmada',
          '29. e continua confirmada pela conta certa');

-- ----------------------------------------------------------------------------
-- 30-35. A quitação pedida é durável; uma conta remota, uma operação.
-- ----------------------------------------------------------------------------
create temp table r_quita as select * from public.reivindicar_tentativa_conta_pagar(
    (select org_a from ids), '74200000-0000-4000-8000-000000000005', repeat('e', 64),
    50.00, '2026-10-20', '2026-10-09', 7001, 'ORB-5555555555555555', true);
select is((select quitacao_solicitada from public.tentativas_conta_pagar where id = (select tentativa_id from r_quita)), true,
          '30. o pedido de quitação é gravado com a intenção, antes do POST');
-- Junto de uma transição permitida (em_voo → confirmada): só a identidade recusa.
select throws_ok(
    $$update public.tentativas_conta_pagar
         set estado = 'confirmada', bling_conta_id = '556', quitacao_solicitada = false
       where chave = '74200000-0000-4000-8000-000000000005'$$,
    '23514', 'A identidade de uma tentativa de conta a pagar e imutavel.', '31. e não pode ser apagado depois');

create temp table de_outra as select * from public.registrar_reconciliacao_conta_pagar(
    (select org_a from ids), '74200000-0000-4000-8000-000000000003', 'criacao', (select ator from ids),
    'corr-9', 'confirmacao_manual', 'confirmada', null, '880', null, 1, 1);
select is((select resultado || '/' || motivo || '/' || estado from de_outra), 'divergente/conta_de_outra_operacao/indeterminada',
          '32. a conta remota de outra operação não confirma esta');
select is((select motivo from public.reconciliacoes_conta_pagar where correlation_id = 'corr-9'), 'conta_de_outra_operacao',
          '33. e o recibo diz por quê');
select throws_ok(
    $$update public.tentativas_conta_pagar set estado = 'confirmada', bling_conta_id = '880'
       where chave = '74200000-0000-4000-8000-000000000005'$$,
    '23505', null, '34. o banco recusa duas operações na mesma conta remota, mesmo fora da função');
select is((select motivo from manual), 'nenhum_candidato', '35. o motivo volta na resposta do registro');

-- ----------------------------------------------------------------------------
-- 36-40. Reabertura comprovadamente não despachada noutro dia; vínculo sem órfão.
-- ----------------------------------------------------------------------------
create temp table r6 as select pg_temp.tentativa((select org_a from ids), '74200000-0000-4000-8000-000000000006',
                         repeat('6', 64), 'ORB-6666666666666666', 'nao_enviada') as id;
create temp table r6b as select * from public.reivindicar_tentativa_conta_pagar(
    (select org_a from ids), '74200000-0000-4000-8000-000000000006', repeat('6', 64),
    100.00, '2026-10-20', '2026-10-10', 7001, 'ORB-6666666666666666');
select is((select desfecho || '/' || estado || '/' || epoca from r6b), 'reaberta/em_voo/2',
          '36. o reenvio não despachado reabre a MESMA tentativa noutro dia');
select is((select data_emissao::text from public.tentativas_conta_pagar where id = (select id from r6)), '2026-10-10',
          '37. com a emissão do novo envio, a que a conferência vai procurar');

select * from public.reivindicar_tentativa_conta_pagar(
    (select org_a from ids), '74200000-0000-4000-8000-000000000007', repeat('7', 64),
    100.00, '2026-10-20', '2026-10-09', 7001, 'ORB-7777777777777777', true);
update public.tentativas_conta_pagar set estado = 'confirmada', bling_conta_id = '557'
 where chave = '74200000-0000-4000-8000-000000000007';
create temp table t7 as select id from public.tentativas_conta_pagar where chave = '74200000-0000-4000-8000-000000000007';
create temp table b7 as select * from public.reivindicar_baixa_conta_pagar((select org_a from ids), (select id from t7), '557', '2026-10-10');
update public.baixas_conta_pagar set estado = 'nao_enviada', motivo = 'credencial_indisponivel' where id = (select baixa_id from b7);
create temp table b7b as select * from public.reivindicar_baixa_conta_pagar((select org_a from ids), (select id from t7), '557', '2026-10-11');
select is((select desfecho || '/' || estado || '/' || epoca || '/' || (baixa_id = (select baixa_id from b7)) from b7b),
          'reaberta/em_voo/2/true', '38. a quitação não despachada reabre a MESMA intenção noutro dia');
select is((select data_baixa::text from public.baixas_conta_pagar where id = (select baixa_id from b7)), '2026-10-11',
          '39. com a data do novo envio, a que o borderô vai provar');

insert into public.titulos_financeiros (id, organizacao_id, situacao)
values ('74300000-0000-4000-8000-000000000001', (select org_a from ids), 'aberto');
update public.tentativas_conta_pagar set titulo_id = '74300000-0000-4000-8000-000000000001' where id = (select id from t7);
select throws_ok(
    $$delete from public.titulos_financeiros where id = '74300000-0000-4000-8000-000000000001'$$,
    '23514', null, '40. título vinculado não é apagado: o vínculo nunca fica órfão');

-- ----------------------------------------------------------------------------
-- 41-47. Listagem das pendências no banco, sem janela que esconda as antigas.
-- ----------------------------------------------------------------------------
-- Organização B: 501 operações concluídas recentes (quitação pedida, título
-- pago) e uma pendência antiga.
with titulos as (
    insert into public.titulos_financeiros (organizacao_id, situacao)
    select (select org_b from ids), 'pago' from generate_series(1, 501)
    returning id
)
insert into public.tentativas_conta_pagar
    (organizacao_id, chave, digest, valor, data_vencimento, data_emissao, estado, bling_conta_id, titulo_id, quitacao_solicitada)
select (select org_b from ids), gen_random_uuid(), md5(id::text) || md5(id::text), 10, '2026-10-20', '2026-10-09',
       'confirmada', (900000 + row_number() over ())::text, id, true
from titulos;
insert into public.tentativas_conta_pagar
    (organizacao_id, chave, digest, valor, data_vencimento, data_emissao, estado, motivo, created_at)
values ((select org_b from ids), '74200000-0000-4000-8000-0000000000b1', repeat('1', 64), 10, '2026-10-20', '2026-09-01',
        'indeterminada', 'sem_resposta', now() - interval '30 days');
create temp table antiga as
    select id from public.tentativas_conta_pagar where chave = '74200000-0000-4000-8000-0000000000b1';

select ok(not exists (
    select 1 from (
        select t.id from public.tentativas_conta_pagar t
         where t.organizacao_id = (select org_b from ids)
           and (t.estado in ('em_voo', 'indeterminada')
                or (t.estado = 'confirmada' and (t.titulo_id is null or t.quitacao_solicitada)))
         order by t.created_at desc limit 500) janela
     where janela.id = (select id from antiga)),
    '41. reprodução: a janela das 500 mais recentes da versão anterior não via a pendência antiga');
select ok(exists (select 1 from public.listar_pendencias_conta_pagar((select org_b from ids), 100)
                   where tentativa_id = (select id from antiga)),
          '42. a listagem do banco a encontra');
select is((select count(*)::int || '/' || max(total) from public.listar_pendencias_conta_pagar((select org_b from ids), 100)),
          '1/1', '43. e devolve só as pendências, com o total');

-- Pendências que dependem do título e da baixa.
create temp table casos (chave uuid, conta text, titulo_org text, situacao text, quitacao boolean, baixa text,
                         situacao_bling smallint default null);
insert into casos (chave, conta, titulo_org, situacao, quitacao, baixa) values
    ('74200000-0000-4000-8000-0000000000b2', '910001', 'b', 'aberto', true, 'recusada'),
    ('74200000-0000-4000-8000-0000000000b3', '910002', 'b', 'cancelado', true, 'confirmada'),
    ('74200000-0000-4000-8000-0000000000b4', '910003', 'a', 'aberto', false, null),
    ('74200000-0000-4000-8000-0000000000b5', '910004', 'b', 'aberto', true, null),
    ('74200000-0000-4000-8000-0000000000b6', '910005', 'b', 'aberto', true, 'nao_enviada'),
    ('74200000-0000-4000-8000-0000000000b7', '910006', 'b', 'misterioso', false, null),
    ('74200000-0000-4000-8000-0000000000b8', '910007', 'b', 'aberto', false, null),
    ('74200000-0000-4000-8000-0000000000b9', '910008', 'b', 'pago', true, 'recusada');
-- O Bling diz "Pago" e o título ficou aberto (saldo não comprovado): pendência.
insert into casos values ('74200000-0000-4000-8000-0000000000ba', '910009', 'b', 'aberto', false, null, 2),
                         ('74200000-0000-4000-8000-0000000000bb', '910010', 'b', 'aberto', false, null, 1);
do $$
declare c record; v_titulo uuid; v_t uuid;
begin
    for c in select * from casos loop
        insert into public.titulos_financeiros (organizacao_id, situacao, situacao_bling)
        values (case c.titulo_org when 'a' then '74100000-0000-4000-8000-000000000001'::uuid
                                 else '74100000-0000-4000-8000-000000000002'::uuid end, c.situacao, c.situacao_bling)
        returning id into v_titulo;
        insert into public.tentativas_conta_pagar
            (organizacao_id, chave, digest, valor, data_vencimento, data_emissao, estado, bling_conta_id, titulo_id, quitacao_solicitada)
        values ('74100000-0000-4000-8000-000000000002', c.chave, md5(c.chave::text) || md5(c.conta), 10, '2026-10-20', '2026-10-09',
                'confirmada', c.conta, v_titulo, c.quitacao)
        returning id into v_t;
        if c.baixa is not null then
            insert into public.baixas_conta_pagar (organizacao_id, tentativa_id, bling_conta_id, data_baixa, estado, bordero_id)
            values ('74100000-0000-4000-8000-000000000002', v_t, c.conta, '2026-10-10', c.baixa,
                    case c.baixa when 'confirmada' then '7' || c.conta end);
        end if;
    end loop;
end $$;
select is((select string_agg(right(t.chave::text, 2), ',' order by t.chave)
             from public.listar_pendencias_conta_pagar((select org_b from ids), 100) l
             join public.tentativas_conta_pagar t on t.id = l.tentativa_id),
          'b1,b2,b3,b4,b5,b6,b7,ba',
          '44. recusada, título cancelado com baixa, título de outra organização, quitação não feita, situação desconhecida, Bling "Pago" com título aberto: todas listadas; concluídas não');
select ok(not exists (select 1 from public.listar_pendencias_conta_pagar((select org_a from ids), 500) l
                        join public.tentativas_conta_pagar t on t.id = l.tentativa_id
                       where t.organizacao_id <> (select org_a from ids)),
          '45. a organização A só vê as dela');
select is((select count(*)::int || '/' || max(total) from public.listar_pendencias_conta_pagar((select org_b from ids), 2)),
          '2/8', '46. com limite, o total diz quantas ficaram de fora');
select lives_ok(
    $$select * from public.registrar_reconciliacao_conta_pagar(
        '74100000-0000-4000-8000-000000000001', '74200000-0000-4000-8000-000000000003', 'criacao',
        '74000000-0000-4000-8000-000000000001', 'corr-10', 'declaracao_do_operador', 'revisao_manual',
        'sem_evidencia_positiva', null, null, null, 1)$$,
    '47. a declaração do operador é um método próprio no recibo, distinto de prova');

-- ----------------------------------------------------------------------------
-- 48-57. Baixa confirmada só com borderô; método e motivo coerentes.
-- ----------------------------------------------------------------------------
update public.baixas_conta_pagar set estado = 'indeterminada', motivo = 'sem_resposta'
 where id = (select baixa_id from b7) and estado = 'em_voo';

select throws_ok(
    $$select * from public.registrar_reconciliacao_conta_pagar(
        '74100000-0000-4000-8000-000000000001', '74200000-0000-4000-8000-000000000007', 'baixa',
        '74000000-0000-4000-8000-000000000001', 'corr-11', 'leitura_de_borderos', 'confirmada', null, '557', null, 2, 1)$$,
    '22023', null, '48. baixa confirmada sem borderô é recusada');
select throws_ok(
    $$select * from public.registrar_reconciliacao_conta_pagar(
        '74100000-0000-4000-8000-000000000001', '74200000-0000-4000-8000-000000000007', 'baixa',
        '74000000-0000-4000-8000-000000000001', 'corr-12', 'confirmacao_manual', 'confirmada', null, '557', '558', 2, 1)$$,
    '22023', null, '49. baixa confirmada por método que não lê borderô é recusada');
select throws_ok(
    $$select * from public.registrar_reconciliacao_conta_pagar(
        '74100000-0000-4000-8000-000000000001', '74200000-0000-4000-8000-000000000003', 'criacao',
        '74000000-0000-4000-8000-000000000001', 'corr-13', 'leitura_de_borderos', 'confirmada', null, '559', null, 1, 1)$$,
    '22023', null, '50. criação confirmada por método de baixa é recusada');
select throws_ok(
    $$select * from public.registrar_reconciliacao_conta_pagar(
        '74100000-0000-4000-8000-000000000001', '74200000-0000-4000-8000-000000000007', 'baixa',
        '74000000-0000-4000-8000-000000000001', 'corr-14', 'leitura_de_borderos', 'confirmada', 'quitada_sem_autoria', '557', '558', 2, 1)$$,
    '22023', null, '51. confirmação com motivo de revisão é recusada');
select throws_ok(
    $$select * from public.registrar_reconciliacao_conta_pagar(
        '74100000-0000-4000-8000-000000000001', '74200000-0000-4000-8000-000000000007', 'baixa',
        '74000000-0000-4000-8000-000000000001', 'corr-15', 'leitura_de_borderos', 'revisao_manual', null, null, null, 2, 1)$$,
    '22023', null, '52. revisão manual sem motivo é recusada');
select is((select count(*)::int from public.reconciliacoes_conta_pagar where correlation_id in ('corr-11', 'corr-12', 'corr-13', 'corr-14', 'corr-15'))
          || '/' || (select estado from public.baixas_conta_pagar where id = (select baixa_id from b7)),
          '0/indeterminada', '53. nenhuma combinação inválida deixa recibo ou muda a baixa');

select * from public.reivindicar_tentativa_conta_pagar(
    (select org_a from ids), '74200000-0000-4000-8000-000000000008', repeat('8', 64),
    100.00, '2026-10-20', '2026-10-09', 7001, 'ORB-8888888888888888', true);
update public.tentativas_conta_pagar set estado = 'confirmada', bling_conta_id = '560'
 where chave = '74200000-0000-4000-8000-000000000008';
create temp table b8 as select * from public.reivindicar_baixa_conta_pagar(
    (select org_a from ids), (select id from public.tentativas_conta_pagar where chave = '74200000-0000-4000-8000-000000000008'),
    '560', '2026-10-10');
select throws_ok(
    $$update public.baixas_conta_pagar set estado = 'confirmada'
       where id = (select baixa_id from b8)$$,
    '23514', null, '54. nem o desfecho direto do POST confirma a baixa sem borderô');
select throws_ok(
    $$insert into public.reconciliacoes_conta_pagar
        (organizacao_id, tentativa_id, alvo, ator_id, correlation_id, metodo, resultado, bling_conta_id, estado_antes, epoca_observada)
      values ('74100000-0000-4000-8000-000000000001',
              (select id from public.tentativas_conta_pagar where chave = '74200000-0000-4000-8000-000000000008'),
              'baixa', '74000000-0000-4000-8000-000000000001', 'corr-16', 'leitura_de_borderos', 'confirmada', '560', 'em_voo', 1)$$,
    '23514', null, '55. nem um recibo de baixa confirmada sem borderô entra na tabela');
select lives_ok(
    $$update public.baixas_conta_pagar set estado = 'confirmada', bordero_id = '561'
       where id = (select baixa_id from b8)$$,
    '56. com o borderô, o desfecho do POST confirma');
create temp table rb7 as select * from public.registrar_reconciliacao_conta_pagar(
    (select org_a from ids), '74200000-0000-4000-8000-000000000007', 'baixa', (select ator from ids),
    'corr-17', 'leitura_de_borderos', 'confirmada', null, '557', '562', 2, 1);
select is((select resultado || '/' || estado from rb7) || '/' || (select bordero_id from public.baixas_conta_pagar where id = (select baixa_id from b7)),
          'confirmada/confirmada/562', '57. com borderô e método de borderô, a conferência confirma');

-- ----------------------------------------------------------------------------
-- 58-60. Baixa confirmada só com a situação remota registrada como Pago.
-- ----------------------------------------------------------------------------
select * from public.reivindicar_tentativa_conta_pagar(
    (select org_a from ids), '74200000-0000-4000-8000-000000000009', repeat('9', 64),
    100.00, '2026-10-20', '2026-10-09', 7001, 'ORB-9999999999999999', true);
update public.tentativas_conta_pagar set estado = 'confirmada', bling_conta_id = '563'
 where chave = '74200000-0000-4000-8000-000000000009';
create temp table b9 as select * from public.reivindicar_baixa_conta_pagar(
    (select org_a from ids), (select id from public.tentativas_conta_pagar where chave = '74200000-0000-4000-8000-000000000009'),
    '563', '2026-10-10');
update public.baixas_conta_pagar set estado = 'indeterminada', motivo = 'sem_resposta' where id = (select baixa_id from b9);

select throws_ok(
    $$select * from public.registrar_reconciliacao_conta_pagar(
        '74100000-0000-4000-8000-000000000001', '74200000-0000-4000-8000-000000000009', 'baixa',
        '74000000-0000-4000-8000-000000000001', 'corr-18', 'leitura_de_borderos', 'confirmada', null, '563', '564', null, 1)$$,
    '22023', null, '58. baixa confirmada sem a situação remota registrada é recusada');
select throws_ok(
    $$select * from public.registrar_reconciliacao_conta_pagar(
        '74100000-0000-4000-8000-000000000001', '74200000-0000-4000-8000-000000000009', 'baixa',
        '74000000-0000-4000-8000-000000000001', 'corr-19', 'leitura_de_borderos', 'confirmada', null, '563', '564', 1, 1)$$,
    '22023', null, '59. baixa confirmada com a conta registrada Em aberto é recusada');
select is((select count(*)::int from public.reconciliacoes_conta_pagar where correlation_id in ('corr-18', 'corr-19'))
          || '/' || (select estado from public.baixas_conta_pagar where id = (select baixa_id from b9)),
          '0/indeterminada', '60. nada é gravado e a baixa continua sem desfecho');

-- ----------------------------------------------------------------------------
-- 61-67. Privilégios e RLS.
-- ----------------------------------------------------------------------------
select ok(not has_table_privilege('authenticated', 'public.reconciliacoes_conta_pagar', 'select'), '61. navegador não lê recibos');
select ok(not has_table_privilege('service_role', 'public.reconciliacoes_conta_pagar', 'update'), '62. nem o servidor altera recibos');
select ok(not has_table_privilege('service_role', 'public.reconciliacoes_conta_pagar', 'delete'), '63. nem apaga');
select ok(not has_table_privilege('authenticated', 'public.baixas_conta_pagar', 'select'), '64. navegador não lê baixas');
select ok(not has_table_privilege('service_role', 'public.baixas_conta_pagar', 'delete'), '65. baixa não é apagada');
select ok(not has_function_privilege('authenticated',
    'public.registrar_reconciliacao_conta_pagar(uuid, uuid, text, uuid, text, text, text, text, text, text, integer, integer)',
    'execute')
    and not has_function_privilege('authenticated',
    'public.reivindicar_tentativa_conta_pagar(uuid, uuid, text, numeric, date, date, bigint, text, boolean)', 'execute')
    and not has_function_privilege('authenticated', 'public.listar_pendencias_conta_pagar(uuid, integer, timestamptz, uuid)', 'execute')
    and has_function_privilege('service_role', 'public.listar_pendencias_conta_pagar(uuid, integer, timestamptz, uuid)', 'execute')
    and to_regprocedure('public.reivindicar_tentativa_conta_pagar(uuid, uuid, text, numeric, date, date, bigint)') is null,
    '66. só o servidor registra, reivindica e lista; a assinatura antiga não sobra');
select is((select bool_and(relrowsecurity) from pg_class
            where oid in ('public.reconciliacoes_conta_pagar'::regclass, 'public.baixas_conta_pagar'::regclass)),
          true, '67. RLS ligada nas tabelas novas');

select * from finish();
rollback;
