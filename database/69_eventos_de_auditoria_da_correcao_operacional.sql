-- 69_eventos_de_auditoria_da_correcao_operacional.sql
-- Forward-only. Eventos de auditoria da exclusão de contato e da correção de
-- despesa.
--
-- `catalogo_eventos_auditoria` (migration 52) é a projeção consultável em SQL
-- do catálogo executável, `src/lib/observability/auditEventCatalog.ts`. Os dois
-- precisam listar os mesmos eventos; `auditEventCatalog.test.ts` confere o
-- catálogo TypeScript contra o conjunto de nomes inseridos pelas migrations.
--
-- Metadata dos seis eventos: ids técnicos (`bling_id`), o desfecho e a
-- situação anterior. Nunca nome, CPF/CNPJ, e-mail, telefone ou corpo do Bling.
--
-- Nenhum evento de reset: esta alteração não implementa reset.

insert into public.catalogo_eventos_auditoria
    (nome, versao, produtor, severidade, ator_esperado, retention_dias, alerta_regra, descricao)
values
    ('customer.contact_deleted', 1, 'customers', 'warning', 'user', 1825, null,
     'Contato sem histórico excluído no ORBITA e, quando vinculado, no Bling.'),
    ('customer.contact_reconcile_required', 1, 'customers', 'critical', 'user', 1825, null,
     'Exclusão de contato sem confirmação do estado no Bling; nada local foi concluído.'),
    ('customer.contact_preserved_after_remote_removal', 1, 'customers', 'warning', 'user', 1825, null,
     'Contato já removido do Bling que ganhou histórico no ORBITA e foi preservado localmente.'),
    ('finance.entry_deleted', 1, 'finance', 'warning', 'user', 1825, null,
     'Lançamento de despesa puramente interno excluído por correção de entrada.'),
    ('finance.expense_cancelled', 1, 'finance', 'warning', 'user', 1825, null,
     'Despesa do Bling removida lá e mantida no histórico do ORBITA como cancelada.'),
    ('finance.remote_reconcile_required', 1, 'finance', 'critical', 'user', 1825, null,
     'Cancelamento de despesa sem confirmação do estado no Bling; nada local foi concluído.')
on conflict (nome) do nothing;
