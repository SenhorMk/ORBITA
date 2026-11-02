-- 83_revogar_dml_direto_fiscal.sql
-- Forward-only. PRE-007B: o navegador deixa de poder escrever direto em
-- `documentos_fiscais`, e o registro local da NF-e emitida passa a gravar o
-- documento e a auditoria na mesma transação.
--
-- ESTADO ANTERIOR (medido no laboratório com a cadeia canônica 01-82):
--   `authenticated` tem SELECT, INSERT, UPDATE e DELETE efetivos em
--   documentos_fiscais (17 colunas graváveis), por grant explícito (migrations
--   14 e 23). As policies `documentos_fiscais_org_*` (só membership, migration
--   32) são o único limite: qualquer membro, inclusive `member`, insere uma
--   NF-e "Emitida" para um pedido, troca número, chave ou situação de uma nota
--   ou apaga a nota da própria organização pelo PostgREST com o próprio token,
--   sem passar por `POST /api/nfe`, pela capacidade `organization:manage`, pelo
--   lock da emissão nem pelo Bling.
--
-- O QUE MUDA:
--   1. INSERT, UPDATE, DELETE e TRUNCATE saem de `authenticated`, `anon` e
--      PUBLIC em documentos_fiscais (o revoke da tabela também revoga os
--      grants de coluna).
--   2. As policies legadas com `auth.uid()` (migrations 14 e 23) são removidas
--      pelo nome, caso tenham sobrevivido num banco que divergiu da cadeia. A
--      autoverificação exige que toda policy da tabela seja de `authenticated`
--      e não tenha ramo `auth.uid()`.
--   3. `registrar_documento_fiscal_emitido`: o upsert do documento devolvido
--      pelo Bling e o evento `fiscal.document_issued` numa única transação. Se
--      a auditoria falhar, o documento não é gravado. Só `service_role`
--      executa.
--
-- O QUE NÃO MUDA:
--   - SELECT de `authenticated` sob RLS (leitura conforme a membership).
--   - `service_role`: `POST /api/nfe` e o embed `nfe:documentos_fiscais` dos
--     pedidos. O upsert direto de `pedidoRepository.upsertNfe` continua
--     funcionando até a aplicação passar a chamar a RPC.
--   - As policies de escrita por membership: sem grant elas não são
--     alcançáveis, e ficam como segunda barreira se um grant voltar por engano.
--
-- RECUPERAÇÃO: não se restaura grant amplo. Se um fluxo legítimo quebrar, ele
-- dependia do token do usuário: corrige-se o comando no servidor e, até lá,
-- bloqueia-se a ação afetada (ver docs/operations/pre-007b-runbook.md).

set local lock_timeout = '5s';

revoke insert, update, delete, truncate
    on public.documentos_fiscais
  from authenticated, anon, public;

-- Só derruba a policy legada que existe: `DROP POLICY IF EXISTS` tomaria
-- ACCESS EXCLUSIVE na tabela mesmo sem nada a remover, e na cadeia canônica
-- nenhuma delas sobrou (a 32 já as trocou).
do $$
declare
    v_policy record;
begin
    for v_policy in
        select p.polname
          from pg_policy p
         where p.polrelid = 'public.documentos_fiscais'::regclass
           and p.polname in ('Acesso a documentos_fiscais por organizacao ou user',
                             'Enable all access for documentos_fiscais',
                             'Isolamento por tenant')
    loop
        execute format('drop policy %I on public.documentos_fiscais', v_policy.polname);
    end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Evento de auditoria (projeção SQL de `auditEventCatalog.ts`).
--
-- Metadata: ids técnicos, situação e se a linha foi criada ou atualizada.
-- Nunca chave de acesso, destinatário, itens, valores ou corpo do Bling.
-- ---------------------------------------------------------------------------
insert into public.catalogo_eventos_auditoria
    (nome, versao, produtor, severidade, ator_esperado, retention_dias, alerta_regra, descricao)
values
    ('fiscal.document_issued', 1, 'fiscal', 'info', 'user', 1825, null,
     'NF-e emitida no Bling e registrada no ORBITA.')
on conflict (nome) do nothing;

-- ---------------------------------------------------------------------------
-- Registro local da NF-e emitida, com auditoria obrigatória.
--
-- Repete o upsert de `pedidoRepository.upsertNfe`: conflito por
-- (organizacao_id, bling_id), tipo NFE, ator como `user_id`. O pedido de outra
-- organização é recusado pelo gatilho `trg_sync_documentos_fiscais_organizacao`
-- e pela FK composta (23503). Devolve a linha gravada.
-- ---------------------------------------------------------------------------
create or replace function public.registrar_documento_fiscal_emitido(
    p_organizacao_id uuid,
    p_ator_id uuid,
    p_pedido_id uuid,
    p_bling_id text,
    p_numero text,
    p_chave_acesso text,
    p_status text,
    p_correlation_id text
)
returns public.documentos_fiscais
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_id uuid;
    v_inserido boolean;
    v_documento public.documentos_fiscais;
