-- indices_tenancy_consultas.test.sql
-- Ticket 22: Índices para tenancy e consultas frequentes

begin;

-- Fixtures descartáveis
create table public.clientes (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid references auth.users(id) on delete cascade,
    nome       text not null
);

create table public.pedidos (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid references auth.users(id) on delete cascade,
    cliente_id uuid references public.clientes(id) on delete restrict,
    numero     text not null,
    data       timestamptz default now(),
    status     text default 'Pendente'
);

create table public.itens_pedido (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid references auth.users(id) on delete cascade,
    pedido_id  uuid not null references public.pedidos(id) on delete cascade,
    produto_id uuid
);

create table public.categorias_financeiras (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid references auth.users(id) on delete cascade
);

create table public.contas_financeiras (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid references auth.users(id) on delete cascade
);

create table public.fornecedores (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid references auth.users(id) on delete cascade
);

create table public.titulos_financeiros (
    id                  uuid primary key default gen_random_uuid(),
    user_id             uuid references auth.users(id) on delete cascade,
    tipo                text not null,
    situacao            text not null,
    data_vencimento     date not null,
    categoria_id        uuid,
    conta_financeira_id uuid,
    fornecedor_id       uuid
);

create table public.documentos_fiscais (
    id        uuid primary key default gen_random_uuid(),
    user_id   uuid references auth.users(id) on delete cascade,
    pedido_id uuid
);

create table public.movimentacao_estoque (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid references auth.users(id) on delete cascade,
    produto_id uuid,
    created_at timestamptz default now()
);

create table public.chatwoot_conversations (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid references auth.users(id) on delete cascade,
    status     text,
    updated_at timestamptz default now()
);

create table public.chatwoot_messages (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid references auth.users(id) on delete cascade,
    conversation_id uuid,
    created_at      timestamptz default now()
);

\ir ../../../database/18_indices_tenancy_consultas.sql

select plan(8);

-- 1. Testar existência de índices de Foreign Keys
select has_index('public', 'pedidos', 'idx_pedidos_cliente_id', 'Índice em pedidos(cliente_id) deve existir');
select has_index('public', 'itens_pedido', 'idx_itens_pedido_pedido_id', 'Índice em itens_pedido(pedido_id) deve existir');
select has_index('public', 'titulos_financeiros', 'idx_titulos_financeiros_fornecedor_id', 'Índice em titulos_financeiros(fornecedor_id) deve existir');
select has_index('public', 'documentos_fiscais', 'idx_documentos_fiscais_pedido_id', 'Índice em documentos_fiscais(pedido_id) deve existir');

-- 2. Testar existência de índices compostos de Tenancy e Ordenação
select has_index('public', 'pedidos', 'idx_pedidos_user_data', 'Índice composto pedidos(user_id, data DESC) deve existir');
select has_index('public', 'titulos_financeiros', 'idx_titulos_user_vencimento', 'Índice composto titulos_financeiros(user_id, data_vencimento) deve existir');
select has_index('public', 'chatwoot_conversations', 'idx_chatwoot_conv_user_status', 'Índice composto chatwoot_conversations(user_id, status, updated_at DESC) deve existir');
select has_index('public', 'chatwoot_messages', 'idx_chatwoot_msg_user_conv', 'Índice composto chatwoot_messages(user_id, conversation_id, created_at ASC) deve existir');

select * from finish();
rollback;
