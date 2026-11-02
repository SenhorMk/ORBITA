-- 82_revogar_dml_direto_financeiro.sql
-- Forward-only. PRE-007A: o navegador deixa de poder escrever direto nas
-- quatro tabelas financeiras, e as duas correções locais de título passam a
-- gravar o efeito e a auditoria na mesma transação.
--
-- ESTADO ANTERIOR (medido no laboratório com a cadeia canônica 01-81):
--   `authenticated` tem SELECT, INSERT, UPDATE e DELETE efetivos em
--   titulos_financeiros, fornecedores, contas_financeiras e
--   categorias_financeiras, por grant explícito (migration 24). As policies
--   `*_org_{select,insert,update,delete}` (só membership, migration 45) são o
--   único limite: qualquer membro, inclusive `member`, marca um título como
--   pago, altera o valor ou apaga despesas da própria organização pelo
--   PostgREST com o próprio token, sem passar pelas APIs, pela capacidade
--   `organization:manage` nem pela auditoria.
--
-- O QUE MUDA:
--   1. INSERT, UPDATE, DELETE e TRUNCATE saem de `authenticated`, `anon` e
--      PUBLIC nas quatro tabelas (o revoke da tabela também revoga os grants
--      de coluna).
--   2. As policies legadas com o ramo `user_id = auth.uid()` (migration 24)
--      são removidas pelo nome, caso tenham sobrevivido num banco que divergiu
--      da cadeia. A autoverificação exige que toda policy das quatro tabelas
--      seja de `authenticated` e não tenha ramo `auth.uid()`.
--   3. `excluir_lancamento_interno_auditado` e
--      `cancelar_despesa_local_auditada`: o DELETE/UPDATE da correção de título
--      e o evento `finance.entry_deleted`/`finance.expense_cancelled` numa
--      única transação. Se a auditoria falhar, a mutação não acontece. Só
--      `service_role` executa.
--
-- O QUE NÃO MUDA:
--   - SELECT de `authenticated` sob RLS (leitura conforme a membership).
--   - `service_role`: rotas, sincronização com o Bling e as RPCs do PRE-002.
--   - As policies de escrita por membership: sem grant elas não são
--     alcançáveis, e ficam como segunda barreira se um grant voltar por engano.
--
-- RECUPERAÇÃO: não se restaura grant amplo. Se um fluxo legítimo quebrar, ele
-- dependia do token do usuário: corrige-se o comando no servidor e, até lá,
-- bloqueia-se a ação afetada (ver docs/operations/pre-007a-runbook.md).

set local lock_timeout = '5s';

revoke insert, update, delete, truncate
    on public.titulos_financeiros,
       public.fornecedores,
       public.contas_financeiras,
       public.categorias_financeiras
  from authenticated, anon, public;

-- Só derruba a policy legada que existe: `DROP POLICY IF EXISTS` tomaria
-- ACCESS EXCLUSIVE nas quatro tabelas mesmo sem nada a remover, e na cadeia
-- canônica nenhuma delas sobrou (a 45 já as trocou).
do $$
declare
    v_policy record;
begin
    for v_policy in
        select c.relname, p.polname
          from pg_policy p join pg_class c on c.oid = p.polrelid
         where c.relnamespace = 'public'::regnamespace
           and c.relname in ('titulos_financeiros', 'fornecedores', 'contas_financeiras', 'categorias_financeiras')
           and (p.polname = 'Acesso a ' || c.relname || ' por organizacao ou user'
                or p.polname = 'Enable all access for ' || c.relname
                or p.polname = 'Isolamento por tenant')
    loop
        execute format('drop policy %I on public.%I', v_policy.polname, v_policy.relname);
    end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Exclusão de lançamento puramente interno, com auditoria obrigatória.
