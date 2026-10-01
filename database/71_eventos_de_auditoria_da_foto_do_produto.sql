-- 71_eventos_de_auditoria_da_foto_do_produto.sql
-- Forward-only. Eventos de auditoria da foto do produto (migration 70).
--
-- Projeção SQL do catálogo executável em
-- `src/lib/observability/auditEventCatalog.ts`; `auditEventCatalog.test.ts`
-- confere que os dois lados listam os mesmos eventos.
--
-- Metadata: o id do produto, se havia foto anterior e o desfecho técnico da
-- limpeza do objeto antigo. Nunca nome do arquivo original, URL assinada,
-- token de upload, conteúdo ou bytes da imagem.

insert into public.catalogo_eventos_auditoria
    (nome, versao, produtor, severidade, ator_esperado, retention_dias, alerta_regra, descricao)
values
    ('catalog.product_image_uploaded', 1, 'catalog', 'info', 'user', 730, null,
     'Foto do produto adicionada ou trocada no ORBITA.'),
    ('catalog.product_image_removed', 1, 'catalog', 'info', 'user', 730, null,
     'Foto do produto removida no ORBITA; a imagem do Bling volta a ser exibida.')
on conflict (nome) do nothing;
