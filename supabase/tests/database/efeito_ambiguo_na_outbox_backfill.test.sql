-- efeito_ambiguo_na_outbox_backfill.test.sql
-- MSG-007, migration 86 aplicada sobre uma outbox que já tem histórico.
--
-- Prova: `sent` antigo ganha a confirmação legada sem inventar recibo; envio
-- inline do Chatwoot que ainda podia ser reenviado vira `unknown`; o que não
-- foi despachado continua na fila; uma falha no meio da migration não deixa
-- nada para trás; reaplicar não muda nada.
--
-- REINTRODUZIR O DEFEITO (medido): sem o backfill do envio inline, a
-- autoverificação aborta a migration e 5 falha.

begin;

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/25_conexoes_credenciais_privadas.sql
\ir ../../../database/28_inbox_idempotente_bling.sql
\ir ../../../database/29_inbox_idempotente_chatwoot.sql
\ir ../../../database/30_jobs_sync_duraveis.sql
\ir ../../../database/31_outbox_retries_saude_integracoes.sql
\ir ../../../database/48_outbox_lease_correlacao.sql

-- Os grants padrão do laboratório dão DML ao navegador; a cadeia canônica os
-- revoga antes da 86 (medido) e a autoverificação da migration confere.
revoke insert, update, delete, truncate on public.outbox_eventos from anon, authenticated;

-- Só o que a migration lê do catálogo de auditoria (migration 52).
create table if not exists public.catalogo_eventos_auditoria (
    nome text primary key, versao integer, produtor text, severidade text,
    ator_esperado text, retention_dias integer, alerta_regra text, descricao text
);

create function pg_temp.aplicar_migration_86() returns void language plpgsql as $migracao$
begin
\ir ../../../database/86_efeito_ambiguo_na_outbox.sql
end
$migracao$;

insert into auth.users (id, email) values ('e7100000-0000-4000-8000-0000000000a1', 'dono-m7-backfill@orbita.test');
insert into public.organizacoes (id, nome, slug) values ('e7100000-0000-4000-8000-00000000000a', 'Org M7 Backfill', 'org-m7-backfill');

insert into public.outbox_eventos (id, organizacao_id, idempotency_key, destination, event_type, payload, status, response_body, sent_at,
                                   lease_owner, lease_expires_at) values
    ('e7100000-0000-4000-8000-000000000001', 'e7100000-0000-4000-8000-00000000000a', 's-com-id', 'chatwoot', 'message.send', '{}', 'sent', '{"id": 55}', now(), null, null),
    ('e7100000-0000-4000-8000-000000000002', 'e7100000-0000-4000-8000-00000000000a', 's-sem-id', 'bling', 'contato.delete', '{}', 'sent', null, now(), null, null),
    ('e7100000-0000-4000-8000-000000000003', 'e7100000-0000-4000-8000-00000000000a', 'inline-1', 'chatwoot', 'message.send', '{}', 'pending', null, null, null, null),
    ('e7100000-0000-4000-8000-000000000004', 'e7100000-0000-4000-8000-00000000000a', 'inline-2', 'chatwoot', 'message.send', '{}', 'processing', null, null, 'w', now() + interval '1 minute'),
    ('e7100000-0000-4000-8000-000000000005', 'e7100000-0000-4000-8000-00000000000a', 'inline-3', 'chatwoot', 'message.send', '{}', 'failed_transient', null, null, null, null),
    ('e7100000-0000-4000-8000-000000000006', 'e7100000-0000-4000-8000-00000000000a', 'bling-1', 'bling', 'contato.delete', '{}', 'pending', null, null, null, null),
    ('e7100000-0000-4000-8000-000000000007', 'e7100000-0000-4000-8000-00000000000a', 'inline-4', 'chatwoot', 'message.send', '{}', 'dead_letter', null, null, null, null);

create temp table antes as select id, status from public.outbox_eventos;

select plan(14);

-- 1-3. Falha no meio: nada fica para trás.
create function pg_temp.falha() returns trigger language plpgsql as $$
begin
    raise exception 'falha injetada no catalogo' using errcode = 'P0001';
end;
$$;
create trigger falha_injetada before insert on public.catalogo_eventos_auditoria
    for each row execute function pg_temp.falha();

select throws_ok($$ select pg_temp.aplicar_migration_86() $$, 'P0001', null,
                 '1. a falha injetada aborta a migration');
select ok(to_regclass('public.outbox_tentativas') is null
          and to_regprocedure('public.concluir_evento_outbox(uuid,text,text,jsonb,text,text,integer)') is not null,
          '2. nenhum objeto novo e nenhuma função legada removida ficaram');
select is((select count(*)::int from public.outbox_eventos o join antes a using (id) where o.status <> a.status),
          0, '3. nenhum status mudou');

drop trigger falha_injetada on public.catalogo_eventos_auditoria;

-- 4-11. A migration conclui.
select lives_ok($$ select pg_temp.aplicar_migration_86() $$, '4. a migration conclui');
select is((select string_agg(status, ',' order by idempotency_key) from public.outbox_eventos
            where idempotency_key like 'inline-%'),
          'unknown,unknown,unknown,dead_letter', '5. envio inline elegível vira unknown; o terminal fica');
select is((select count(*)::int from public.outbox_eventos
            where idempotency_key in ('inline-1', 'inline-2', 'inline-3')
              and motivo_bloqueio = 'envio_inline_legado' and desconhecido_em is not null
              and lease_owner is null and lease_expires_at is null),
          3, '6. com o motivo e sem lease');
select is((select confirmacao || '/' || recibo_ref from public.outbox_eventos where idempotency_key = 's-com-id'),
          'legado_pre_msg007/55', '7. sent legado com id guarda o id como recibo');
select is((select confirmacao || '/' || coalesce(recibo_ref, 'sem-recibo') from public.outbox_eventos where idempotency_key = 's-sem-id'),
          'legado_pre_msg007/sem-recibo', '8. sem id, nenhum recibo é inventado');
select is((select status from public.outbox_eventos where idempotency_key = 'bling-1'), 'pending',
          '9. o que nunca foi despachado continua na fila');
select ok(to_regprocedure('public.concluir_evento_outbox(uuid,text,text,jsonb,text,text,integer)') is null
          and to_regprocedure('public.reivindicar_lote_outbox(text,integer,integer)') is null,
          '10. as funções legadas sem fencing saíram');
select is((select count(*)::int from public.catalogo_eventos_auditoria where nome like 'outbox.%'), 4,
          '11. os eventos de auditoria do catálogo entraram');

-- 12-14. Reaplicar não muda nada; o legado não pode mais ser marcado sent sem recibo.
create temp table depois as select id, status, desconhecido_em, confirmacao from public.outbox_eventos;
select lives_ok($$ select pg_temp.aplicar_migration_86() $$, '12. reaplicar conclui');
select is((select count(*)::int from public.outbox_eventos o join depois d using (id)
            where o.status <> d.status or o.desconhecido_em is distinct from d.desconhecido_em
               or o.confirmacao is distinct from d.confirmacao),
          0, '13. e não muda nenhuma linha');
select throws_ok($$ update public.outbox_eventos set status = 'sent', confirmacao = 'legado_pre_msg007'
                     where idempotency_key = 'bling-1' $$,
                 '23514', null, '14. nenhuma linha nova vira sent pela porta do legado');

select * from finish();
rollback;