--
-- As condições repetem as de `FinanceiroRepository.excluirLancamentoInterno`:
-- só `pagar`, sem `bling_id`, sem `pedido_id`, ativo, desta organização. A
-- situação anterior gravada no evento é a da linha apagada, não a que o
-- servidor leu antes. Devolve quantas linhas saíram (0 ou 1).
-- ---------------------------------------------------------------------------
create or replace function public.excluir_lancamento_interno_auditado(
    p_organizacao_id uuid,
    p_ator_id uuid,
    p_titulo_id uuid,
    p_correlation_id text
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_situacao text;
begin
    if p_organizacao_id is null or p_ator_id is null or p_titulo_id is null then
        raise exception 'Organizacao, ator e titulo sao obrigatorios.' using errcode = '22023';
    end if;

    delete from public.titulos_financeiros tf
     where tf.id = p_titulo_id
       and tf.organizacao_id = p_organizacao_id
       and tf.tipo = 'pagar'
       and tf.bling_id is null
       and tf.pedido_id is null
       and tf.situacao in ('aberto', 'pago')
    returning tf.situacao into v_situacao;
    if not found then
        return 0;
    end if;

    perform public.registrar_evento_auditoria(
        p_organizacao_id, p_ator_id, 'finance.entry_deleted', 'titulo_financeiro', p_titulo_id::text,
        p_correlation_id, null, null,
        jsonb_build_object('situacao_anterior', v_situacao, 'origem', 'interno'));
    return 1;
end;
$$;

revoke all on function public.excluir_lancamento_interno_auditado(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.excluir_lancamento_interno_auditado(uuid, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Conclusão local do cancelamento de uma despesa do Bling, com auditoria
-- obrigatória. O servidor só chama depois de provar a ausência remota; a
-- evidência é um dos três valores do contrato. Devolve quantas linhas mudaram.
-- ---------------------------------------------------------------------------
create or replace function public.cancelar_despesa_local_auditada(
    p_organizacao_id uuid,
    p_ator_id uuid,
    p_titulo_id uuid,
    p_correlation_id text,
    p_evidencia text
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_situacao text;
    v_bling_id text;
begin
    if p_organizacao_id is null or p_ator_id is null or p_titulo_id is null then
        raise exception 'Organizacao, ator e titulo sao obrigatorios.' using errcode = '22023';
    end if;
    if p_evidencia is null or p_evidencia not in ('remoto_ausente', 'remoto_cancelado', 'exclusao_confirmada') then
        raise exception 'Evidencia de cancelamento invalida.' using errcode = '22023';
    end if;

    select tf.situacao, tf.bling_id::text into v_situacao, v_bling_id
      from public.titulos_financeiros tf
     where tf.id = p_titulo_id
       and tf.organizacao_id = p_organizacao_id
       and tf.tipo = 'pagar'
       and tf.bling_id is not null
       and tf.pedido_id is null
       and tf.situacao in ('aberto', 'pago')
       for update;
    if not found then
        return 0;
    end if;

    update public.titulos_financeiros tf
       set situacao = 'cancelado'
     where tf.id = p_titulo_id
       and tf.organizacao_id = p_organizacao_id;

    perform public.registrar_evento_auditoria(
        p_organizacao_id, p_ator_id, 'finance.expense_cancelled', 'titulo_financeiro', p_titulo_id::text,
        p_correlation_id, null, null,
        jsonb_build_object('bling_id', v_bling_id, 'evidencia', p_evidencia, 'situacao_anterior', v_situacao));
    return 1;
end;
$$;

revoke all on function public.cancelar_despesa_local_auditada(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.cancelar_despesa_local_auditada(uuid, uuid, uuid, text, text) to service_role;

-- Autoverificação: aborta a transação se sobrar escrita do navegador (tabela
-- ou coluna), se a leitura ou o DML do servidor sumir, ou se alguma policy
-- das quatro tabelas tiver ramo `auth.uid()` ou outro papel.
do $$
declare
    v_tabela text;
    v_papel text;
    v_coluna text;
    v_policy text;
begin
    foreach v_tabela in array array['titulos_financeiros', 'fornecedores', 'contas_financeiras', 'categorias_financeiras'] loop
        foreach v_papel in array array['authenticated', 'anon'] loop
            if has_table_privilege(v_papel, 'public.' || v_tabela, 'INSERT')
               or has_table_privilege(v_papel, 'public.' || v_tabela, 'UPDATE')
               or has_table_privilege(v_papel, 'public.' || v_tabela, 'DELETE')
               or has_table_privilege(v_papel, 'public.' || v_tabela, 'TRUNCATE') then
                raise exception 'PRE-007A: % ainda escreve em public.%', v_papel, v_tabela;
            end if;
            select a.attname into v_coluna
              from pg_attribute a
             where a.attrelid = ('public.' || v_tabela)::regclass and a.attnum > 0 and not a.attisdropped
               and (has_column_privilege(v_papel, a.attrelid, a.attname, 'INSERT')
                    or has_column_privilege(v_papel, a.attrelid, a.attname, 'UPDATE'))
             limit 1;
            if v_coluna is not null then
                raise exception 'PRE-007A: % ainda escreve em public.%.%', v_papel, v_tabela, v_coluna;
            end if;
        end loop;
        if not has_table_privilege('authenticated', 'public.' || v_tabela, 'SELECT') then
            raise exception 'PRE-007A: authenticated perdeu a leitura de public.%', v_tabela;
        end if;
        if not (has_table_privilege('service_role', 'public.' || v_tabela, 'SELECT')
                and has_table_privilege('service_role', 'public.' || v_tabela, 'INSERT')
                and has_table_privilege('service_role', 'public.' || v_tabela, 'UPDATE')
                and has_table_privilege('service_role', 'public.' || v_tabela, 'DELETE')) then
            raise exception 'PRE-007A: service_role perdeu DML em public.%', v_tabela;
        end if;
        select p.polname into v_policy
          from pg_policy p
         where p.polrelid = ('public.' || v_tabela)::regclass
           and (coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~ 'auth\.uid'
                or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~ 'auth\.uid'
                or not (p.polroles = array['authenticated'::regrole]::oid[]))
         limit 1;
        if v_policy is not null then
            raise exception 'PRE-007A: policy % de public.% não é só por organização', v_policy, v_tabela;
        end if;
    end loop;
end;
$$;

notify pgrst, 'reload schema';
