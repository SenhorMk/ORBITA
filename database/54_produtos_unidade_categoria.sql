-- 54_produtos_unidade_categoria.sql
-- Forward-only.
--
-- `produtos` nunca teve as colunas `unidade` e `categoria_id`, mas o tipo
-- TypeScript `Produto` declara as duas e o codigo grava as duas:
--
--   src/services/sync.ts        -> `unidade: bp.unidade || 'UN'` em todo produto
--   src/app/api/produtos/update -> `categoria_id: produto.categoriaId`
--
-- O efeito era invisivel e total: cada insert de produto era recusado pelo
-- PostgREST ("could not find the 'unidade' column"), o laco de paginacao da
-- sincronizacao capturava a falha por item, so registrava um `console.warn`, e
-- a etapa concluia com zero produtos. A sincronizacao dizia "Sincronizado! 0
-- produtos" com o catalogo cheio no Bling.
--
-- As duas colunas sao atributos legitimos que o app ja coleta e ja envia ao
-- Bling: `unidade` e obrigatoria para NF-e, e a categoria vem de
-- `GET /categorias/produtos` e ja e escolhida no formulario de produto.

alter table public.produtos
    add column if not exists unidade text;

alter table public.produtos
    add column if not exists categoria_id uuid;

-- A categoria precisa ser da MESMA organizacao. `categorias` ainda nao tem
-- unique em `(id, organizacao_id)` — ele e criado aqui para que a FK composta
-- seja possivel, no mesmo padrao ja usado pelo financeiro na migration 43.
alter table public.categorias
    drop constraint if exists uq_categorias_id_org;
alter table public.categorias
    add constraint uq_categorias_id_org unique (id, organizacao_id);

alter table public.produtos
    drop constraint if exists fk_produto_categoria_org;
alter table public.produtos
    add constraint fk_produto_categoria_org
    foreign key (categoria_id, organizacao_id)
    references public.categorias(id, organizacao_id);

create index if not exists idx_produtos_categoria on public.produtos(categoria_id)
    where categoria_id is not null;

comment on column public.produtos.unidade is
    'Unidade de medida (UN, KG, PC...). Obrigatoria no Bling para NF-e.';
comment on column public.produtos.categoria_id is
    'Categoria local, espelhada de GET /categorias/produtos do Bling.';

-- ----------------------------------------------------------------------------
-- `clientes`: endereco e classificacao fiscal.
--
-- O tipo `Cliente` declarava `tipo`, `contribuinte`, `cep`, `endereco`,
-- `numero`, `bairro`, `cidade` e `uf` com o comentario "campos extras nao
-- salvos no Supabase". A consequencia nao era so um tipo mentiroso: como nada
-- disso era lido de volta, o formulario de edicao abria SEMPRE com o endereco
-- vazio. Editar o telefone de um cliente ja cadastrado enviava um PUT sem
-- endereco ao Bling, com risco de apagar o que estava la.
--
-- `indicador_ie` substitui o antigo `contribuinte`: o campo real do Bling e
-- `indicadorIe` (1 contribuinte, 2 isento, 9 nao contribuinte), como o Ticket
-- 32 apurou contra o schema oficial.
-- ----------------------------------------------------------------------------
alter table public.clientes add column if not exists tipo text;
alter table public.clientes add column if not exists indicador_ie integer;
alter table public.clientes add column if not exists cep text;
alter table public.clientes add column if not exists endereco text;
alter table public.clientes add column if not exists numero text;
alter table public.clientes add column if not exists bairro text;
alter table public.clientes add column if not exists cidade text;
alter table public.clientes add column if not exists uf text;

alter table public.clientes drop constraint if exists chk_cliente_tipo;
alter table public.clientes add constraint chk_cliente_tipo
    check (tipo is null or tipo in ('J', 'F', 'E'));

alter table public.clientes drop constraint if exists chk_cliente_indicador_ie;
alter table public.clientes add constraint chk_cliente_indicador_ie
    check (indicador_ie is null or indicador_ie in (1, 2, 9));

alter table public.clientes drop constraint if exists chk_cliente_uf;
alter table public.clientes add constraint chk_cliente_uf
    check (uf is null or length(uf) = 2);

comment on column public.clientes.indicador_ie is
    'indicadorIe do Bling: 1 contribuinte ICMS, 2 isento, 9 nao contribuinte.';
