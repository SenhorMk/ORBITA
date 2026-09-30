-- 70_foto_personalizada_do_produto.sql
-- Forward-only. A foto que o ORBITA guarda para um produto.
--
-- `imagem_url` já existe e é o ESPELHO do Bling: a sincronização e o webhook
-- de produto a regravam a cada passagem. Guardar ali a foto escolhida no
-- ORBITA faria a próxima sincronização apagá-la. A foto local ganha coluna
-- própria, que nenhum caminho de sincronização escreve.
--
-- A coluna guarda só o caminho estável do objeto no bucket privado
-- `produto-imagens`. Nunca URL assinada, token de upload, base64 ou bytes: a
-- URL de leitura é gerada a cada leitura e expira.
--
-- O formato do caminho é `<organizacao_id>/<produto_id>/<uuid>.<ext>`, gerado
-- pelo servidor. A restrição abaixo o prende à PRÓPRIA linha: um caminho de
-- outra organização, ou de outro produto da mesma organização, é recusado pelo
-- banco mesmo que um adapter com service-role erre o filtro. Como toda remoção
-- de objeto parte de um valor que já esteve nesta coluna, isso também impede
-- que a limpeza de uma foto substituída apague arquivo de outro tenant.
--
-- Precedência de apresentação (aplicada em `/api/dashboard` e
-- `/api/produtos`): foto do ORBITA → `imagem_url` do Bling → placeholder.
--
-- Impacto de lock: `add column` sem default é só catálogo. A restrição entra
-- `not valid` (lock breve) e é validada em seguida com SHARE UPDATE EXCLUSIVE,
-- que não bloqueia leitura nem escrita; a coluna recém-criada é toda nula.
--
-- Rollback: forward-only. Desfazer é uma migration nova que remove a
-- restrição e a coluna — depois de a aplicação deixar de lê-la.

alter table public.produtos
    add column if not exists imagem_storage_path text;

alter table public.produtos
    drop constraint if exists chk_produto_imagem_storage_path;

alter table public.produtos
    add constraint chk_produto_imagem_storage_path check (
        imagem_storage_path is null
        or (
            organizacao_id is not null
            and imagem_storage_path ~ (
                '^' || organizacao_id::text || '/' || id::text
                || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
            )
        )
    ) not valid;

alter table public.produtos
    validate constraint chk_produto_imagem_storage_path;

comment on column public.produtos.imagem_storage_path is
    'Caminho da foto escolhida no ORBITA no bucket privado produto-imagens '
    '(<organizacao_id>/<produto_id>/<uuid>.<ext>). Nunca URL nem token. '
    'A sincronização com o Bling não escreve nesta coluna.';
