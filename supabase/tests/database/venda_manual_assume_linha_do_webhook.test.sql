-- venda_manual_assume_linha_do_webhook.test.sql
-- Ticket 30, migrations 57 e 58.
--
-- A CORRIDA: o pedido nasce no Bling, o `order.created` volta em menos de um
-- segundo, e o webhook grava a linha em `pedidos` ANTES de a venda manual
-- chegar. Quando `registrar_venda_manual` grava o mesmo `bling_id`, bate em
-- `uq_pedidos_org_bling` (23505) e a venda inteira cai — sem baixa de estoque
-- e sem titulo financeiro.
--
-- A DUPLA CONTAGEM: achada ao medir esta corrida, e corrigida junto por
-- exigencia de revisao — nao e a corrida, mas o mesmo pedido a expõe. O
-- INSERT em `itens_pedido` reserva (+1, `tg_atualizar_estoque_reservado`) e
-- `baixar_estoque_organizacao` baixa fisicamente (-1) — juntas, a
-- disponibilidade cai DOIS por unidade vendida, porque a reserva de um pedido
-- que nasce `Entregue` nunca era liberada. A migration 58 ensina os dois
-- gatilhos de reserva a tratar `Entregue` como estado final, do mesmo jeito
-- que `Cancelado` ja era.
--
-- Este teste prova quatro coisas:
--   1. com a linha do webhook ja gravada, a venda manual a ASSUME: mesmo id,
--      um pedido so, um item so, uma baixa so, um titulo so;
--   2. a disponibilidade cai EXATAMENTE uma unidade por unidade vendida — nao
--      duas —, tanto na tomada quanto numa venda manual sem webhook por perto;
--   3. cancelar depois uma venda manual ja completa NAO manda a reserva para
--      negativo — prova que a liberacao so acontece quando havia reserva de
--      fato;
--   4. assumir DE NOVO uma linha que ja e venda manual continua sendo 23505 —
--      o indice fica, e o codigo de erro nao virou sucesso.
--
-- Os gatilhos de estoque NAO sao copiados aqui: vem de `\ir` das migrations
-- 58/00_bootstrap, a funcao REAL que a producao executa. Uma copia so provaria
-- a copia — foi exatamente o limite que a primeira versao deste teste
-- registrou e que esta revisao fecha.
--
-- REINTRODUZIR A CORRIDA: troque o `\ir` da migration 57 por nada. As
-- asserçoes 3 a 12 (secao B) falham, a primeira delas com o proprio 23505.
--
-- REINTRODUZIR A DUPLA CONTAGEM: troque o `\ir` da migration 58 por nada. As
-- asserçoes da secao C (disponibilidade e cancelamento) falham.

begin;

-- ----------------------------------------------------------------------------
-- Tabelas-base reconstruidas como nos demais testes desta suite
-- (`schema_master.sql` nao e executavel isoladamente), ja no estado
-- pos-contract: `organizacao_id` presente e obrigatoria.
-- ----------------------------------------------------------------------------
create table public.clientes (
    id                    uuid primary key default gen_random_uuid(),
    user_id               uuid references auth.users(id) on delete cascade,
    bling_id              text,
    nome                  text not null,
    cpf_cnpj              text,
    email                 text,
    telefone              text,
    telefone_normalizado  text,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now()
);

