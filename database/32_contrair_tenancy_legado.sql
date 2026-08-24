-- ============================================================================
-- 32_contrair_tenancy_legado.sql
-- Ticket 36: Contrair o tenancy legado por usuário
-- Migração final de contração de tenancy:
-- 1. Garante que todos os registros possuam organizacao_id preenchido.
-- 2. Adiciona organizacao_id em sync_state e cria índice único (organizacao_id, entidade).
-- 3. Substitui políticas residuais que permitiam fallback para auth.uid() = user_id
--    por políticas 100% canônicas baseadas em usuario_pertence_a_organizacao(organizacao_id).
-- ============================================================================

-- 1. Backfill defensivo final para registros legados que ainda estejam com organizacao_id null
-- Vincula ao organizacao_id da membership do usuário criador (se existir)

update public.produtos p
set organizacao_id = m.organizacao_id
from public.membros_organizacao m
where p.organizacao_id is null
  and p.user_id = m.user_id;

update public.categorias c
set organizacao_id = m.organizacao_id
from public.membros_organizacao m
where c.organizacao_id is null
  and c.user_id = m.user_id;

update public.clientes c
set organizacao_id = m.organizacao_id
from public.membros_organizacao m
where c.organizacao_id is null
  and c.user_id = m.user_id;

update public.pedidos p
set organizacao_id = m.organizacao_id
from public.membros_organizacao m
where p.organizacao_id is null
  and p.user_id = m.user_id;

update public.itens_pedido i
set organizacao_id = m.organizacao_id
from public.membros_organizacao m
where i.organizacao_id is null
  and i.user_id = m.user_id;

update public.documentos_fiscais d
set organizacao_id = m.organizacao_id
from public.membros_organizacao m
where d.organizacao_id is null
  and d.user_id = m.user_id;

update public.titulos_financeiros t
set organizacao_id = m.organizacao_id
from public.membros_organizacao m
where t.organizacao_id is null
  and t.user_id = m.user_id;

update public.categorias_financeiras c
set organizacao_id = m.organizacao_id
from public.membros_organizacao m
where c.organizacao_id is null
  and c.user_id = m.user_id;

update public.chatwoot_conversations c
set organizacao_id = m.organizacao_id
from public.membros_organizacao m
where c.organizacao_id is null
  and c.user_id = m.user_id;

update public.chatwoot_messages m_msg
set organizacao_id = m.organizacao_id
from public.membros_organizacao m
where m_msg.organizacao_id is null
  and m_msg.user_id = m.user_id;

update public.chatwoot_contacts c
set organizacao_id = m.organizacao_id
from public.membros_organizacao m
where c.organizacao_id is null
  and c.user_id = m.user_id;

-- 2. Migração da tabela sync_state para multi-tenancy organizacional
alter table public.sync_state
    add column if not exists organizacao_id uuid references public.organizacoes(id) on delete cascade;

update public.sync_state s
set organizacao_id = m.organizacao_id
from public.membros_organizacao m
where s.organizacao_id is null
  and s.user_id = m.user_id;

create index if not exists idx_sync_state_org on public.sync_state(organizacao_id);

create unique index if not exists uq_sync_state_org_entidade
    on public.sync_state(organizacao_id, entidade)
    where organizacao_id is not null;

-- 3. Habilitação Defensiva de RLS
alter table public.produtos enable row level security;
alter table public.categorias enable row level security;
alter table public.clientes enable row level security;
alter table public.pedidos enable row level security;
alter table public.itens_pedido enable row level security;
alter table public.documentos_fiscais enable row level security;
alter table public.titulos_financeiros enable row level security;
alter table public.categorias_financeiras enable row level security;
alter table public.chatwoot_conversations enable row level security;
alter table public.chatwoot_messages enable row level security;
alter table public.chatwoot_contacts enable row level security;
alter table public.sync_state enable row level security;

-- 4. Políticas de RLS Canônicas: 100% baseadas em usuario_pertence_a_organizacao(organizacao_id)

-- Produtos & Categorias
drop policy if exists "Acesso ao catalogo de produtos por organizacao ou user" on public.produtos;
drop policy if exists "produtos_organizacao_select" on public.produtos;
drop policy if exists "produtos_organizacao_all" on public.produtos;
drop policy if exists "produtos_org_select" on public.produtos;
drop policy if exists "produtos_org_insert" on public.produtos;
drop policy if exists "produtos_org_update" on public.produtos;
drop policy if exists "produtos_org_delete" on public.produtos;

create policy "produtos_org_select" on public.produtos for select to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "produtos_org_insert" on public.produtos for insert to authenticated
    with check (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "produtos_org_update" on public.produtos for update to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
    with check (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "produtos_org_delete" on public.produtos for delete to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));

drop policy if exists "Acesso ao catalogo de categorias por organizacao ou user" on public.categorias;
drop policy if exists "categorias_org_select" on public.categorias;
drop policy if exists "categorias_org_insert" on public.categorias;
drop policy if exists "categorias_org_update" on public.categorias;
drop policy if exists "categorias_org_delete" on public.categorias;

create policy "categorias_org_select" on public.categorias for select to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "categorias_org_insert" on public.categorias for insert to authenticated
    with check (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "categorias_org_update" on public.categorias for update to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
    with check (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "categorias_org_delete" on public.categorias for delete to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));