begin
    if p_organizacao_id is null or p_ator_id is null or p_pedido_id is null then
        raise exception 'Organizacao, ator e pedido sao obrigatorios.' using errcode = '22023';
    end if;
    if nullif(btrim(p_bling_id), '') is null or nullif(btrim(p_numero), '') is null then
        raise exception 'Identificador e numero da nota sao obrigatorios.' using errcode = '22023';
    end if;

    insert into public.documentos_fiscais as df
        (organizacao_id, user_id, pedido_id, bling_id, numero, chave_acesso, status, tipo)
    values
        (p_organizacao_id, p_ator_id, p_pedido_id, p_bling_id, p_numero, nullif(p_chave_acesso, ''), p_status, 'NFE')
    on conflict (organizacao_id, bling_id) do update
       set user_id = excluded.user_id,
           pedido_id = excluded.pedido_id,
           numero = excluded.numero,
           chave_acesso = excluded.chave_acesso,
           status = excluded.status,
           tipo = excluded.tipo
    returning df.id, (df.xmax = 0) into v_id, v_inserido;

    select df.* into v_documento from public.documentos_fiscais df where df.id = v_id;

    perform public.registrar_evento_auditoria(
        p_organizacao_id, p_ator_id, 'fiscal.document_issued', 'documento_fiscal', v_documento.id::text,
        p_correlation_id, null, null,
        jsonb_build_object('bling_id', v_documento.bling_id, 'pedido_id', v_documento.pedido_id,
                           'status', v_documento.status, 'operacao', case when v_inserido then 'inserido' else 'atualizado' end));
    return v_documento;
end;
$$;

revoke all on function public.registrar_documento_fiscal_emitido(uuid, uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.registrar_documento_fiscal_emitido(uuid, uuid, uuid, text, text, text, text, text) to service_role;

-- Autoverificação: aborta a transação se sobrar escrita do navegador (tabela
-- ou coluna), se a leitura ou o DML do servidor sumir, se alguma policy tiver
-- ramo `auth.uid()` ou outro papel, ou se a RPC for executável pelo navegador.
do $$
declare
    v_papel text;
    v_coluna text;
    v_policy text;
begin
    foreach v_papel in array array['authenticated', 'anon'] loop
        if has_table_privilege(v_papel, 'public.documentos_fiscais', 'INSERT')
           or has_table_privilege(v_papel, 'public.documentos_fiscais', 'UPDATE')
           or has_table_privilege(v_papel, 'public.documentos_fiscais', 'DELETE')
           or has_table_privilege(v_papel, 'public.documentos_fiscais', 'TRUNCATE') then
            raise exception 'PRE-007B: % ainda escreve em public.documentos_fiscais', v_papel;
        end if;
        select a.attname into v_coluna
          from pg_attribute a
         where a.attrelid = 'public.documentos_fiscais'::regclass and a.attnum > 0 and not a.attisdropped
           and (has_column_privilege(v_papel, a.attrelid, a.attname, 'INSERT')
                or has_column_privilege(v_papel, a.attrelid, a.attname, 'UPDATE'))
         limit 1;
        if v_coluna is not null then
            raise exception 'PRE-007B: % ainda escreve em public.documentos_fiscais.%', v_papel, v_coluna;
        end if;
        if has_function_privilege(v_papel,
               'public.registrar_documento_fiscal_emitido(uuid, uuid, uuid, text, text, text, text, text)', 'execute') then
            raise exception 'PRE-007B: % executa registrar_documento_fiscal_emitido', v_papel;
        end if;
    end loop;
    if not has_table_privilege('authenticated', 'public.documentos_fiscais', 'SELECT') then
        raise exception 'PRE-007B: authenticated perdeu a leitura de public.documentos_fiscais';
    end if;
    if not (has_table_privilege('service_role', 'public.documentos_fiscais', 'SELECT')
            and has_table_privilege('service_role', 'public.documentos_fiscais', 'INSERT')
            and has_table_privilege('service_role', 'public.documentos_fiscais', 'UPDATE')
            and has_table_privilege('service_role', 'public.documentos_fiscais', 'DELETE')) then
        raise exception 'PRE-007B: service_role perdeu DML em public.documentos_fiscais';
    end if;
    select p.polname into v_policy
      from pg_policy p
     where p.polrelid = 'public.documentos_fiscais'::regclass
       and (coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~ 'auth\.uid'
            or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~ 'auth\.uid'
            or not (p.polroles = array['authenticated'::regrole]::oid[]))
     limit 1;
    if v_policy is not null then
        raise exception 'PRE-007B: policy % de public.documentos_fiscais não é só por organização', v_policy;
    end if;
end;
$$;

notify pgrst, 'reload schema';
