-- 79_eventos_de_auditoria_do_catalogo.sql
-- Forward-only. Eventos de auditoria do cadastro de produto e da
-- sincronização de categorias (PRE-006B).
--
-- Projeção SQL do catálogo executável em
-- `src/lib/observability/auditEventCatalog.ts`; `auditEventCatalog.test.ts`
-- confere que os dois lados listam os mesmos eventos.
--
-- Metadata: ids técnicos (produto, `bling_id`), a operação, o desfecho do
-- saldo, o tipo/status do erro do Bling e contagens. Nunca nome, SKU, preço,
-- descrição de categoria ou corpo do Bling.
--
-- Só dados: nenhuma tabela, policy, grant ou função muda.

insert into public.catalogo_eventos_auditoria
    (nome, versao, produtor, severidade, ator_esperado, retention_dias, alerta_regra, descricao)
values
    ('catalog.product_saved', 1, 'catalog', 'info', 'user', 730, null,
     'Produto cadastrado ou atualizado no Bling e espelhado no ORBITA.'),
    ('catalog.product_save_rejected', 1, 'catalog', 'info', 'user', 730, null,
     'O Bling recusou o cadastro ou a atualização do produto; nada foi gravado.'),
    ('catalog.product_reconcile_required', 1, 'catalog', 'critical', 'user', 730, null,
     'Gravação do produto sem confirmação do Bling, ou confirmada lá e não espelhada no ORBITA.'),
    ('catalog.categories_synced', 1, 'catalog', 'info', 'user', 730, null,
     'Categorias do Bling sincronizadas no ORBITA.'),
    ('catalog.categories_sync_failed', 1, 'catalog', 'warning', 'user', 730, null,
     'Sincronização de categorias interrompida; as páginas anteriores à falha ficaram gravadas.')
on conflict (nome) do nothing;
