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
-- `uq_tentativas_conta_pagar_conta_remota`: 34 falha.

begin;

create table public.titulos_financeiros (
    id uuid primary key default gen_random_uuid()
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

select plan(42);

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
    'corr-7', 'leitura_por_id', 'confirmada', null, '880', '555', 2, null);
select is((select resultado || '/' || estado from rb), 'confirmada/confirmada', '26. conta quitada no Bling: baixa confirmada');
select is((select bordero_id from public.baixas_conta_pagar where id = (select baixa_id from b1)), '555',
          '27. o borderô observado fica registrado');

create temp table rb2 as select * from public.registrar_reconciliacao_conta_pagar(
    (select org_a from ids), '74200000-0000-4000-8000-000000000001', 'baixa', (select ator from ids),
    'corr-8', 'leitura_por_id', 'confirmada', null, '999', null, 2, null);
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
-- 36-42. Privilégios e RLS.
-- ----------------------------------------------------------------------------
select ok(not has_table_privilege('authenticated', 'public.reconciliacoes_conta_pagar', 'select'), '36. navegador não lê recibos');
select ok(not has_table_privilege('service_role', 'public.reconciliacoes_conta_pagar', 'update'), '37. nem o servidor altera recibos');
select ok(not has_table_privilege('service_role', 'public.reconciliacoes_conta_pagar', 'delete'), '38. nem apaga');
select ok(not has_table_privilege('authenticated', 'public.baixas_conta_pagar', 'select'), '39. navegador não lê baixas');
select ok(not has_table_privilege('service_role', 'public.baixas_conta_pagar', 'delete'), '40. baixa não é apagada');
select ok(not has_function_privilege('authenticated',
    'public.registrar_reconciliacao_conta_pagar(uuid, uuid, text, uuid, text, text, text, text, text, text, integer, integer)',
    'execute')
    and not has_function_privilege('authenticated',
    'public.reivindicar_tentativa_conta_pagar(uuid, uuid, text, numeric, date, date, bigint, text, boolean)', 'execute')
    and to_regprocedure('public.reivindicar_tentativa_conta_pagar(uuid, uuid, text, numeric, date, date, bigint)') is null,
    '41. só o servidor registra e reivindica; a assinatura antiga não sobra');
select is((select bool_and(relrowsecurity) from pg_class
            where oid in ('public.reconciliacoes_conta_pagar'::regclass, 'public.baixas_conta_pagar'::regclass)),
          true, '42. RLS ligada nas tabelas novas');

select * from finish();
rollback;
