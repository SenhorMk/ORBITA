-- ============================================================================
-- 47_chatwoot_inbox_account_disambiguation.sql
-- Ticket 11: Concluir integração Chatwoot por organização
-- Expand: adiciona account_id ao mapeamento de inbox e passa a chave de
-- unicidade operacional para (conexao_id, inbox_id), que é o par que de fato
-- desambigua organizações cujas contas Chatwoot numerem inboxes a partir de 1.
-- Nenhum dado de produção preenche chatwoot_inboxes hoje (nenhuma rota grava
-- nessa tabela antes deste ticket), então este é um expand puro sem colisão a
-- resolver e sem necessidade de backfill/quarentena.
-- ============================================================================

-- 1. Coluna account_id: identificador da conta Chatwoot do provedor, usada como
--    verificação de posse adicional (defesa em profundidade) contra o account_id
--    persistido na credencial da conexão.
alter table public.chatwoot_inboxes
    add column if not exists account_id text;

comment on column public.chatwoot_inboxes.account_id is
    'Chatwoot account id reported by the provider for this inbox mapping. Cross-checked against the connection credential account_id, never trusted alone as tenant authority.';

-- 2. Preflight de colisão: falha explicitamente a migration se, por algum motivo
--    inesperado, já existirem linhas conflitantes que impeçam o índice único
--    abaixo (nunca resolve ambiguidade automaticamente).
do $$
declare
    v_conflicts integer;
begin
    select count(*) into v_conflicts
    from (
        select conexao_id, inbox_id
        from public.chatwoot_inboxes
        where conexao_id is not null and inbox_id is not null
        group by conexao_id, inbox_id
        having count(*) > 1
    ) dupes;

    if v_conflicts > 0 then
        raise exception 'chatwoot_inboxes has % conflicting (conexao_id, inbox_id) group(s); manual quarantine required before this migration can proceed', v_conflicts;
    end if;
end $$;

-- 3. Chave operacional de unicidade: (conexao_id, inbox_id). Esta é a chave que
--    o webhook e o sync realmente consultam para resolver o mapeamento, pois
--    conexao_id já é organization-scoped por construção (conexoes_integracao).
create unique index if not exists uq_chatwoot_inboxes_conexao_inbox
    on public.chatwoot_inboxes(conexao_id, inbox_id)
    where conexao_id is not null and inbox_id is not null;
