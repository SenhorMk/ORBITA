-- tentativas_venda_manual_idempotentes.test.sql
-- Ticket 30, fatia 3, migration 59 — endurecida na 3ª rodada de revisão.
--
-- Prova a reivindicação atômica que fecha o gap de retentativa: sem isto,
-- uma retentativa (humana, de proxy, de navegador) depois de um estado
-- indeterminado geraria uma referência nova e criaria um SEGUNDO pedido
-- real no Bling — trocando "compensação destrutiva" por "duplicação
-- externa". Mesmo padrão de `registrar_evento_inbox_bling` (migration 28).
--
-- REINTRODUZIR O DEFEITO: troque o `\ir` da migration 59 por nada. As
-- asserções todas falham — a função nem existe.

begin;

create table public.clientes (
    id      uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users(id) on delete cascade,
    nome    text not null
);

-- Esqueleto: só a coluna que `tentativas_venda_manual.pedido_id` referencia.
-- Este teste não afirma nada sobre `pedidos` em si.
create table public.pedidos (
    id uuid primary key default gen_random_uuid()
);

insert into auth.users (id, email)
values ('59000000-0000-4000-8000-000000000001', 'owner-t59@orbita.test');

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/21_convites_papeis_capacidades.sql
\ir ../../../database/59_tentativas_venda_manual_idempotentes.sql

insert into public.organizacoes (id, nome, slug)
values ('59100000-0000-4000-8000-000000000001', 'Org T59', 'org-t59');

insert into public.membros_organizacao (organizacao_id, user_id, papel)
values ('59100000-0000-4000-8000-000000000001', '59000000-0000-4000-8000-000000000001', 'owner');

select plan(11);

-- ----------------------------------------------------------------------------
-- 1-3. Primeira reivindicação: tentativa nova.
-- ----------------------------------------------------------------------------
create temp table primeira as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'referencia-a'
);

select is((select estado from primeira), 'em_andamento', '1. primeira reivindicação: estado em_andamento');
select is((select is_duplicate from primeira), false, '2. primeira reivindicação: não é duplicata');
select isnt((select tentativa_id from primeira), null, '3. primeira reivindicação: devolve um id');

-- ----------------------------------------------------------------------------
-- 4-5. Reivindicar a MESMA referência de novo, ainda em_andamento: devolve o
--      MESMO desfecho — é isso que barra a retentativa concorrente sem
--      chamar o Bling de novo (handler reage com 409, sem side effect).
-- ----------------------------------------------------------------------------
create temp table segunda_em_andamento as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'referencia-a'
);

select is((select estado from segunda_em_andamento), 'em_andamento', '4. segunda reivindicação: continua em_andamento');
select is((select is_duplicate from segunda_em_andamento), true, '5. segunda reivindicação: É duplicata — não insere linha nova');

-- ----------------------------------------------------------------------------
-- 6-7. Conclui como indeterminada. A PRÓXIMA reivindicação com a mesma
--      referência tem de devolver esse estado — é o que impede a
--      retentativa de chamar o Bling: o handler vê 'indeterminada' e devolve
--      a mesma resposta, sem side effect novo.
-- ----------------------------------------------------------------------------
select public.concluir_tentativa_venda_manual(
    (select tentativa_id from primeira), 'indeterminada', null, '918273'
);

create temp table terceira_indeterminada as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'referencia-a'
);

select is((select estado from terceira_indeterminada), 'indeterminada', '6. terceira reivindicação: encontra o estado indeterminada gravado');
select is((select bling_pedido_id from terceira_indeterminada), '918273', '7. …com o bling_pedido_id preservado, para a mensagem poder citá-lo');

-- ----------------------------------------------------------------------------
-- 8-9. Uma referência DIFERENTE não é afetada pela primeira — a chave é
--      (organizacao_id, referencia_local), não só referencia_local.
-- ----------------------------------------------------------------------------
create temp table referencia_b as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'referencia-b'
);

select is((select estado from referencia_b), 'em_andamento', '8. referência diferente: tentativa nova, não vê a indeterminada da referência-a');
select is((select is_duplicate from referencia_b), false, '9. …não é duplicata');

-- ----------------------------------------------------------------------------
-- 10-11. Uma tentativa que FALHOU definitivamente é REABERTA pela próxima
--        reivindicação — nada ficou pendente no Bling para uma falha
--        definitiva, então é seguro retentar com a MESMA referência, sem
--        forçar o cliente a gerar outra.
-- ----------------------------------------------------------------------------
select public.concluir_tentativa_venda_manual((select tentativa_id from referencia_b), 'falhou', null, null);

create temp table reaberta_apos_falha as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'referencia-b'
);

select is((select estado from reaberta_apos_falha), 'em_andamento', '10. referência que falhou é reaberta como em_andamento, não bloqueada para sempre');
select is((select is_duplicate from reaberta_apos_falha), false, '11. …e a reabertura conta como tentativa nova, não duplicata');

select * from finish();
rollback;
