-- 72_estado_de_sincronizacao_da_foto_com_bling.sql
-- Forward-only. O estado da foto do ORBITA no Bling.
--
-- A foto do ORBITA (migration 70) passa a ser sincronizada com o produto
-- vinculado no Bling. Banco local e Bling não participam da mesma transação,
-- então o estado é modelado como DESEJADO versus CONFIRMADO:
--
--   imagem_storage_path     — a foto que o ORBITA deseja (migration 70);
--   imagem_bling_sync_path  — a foto que se sabe refletida no Bling.
--
--   sem foto           : ambos nulos (o ORBITA nunca adotou a imagem do produto)
--   sincronizada       : storage_path = sync_path
--   nova foto pendente : storage_path distinto de sync_path
--   remoção pendente   : storage_path nulo e sync_path não nulo
--
-- Sem booleano: a pendência é derivada, e não pode contradizer o par.
--
-- A sincronização só marca sync_path com compare-and-set condicionado ao
-- storage_path que ela começou a refletir, então uma resposta atrasada da foto
-- A nunca marca a foto B. A sincronização comum Bling -> ORBITA e o webhook não
-- escrevem esta coluna (`ProdutoRepository.upsert` a remove do payload).
--
-- Como em `imagem_storage_path`, o valor é só o caminho do objeto no bucket
-- privado — nunca URL assinada — e fica preso ao prefixo da própria linha.
--
-- Impacto de lock: `add column` sem default é só catálogo; a restrição entra
-- `not valid` e é validada com SHARE UPDATE EXCLUSIVE sobre uma coluna nula.
--
-- Rollback: forward-only. O código anterior ignora a coluna.

alter table public.produtos
    add column if not exists imagem_bling_sync_path text;

alter table public.produtos
    drop constraint if exists chk_produto_imagem_bling_sync_path;

alter table public.produtos
    add constraint chk_produto_imagem_bling_sync_path check (
        imagem_bling_sync_path is null
        or (
            organizacao_id is not null
            and imagem_bling_sync_path ~ (
                '^' || organizacao_id::text || '/' || id::text
                || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
            )
        )
    ) not valid;

alter table public.produtos
    validate constraint chk_produto_imagem_bling_sync_path;

comment on column public.produtos.imagem_bling_sync_path is
    'Foto do ORBITA confirmada no Bling (caminho no bucket produto-imagens). '
    'Igual a imagem_storage_path = sincronizada. Na remoção de foto ainda não confirmada, '
    'guarda a foto que o Bling pode exibir (remoção pendente). Só as rotas da foto escrevem.';

-- Eventos da sincronização da foto com o Bling. Projeção SQL do catálogo
-- executável em `src/lib/observability/auditEventCatalog.ts`. Metadata: id do
-- produto, operação (adicionar/trocar/remover), etapa/motivo técnico e se havia
-- confirmação anterior. Nunca URL assinada, token, bytes ou corpo do Bling.

insert into public.catalogo_eventos_auditoria
    (nome, versao, produtor, severidade, ator_esperado, retention_dias, alerta_regra, descricao)
values
    ('catalog.product_image_bling_sync_pending', 1, 'catalog', 'info', 'user', 730, null,
     'Foto do produto salva no ORBITA aguardando sincronização com o Bling (produto sem vínculo).'),
    ('catalog.product_image_bling_synced', 1, 'catalog', 'info', 'user', 730, null,
     'Foto do produto convergida no Bling: exatamente a foto do ORBITA, ou nenhuma imagem.'),
    ('catalog.product_image_bling_sync_failed', 1, 'catalog', 'warning', 'user', 730, null,
     'Sincronização da foto do produto com o Bling não confirmada; estado continua pendente.')
on conflict (nome) do nothing;