create table public.produtos (
    id                uuid primary key default gen_random_uuid(),
    user_id           uuid references auth.users(id) on delete cascade,
    bling_id          text,
    codigo            text,
    nome              text not null,
    preco             numeric(10,2) not null default 0,
    estoque           integer not null default 0,
    estoque_reservado integer not null default 0,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

create table public.categorias (
    id               uuid primary key default gen_random_uuid(),
    user_id          uuid references auth.users(id) on delete cascade,
    bling_id         text,
    descricao        text not null,
    categoria_pai_id text,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create table public.pedidos (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid references auth.users(id) on delete cascade,
    bling_id        text not null,
    numero          text not null,
    data            timestamptz not null default now(),
    cliente_id      uuid not null references public.clientes(id) on delete restrict,
    total           numeric(12,2) not null default 0.00,
    frete           numeric(12,2) default 0.00,
    desconto        numeric(12,2) default 0.00,
    status          text not null default 'Pendente',
    origem          text not null default 'Bling',
    forma_pagamento text,
    observacao      text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- `unq_item_pedido_produto` e do schema original (`schema_master.sql`) e e o
-- que torna `on conflict (pedido_id, produto_id)` inferivel. Sem ela, a tomada
-- do item morreria com 42P10 — o mesmo defeito da migration 55, uma tabela
-- adiante.
create table public.itens_pedido (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid references auth.users(id) on delete cascade,
    pedido_id       uuid not null references public.pedidos(id) on delete cascade,
    produto_id      uuid not null references public.produtos(id) on delete restrict,
    quantidade      int not null default 1,
    valor_unitario  numeric(12,2) not null default 0.00,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    constraint unq_item_pedido_produto unique (pedido_id, produto_id)
);

create table public.movimentacao_estoque (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid references auth.users(id) on delete cascade,
    produto_id   uuid not null references public.produtos(id) on delete cascade,
    tipo         text not null check (tipo in ('ENTRADA', 'SAIDA')),
    origem       text,
    quantidade   int not null,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

create table public.documentos_fiscais (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid references auth.users(id) on delete cascade,
    pedido_id    uuid references public.pedidos(id) on delete set null,
    bling_id     text,
    tipo         text not null default 'NFE',
    numero       text not null,
    status       text not null default 'Emitida',
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

-- `titulos_financeiros` no estado final (migration 45): organizacao obrigatoria.
create table public.titulos_financeiros (
    id                uuid primary key default gen_random_uuid(),
    user_id           uuid references auth.users(id) on delete cascade,
    organizacao_id    uuid not null,
    bling_id          text,
    tipo              text not null,
    situacao          text not null,
    valor             numeric(12,2) not null default 0,
    data_vencimento   date,
    data_pagamento    date,
    descricao         text,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- `fn_atualizar_estoque_reservado` e `fn_atualizar_reserva_status_pedido` NAO
-- sao copiados aqui: vem de `\ir` da migration 58, mais abaixo — a funcao REAL
-- que a producao executa. Uma copia so provaria a copia; era exatamente o
-- limite que a primeira versao deste teste registrava.
--
-- `fn_validar_estoque_disponivel` continua copiada: a migration 58 nao a
-- toca, e o teste so precisa que ela exista para provar que a tomada nao e
-- recusada pela validacao de disponivel.
-- ----------------------------------------------------------------------------
create or replace function public.fn_validar_estoque_disponivel() returns trigger language plpgsql set search_path = public as $disponivel$
declare
    v_erp int; v_reservado int; v_disp_final int;
begin
    select p.estoque, p.estoque_reservado into v_erp, v_reservado from produtos p where p.id = new.produto_id for update;
    if not found then raise exception 'Produto com ID % nao encontrado.', new.produto_id; end if;
    if (tg_op = 'UPDATE' and old.produto_id = new.produto_id) then
        v_disp_final := v_erp - (v_reservado - old.quantidade + new.quantidade);
    else
        v_disp_final := v_erp - (v_reservado + new.quantidade);
    end if;
    if v_disp_final < 0 then
        raise exception 'Estoque insuficiente para o produto "%".', new.produto_id using errcode = 'check_violation';
    end if;
    return new;
end;
$disponivel$;

create trigger tg_validar_estoque_disponivel
before insert or update on itens_pedido for each row execute function fn_validar_estoque_disponivel();

-- Esqueletos: apenas as colunas que a migration 55 indexa, para que ela rode
-- inteira sem arrastar as cadeias financeira, de sync e de chatwoot para dentro
-- de um teste que nao afirma nada sobre elas. Mesmo recorte de
-- `upsert_conflito_inferivel.test.sql`.
create table public.sync_state (organizacao_id uuid, entidade text, chave text, valor jsonb);
create table public.contas_financeiras (organizacao_id uuid, bling_id text);
create table public.categorias_financeiras (organizacao_id uuid, bling_id text);
create table public.fornecedores (organizacao_id uuid, bling_id text);
create table public.chatwoot_inboxes (organizacao_id uuid, conexao_id uuid, inbox_id bigint);
create table public.chatwoot_contacts (organizacao_id uuid, id bigint);
create table public.chatwoot_conversations (organizacao_id uuid, id bigint);
create table public.chatwoot_messages (organizacao_id uuid, id bigint);

insert into auth.users (id, email)
values ('30000000-0000-4000-8000-000000000001', 'owner-t30@orbita.test');

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/21_convites_papeis_capacidades.sql
\ir ../../../database/22_migrar_catalogo_organizacao.sql
\ir ../../../database/23_migrar_comercial_estoque_fiscal.sql
\ir ../../../database/40_expand_verificar_catalogo_comercial_estoque_fiscal.sql
\ir ../../../database/53_venda_manual_transacional.sql
\ir ../../../database/55_upsert_conflito_inferivel.sql
\ir ../../../database/56_baixa_estoque_com_ator.sql
\ir ../../../database/57_venda_manual_assume_linha_do_webhook.sql
\ir ../../../database/58_reserva_nao_conta_pedido_finalizado.sql

-- As duas ligacoes que a migration 58 corrige. Nao vem de `schema_master.sql`
-- porque este teste nao o roda inteiro (ver cabecalho); sao as MESMAS duas
-- linhas de `\ir ../../../supabase/lab/00_bootstrap_schema.sql`.
create trigger tg_atualizar_estoque_reservado
after insert or update or delete on itens_pedido for each row execute function fn_atualizar_estoque_reservado();

create trigger tg_pedidos_reserva_status
after update of status on pedidos for each row execute function fn_atualizar_reserva_status_pedido();

insert into public.organizacoes (id, nome, slug)
values ('30100000-0000-4000-8000-000000000001', 'Org T30', 'org-t30');

insert into public.membros_organizacao (organizacao_id, user_id, papel)
values ('30100000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'owner');

insert into public.clientes (id, user_id, organizacao_id, bling_id, nome)
values ('30300000-0000-4000-8000-00000000000a', '30000000-0000-4000-8000-000000000001',
        '30100000-0000-4000-8000-000000000001', '111', 'Mateus Kahuan');

-- Estoque 3 e reservado 0, como o "Rape Pequeno Artemisia" da jornada de 02/09.
insert into public.produtos (id, user_id, organizacao_id, bling_id, nome, preco, estoque)
values ('30200000-0000-4000-8000-00000000000a', '30000000-0000-4000-8000-000000000001',
        '30100000-0000-4000-8000-000000000001', '77', 'Rape Pequeno Artemisia', 40.00, 3);

-- Um segundo produto, para a venda manual SEM webhook por perto (secao C) —
-- a dupla contagem nao depende da corrida, e o teste prova isso separado.
insert into public.produtos (id, user_id, organizacao_id, bling_id, nome, preco, estoque)
values ('30200000-0000-4000-8000-00000000000b', '30000000-0000-4000-8000-000000000001',
        '30100000-0000-4000-8000-000000000001', '88', 'Vela de Cera de Abelha', 25.00, 5);

-- ----------------------------------------------------------------------------
-- O WEBHOOK CHEGA PRIMEIRO.
--
-- Exatamente o que `processPedidoEvent` grava: `origem` fica no default 'Bling'
-- (o payload do webhook nao carrega origem), `numero` e o numero REAL do
-- pedido no Bling, `status` vem mapeado da situacao, e o item entra por
-- `pedidoRepository.addItems` — o que reserva 1 unidade.
-- ----------------------------------------------------------------------------
insert into public.pedidos (id, user_id, organizacao_id, cliente_id, bling_id, numero, total, status)
values ('30400000-0000-4000-8000-00000000000a', '30000000-0000-4000-8000-000000000001',
        '30100000-0000-4000-8000-000000000001', '30300000-0000-4000-8000-00000000000a',
        '26764331138', '20', 40.00, 'Pendente');

insert into public.itens_pedido (user_id, organizacao_id, pedido_id, produto_id, quantidade, valor_unitario)
values ('30000000-0000-4000-8000-000000000001', '30100000-0000-4000-8000-000000000001',
        '30400000-0000-4000-8000-00000000000a', '30200000-0000-4000-8000-00000000000a', 1, 40.00);

select plan(19);

-- ----------------------------------------------------------------------------
-- 1-2. O ponto de partida da corrida, medido antes de agir.
-- ----------------------------------------------------------------------------
select is(
    (select estoque_reservado from public.produtos where id = '30200000-0000-4000-8000-00000000000a'),
    1,
    'o item do webhook ja reservou 1 unidade antes de a venda manual chegar'
);

select is(
    (select estoque from public.produtos where id = '30200000-0000-4000-8000-00000000000a'),
    3,
    'e o webhook nao baixou estoque nenhum — a venda esta pela metade'
);

-- ----------------------------------------------------------------------------
-- 3-12. A venda manual assume a linha do webhook.
--
-- Sem a migration 57 esta chamada levanta
-- `23505 duplicate key value violates unique constraint "uq_pedidos_org_bling"`
-- e nada abaixo existe.
-- ----------------------------------------------------------------------------
create temp table tomada as
select public.registrar_venda_manual(
    '30100000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    '30300000-0000-4000-8000-00000000000a',
    '26764331138', '26764331138',
    40.00, 0, 0, 'Dinheiro', null, current_date,
    '[{"produto_id":"30200000-0000-4000-8000-00000000000a","quantidade":1,"valor_unitario":40.00}]'::jsonb
) as pedido_id;

select is(
    (select pedido_id from tomada),
    '30400000-0000-4000-8000-00000000000a'::uuid,
    'a venda manual devolve o id da linha do WEBHOOK — assumiu, nao inseriu outra'
);

select is(
    (select count(*) from public.pedidos where bling_id = '26764331138'),
    1::bigint,
    'continua existindo um pedido so para o bling_id — o indice unico nao foi violado nem removido'
);

select is(
    (select origem from public.pedidos where id = '30400000-0000-4000-8000-00000000000a'),
    'Loja Física / Manual',
    'a linha deixa de se passar por importacao do Bling e assume a origem verdadeira'
);

select is(
    (select status from public.pedidos where id = '30400000-0000-4000-8000-00000000000a'),
    'Entregue',
    'a venda entregue deixa de ficar pendente'
);

select is(
    (select forma_pagamento from public.pedidos where id = '30400000-0000-4000-8000-00000000000a'),
    'Dinheiro',
    'a forma de pagamento, que so a venda manual conhece, chega a linha'
);

select is(
    (select numero from public.pedidos where id = '30400000-0000-4000-8000-00000000000a'),
    '20',
    'o numero REAL do pedido no Bling e preservado — a venda manual so tem o id'
);

select is(
    (select count(*) from public.itens_pedido where pedido_id = '30400000-0000-4000-8000-00000000000a'),
    1::bigint,
    'o item do webhook e assumido, nao duplicado'
);

select is(
    (select estoque from public.produtos where id = '30200000-0000-4000-8000-00000000000a'),
    2,
    'a baixa de estoque acontece — era exatamente o que a corrida impedia'
);

select is(
    (select estoque_reservado from public.produtos where id = '30200000-0000-4000-8000-00000000000a'),
    0,
    'a reserva do webhook (Pendente) e LIBERADA quando o pedido vira Entregue — migration 58. '
    || 'Sem ela ficaria em 1, e a disponibilidade (estoque - reservado) cairia DOIS por unidade vendida'
);

select is(
    (select estoque - estoque_reservado from public.produtos where id = '30200000-0000-4000-8000-00000000000a'),
    2,
    'disponibilidade: 3 de partida, 1 vendida, sobram exatamente 2 — nao 1'
);

select is(
    (select count(*) from public.titulos_financeiros where organizacao_id = '30100000-0000-4000-8000-000000000001'),
    1::bigint,
    'o titulo financeiro e criado — a outra metade que a corrida impedia'
);

-- ----------------------------------------------------------------------------
-- 13-15. A guarda: assumir de novo o que ja e venda manual continua sendo 23505.
--
-- Sem ela, uma segunda chamada duplicaria baixa de estoque e titulo
-- financeiro em cima da mesma venda.
-- ----------------------------------------------------------------------------
select throws_ok(
    $tomada_dupla$select public.registrar_venda_manual(
        '30100000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000001',
        '30300000-0000-4000-8000-00000000000a',
        '26764331138', '26764331138',
        40.00, 0, 0, 'Dinheiro', null, current_date,
        '[{"produto_id":"30200000-0000-4000-8000-00000000000a","quantidade":1,"valor_unitario":40.00}]'::jsonb
    )$tomada_dupla$,
    '23505',
    'Ja existe uma venda manual registrada para o pedido 26764331138 nesta organizacao.',
    'assumir uma linha que ja e venda manual continua sendo 23505 — o codigo de erro nao virou sucesso'
);

select is(
    (select estoque from public.produtos where id = '30200000-0000-4000-8000-00000000000a'),
    2,
    'a recusa nao baixou estoque uma segunda vez'
);

select is(
    (select count(*) from public.titulos_financeiros where organizacao_id = '30100000-0000-4000-8000-000000000001'),
    1::bigint,
    'a recusa nao criou um segundo titulo financeiro'
);

-- ----------------------------------------------------------------------------
-- SECAO C — a dupla contagem NAO depende da corrida.
--
-- Uma venda manual pura, sem webhook por perto (bling_id nulo, syncBling
-- desligado), no segundo produto. Se a migration 58 sair, `estoque_reservado`
-- termina em 1 em vez de 0 — o INSERT em `itens_pedido` reserva, e nada
-- libera, porque o pedido nasce direto como `Entregue` (nunca faz a transicao
-- UPDATE que o gatilho de status observa).
-- ----------------------------------------------------------------------------
create temp table venda_sem_bling as
select public.registrar_venda_manual(
    '30100000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    '30300000-0000-4000-8000-00000000000a',
    null, null,
    25.00, 0, 0, 'Pix', null, current_date,
    '[{"produto_id":"30200000-0000-4000-8000-00000000000b","quantidade":1,"valor_unitario":25.00}]'::jsonb
) as pedido_id;

select is(
    (select estoque_reservado from public.produtos where id = '30200000-0000-4000-8000-00000000000b'),
    0,
    'venda manual sem webhook nenhum por perto: tambem nunca reserva — a dupla contagem nao e a corrida'
);

select is(
    (select estoque - estoque_reservado from public.produtos where id = '30200000-0000-4000-8000-00000000000b'),
    4,
    'disponibilidade: 5 de partida, 1 vendida, sobram exatamente 4'
);

-- ----------------------------------------------------------------------------
-- SECAO D — cancelar depois nao manda a reserva para negativo.
--
-- `fn_atualizar_reserva_status_pedido` so libera reserva na transicao para um
-- estado final vinda de um estado NAO final. A venda manual assumida na secao
-- B ja chegou em `Entregue` sem nunca ter reservado (a liberacao aconteceu na
-- propria transicao Pendente->Entregue). Cancela-la agora e uma transicao
-- Entregue->Cancelado — final para final: nenhum dos dois lados reservava, e
-- o gatilho tem de reconhecer isso e nao subtrair uma reserva que nao existe.
--
-- Sem a distincao correta (ex.: liberar sempre que o novo status e Cancelado,
-- sem checar se o antigo ja era final), esta subtracao levaria
-- `estoque_reservado` a -1 — um numero que nao significa nada e que
-- contaminaria a proxima venda do mesmo produto.
-- ----------------------------------------------------------------------------
update public.pedidos set status = 'Cancelado' where id = '30400000-0000-4000-8000-00000000000a';

select is(
    (select estoque_reservado from public.produtos where id = '30200000-0000-4000-8000-00000000000a'),
    0,
    'cancelar uma venda manual ja Entregue nao manda a reserva para negativo — Entregue->Cancelado e final->final'
);

select * from finish();
rollback;
