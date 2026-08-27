-- ============================================================================
-- 43_expand_financeiro_organizacao_obrigatoria.sql
-- Ticket 09 (orbita-mvp-producao-v2): fase EXPAND da jornada financeira
-- (contas_financeiras, categorias_financeiras, fornecedores,
-- titulos_financeiros) com escopo organizacional verificado, sem policy
-- OR user_id e sem FK legada.
--
-- Esta migration NAO torna organizacao_id NOT NULL (isso ocorre na fase
-- CONTRACT, migration 45, apos o backfill contabilizado da migration 44).
-- FKs compostas em Postgres nao sao verificadas quando qualquer coluna da
-- chave e NULL (MATCH SIMPLE, o default), logo podem ser adicionadas aqui
-- com seguranca antes do backfill.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Chaves unicas (id, organizacao_id) para permitir FKs compostas por filho
-- ----------------------------------------------------------------------------
alter table public.contas_financeiras
    add constraint uq_contas_financeiras_id_org unique (id, organizacao_id);

alter table public.categorias_financeiras
    add constraint uq_categorias_financeiras_id_org unique (id, organizacao_id);

alter table public.fornecedores
    add constraint uq_fornecedores_id_org unique (id, organizacao_id);

-- ----------------------------------------------------------------------------
-- 2. FKs compostas anti cross-tenant: titulos_financeiros so pode referenciar
--    categoria/conta/fornecedor da MESMA organizacao. Substituem a validacao
--    apenas-por-trigger das migrations 13/24 (que permanecem como defesa em
--    profundidade, mas nao sao mais a unica barreira).
-- ----------------------------------------------------------------------------
alter table public.titulos_financeiros
    drop constraint if exists fk_titulo_categoria_org;
alter table public.titulos_financeiros
    add constraint fk_titulo_categoria_org
    foreign key (categoria_id, organizacao_id) references public.categorias_financeiras(id, organizacao_id);

alter table public.titulos_financeiros
    drop constraint if exists fk_titulo_conta_org;
alter table public.titulos_financeiros
    add constraint fk_titulo_conta_org
    foreign key (conta_financeira_id, organizacao_id) references public.contas_financeiras(id, organizacao_id);

alter table public.titulos_financeiros
    drop constraint if exists fk_titulo_fornecedor_org;
alter table public.titulos_financeiros
    add constraint fk_titulo_fornecedor_org
    foreign key (fornecedor_id, organizacao_id) references public.fornecedores(id, organizacao_id);

-- ----------------------------------------------------------------------------
-- 3. Indices de consulta por organizacao (vencimento/situacao). O indice
--    idx_titulos_abertos_vencimento legado (schema_master, filtrado por
--    situacao = 'aberto' e sem organizacao_id como coluna principal)
--    permanece por compatibilidade e e superado em uso pelos indices abaixo.
-- ----------------------------------------------------------------------------
create index if not exists idx_titulos_financeiros_org_vencimento
    on public.titulos_financeiros(organizacao_id, data_vencimento);

create index if not exists idx_titulos_financeiros_org_situacao
    on public.titulos_financeiros(organizacao_id, situacao);

-- ----------------------------------------------------------------------------
-- 4. Tabela de quarentena e relatorio de backfill: reaproveita as tabelas
--    genericas ja criadas pela migration 40 (ticket 08) - nao recria um
--    mecanismo paralelo de quarentena para o dominio financeiro.
-- ----------------------------------------------------------------------------
-- (nenhuma DDL nesta secao: public.tenancy_backfill_quarentena e
--  public.tenancy_backfill_relatorio ja existem desde a migration 40)