-- Clientes
drop policy if exists "Acesso a clientes por organizacao ou user" on public.clientes;
drop policy if exists "clientes_org_select" on public.clientes;
drop policy if exists "clientes_org_insert" on public.clientes;
drop policy if exists "clientes_org_update" on public.clientes;
drop policy if exists "clientes_org_delete" on public.clientes;

create policy "clientes_org_select" on public.clientes for select to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "clientes_org_insert" on public.clientes for insert to authenticated
    with check (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "clientes_org_update" on public.clientes for update to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
    with check (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "clientes_org_delete" on public.clientes for delete to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));

-- Pedidos
drop policy if exists "Acesso a pedidos por organizacao ou user" on public.pedidos;
drop policy if exists "pedidos_org_select" on public.pedidos;
drop policy if exists "pedidos_org_insert" on public.pedidos;
drop policy if exists "pedidos_org_update" on public.pedidos;
drop policy if exists "pedidos_org_delete" on public.pedidos;

create policy "pedidos_org_select" on public.pedidos for select to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "pedidos_org_insert" on public.pedidos for insert to authenticated
    with check (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "pedidos_org_update" on public.pedidos for update to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
    with check (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "pedidos_org_delete" on public.pedidos for delete to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));

-- Itens de Pedido
drop policy if exists "Acesso a itens_pedido por organizacao ou user" on public.itens_pedido;
drop policy if exists "itens_pedido_org_select" on public.itens_pedido;
drop policy if exists "itens_pedido_org_insert" on public.itens_pedido;
drop policy if exists "itens_pedido_org_update" on public.itens_pedido;
drop policy if exists "itens_pedido_org_delete" on public.itens_pedido;

create policy "itens_pedido_org_select" on public.itens_pedido for select to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "itens_pedido_org_insert" on public.itens_pedido for insert to authenticated
    with check (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "itens_pedido_org_update" on public.itens_pedido for update to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
    with check (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "itens_pedido_org_delete" on public.itens_pedido for delete to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));

-- Documentos Fiscais
drop policy if exists "Acesso a documentos_fiscais por organizacao ou user" on public.documentos_fiscais;
drop policy if exists "documentos_fiscais_org_select" on public.documentos_fiscais;
drop policy if exists "documentos_fiscais_org_insert" on public.documentos_fiscais;
drop policy if exists "documentos_fiscais_org_update" on public.documentos_fiscais;
drop policy if exists "documentos_fiscais_org_delete" on public.documentos_fiscais;

create policy "documentos_fiscais_org_select" on public.documentos_fiscais for select to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "documentos_fiscais_org_insert" on public.documentos_fiscais for insert to authenticated
    with check (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "documentos_fiscais_org_update" on public.documentos_fiscais for update to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
    with check (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "documentos_fiscais_org_delete" on public.documentos_fiscais for delete to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));

-- Financeiro (Títulos e Categorias)
drop policy if exists "Acesso a titulos_financeiros por organizacao ou user" on public.titulos_financeiros;
drop policy if exists "titulos_org_select" on public.titulos_financeiros;
drop policy if exists "titulos_org_insert" on public.titulos_financeiros;
drop policy if exists "titulos_org_update" on public.titulos_financeiros;
drop policy if exists "titulos_org_delete" on public.titulos_financeiros;

create policy "titulos_org_select" on public.titulos_financeiros for select to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "titulos_org_insert" on public.titulos_financeiros for insert to authenticated
    with check (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "titulos_org_update" on public.titulos_financeiros for update to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
    with check (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "titulos_org_delete" on public.titulos_financeiros for delete to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));

drop policy if exists "Acesso a categorias_financeiras por organizacao ou user" on public.categorias_financeiras;
drop policy if exists "categorias_fin_org_select" on public.categorias_financeiras;
drop policy if exists "categorias_fin_org_insert" on public.categorias_financeiras;
drop policy if exists "categorias_fin_org_update" on public.categorias_financeiras;
drop policy if exists "categorias_fin_org_delete" on public.categorias_financeiras;

create policy "categorias_fin_org_select" on public.categorias_financeiras for select to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "categorias_fin_org_insert" on public.categorias_financeiras for insert to authenticated
    with check (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "categorias_fin_org_update" on public.categorias_financeiras for update to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
    with check (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
create policy "categorias_fin_org_delete" on public.categorias_financeiras for delete to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));

-- Chatwoot (Conversas, Mensagens e Contatos)
drop policy if exists "Acesso a chatwoot_conversations por organizacao" on public.chatwoot_conversations;
drop policy if exists "chatwoot_conversations_org_select" on public.chatwoot_conversations;
drop policy if exists "chatwoot_conversations_org_all" on public.chatwoot_conversations;

create policy "chatwoot_conversations_org_all" on public.chatwoot_conversations for all to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
    with check (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));

drop policy if exists "Acesso a chatwoot_messages por organizacao" on public.chatwoot_messages;
drop policy if exists "chatwoot_messages_org_all" on public.chatwoot_messages;

create policy "chatwoot_messages_org_all" on public.chatwoot_messages for all to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
    with check (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));

drop policy if exists "Acesso a chatwoot_contacts por organizacao" on public.chatwoot_contacts;
drop policy if exists "chatwoot_contacts_org_all" on public.chatwoot_contacts;

create policy "chatwoot_contacts_org_all" on public.chatwoot_contacts for all to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
    with check (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));

-- Sync State
drop policy if exists "Isolamento por tenant" on public.sync_state;
drop policy if exists "sync_state_org_all" on public.sync_state;

create policy "sync_state_org_all" on public.sync_state for all to authenticated
    using (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
    with check (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id));
