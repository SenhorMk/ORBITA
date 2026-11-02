-- 84_proteger_conexoes_de_integracao.sql
-- Forward-only. PRE-008: o navegador deixa de poder reatribuir organização,
-- conta, segredo ou status de uma conexão de integração, e o mapeamento de
-- inbox do Chatwoot só aponta para conexão Chatwoot da mesma organização.
--
-- ESTADO ANTERIOR (medido no laboratório com a cadeia canônica 01-83, igual
-- desde a 47 para estas tabelas):
--   - `conexoes_integracao`: `authenticated` tem SELECT, INSERT, UPDATE e
--     DELETE (12 colunas graváveis), por grant explícito da migration 25. A
--     única policy é `FOR ALL` com `usuario_pertence_a_organizacao` no USING e
--     no WITH CHECK. Qualquer membro, inclusive `member`, pelo PostgREST e com o
--     próprio token:
--       * reativa uma conexão (`status = 'conectado'`) sem OAuth nem
--         `organization:manage`;
--       * troca `metadata.client_id`, que `GET /api/bling/authorize` lê;
--       * apaga a conexão, e com ela a credencial (`on delete cascade`);
--       * move a conexão para outra organização da qual também é membro: o
--         WITH CHECK só exige membership no destino.
--   - `chatwoot_inboxes`: só SELECT para `authenticated` (migration 27), mas a
--     policy é `FOR ALL`, e nenhum gatilho confere que `conexao_id` pertence à
--     `organizacao_id` da linha.
--   - `credenciais_integracao`: nenhum privilégio para o navegador, nenhuma
--     policy (migration 25). Fica como está; a 84 só o reafirma e verifica.
--   - `integracoes_bling` (espelho legado com tokens): nenhum privilégio para o
--     navegador. Idem.
--
-- O QUE MUDA:
--   1. INSERT, UPDATE, DELETE e TRUNCATE saem de `authenticated`, `anon` e
--      PUBLIC em `conexoes_integracao` e `chatwoot_inboxes` (o revoke da
--      tabela também revoga os grants de coluna). Em `credenciais_integracao`
--      e `integracoes_bling`, tudo sai deles (já não tinham nada na cadeia).
--   2. As policies `FOR ALL` de `conexoes_integracao` e `chatwoot_inboxes` dão
--      lugar a policies só de leitura, por membership. Diferente do PRE-006D e
--      do PRE-007A/B, aqui a policy de escrita não fica como segunda barreira:
--      o WITH CHECK dela permite justamente mover a linha entre organizações.
--      Sem policy de escrita, um grant que volte por engano continua sem
--      efeito (RLS nega por padrão).
--   3. A organização de uma conexão, de uma credencial e de um mapeamento de
--      inbox não muda depois de definida, nem pelo `service_role`. Os backfills
--      antigos (que preenchem a organização a partir de NULL) continuam
--      possíveis.
--   4. Um mapeamento de inbox com `conexao_id` só é aceito se a conexão for do
--      Chatwoot e da mesma organização (`23503`). Antes de criar o gatilho, a
--      migration confere as linhas existentes e aborta se alguma violar a
--      regra: nada é corrigido automaticamente.
--   5. Os eventos `integration.connection_configured` e
--      `integration.connection_authorized` entram no catálogo de auditoria.
--
-- O QUE NÃO MUDA:
--   - SELECT de `authenticated` sob RLS em `conexoes_integracao` e
--     `chatwoot_inboxes`.
--   - `service_role`: todas as rotas de conexão, OAuth, webhooks, saúde e
--     sincronização. Nenhum caller grava com o token do usuário (inventário do
--     PRE-008), então nenhuma RPC nova é necessária.
--   - Nenhuma linha existente é alterada.
--
-- RECUPERAÇÃO: não se restaura grant amplo nem policy de escrita. Se um fluxo
-- legítimo quebrar, ele dependia do token do usuário: corrige-se o comando no
-- servidor e, até lá, pausa-se a conexão afetada (`status = 'desconectado'`
-- pelo servidor). Ver docs/operations/pre-008-runbook.md.

set local lock_timeout = '5s';

revoke insert, update, delete, truncate
    on public.conexoes_integracao, public.chatwoot_inboxes
  from authenticated, anon, public;

revoke all
    on public.credenciais_integracao, public.integracoes_bling
  from authenticated, anon, public;

-- ---------------------------------------------------------------------------
-- Policies: só leitura por membership. Remove pelo nome a `FOR ALL` canônica e
-- as legadas que tenham sobrevivido num banco que divergiu da cadeia. Só
-- derruba o que existe: `DROP POLICY IF EXISTS` tomaria ACCESS EXCLUSIVE mesmo
-- sem nada a remover.
-- ---------------------------------------------------------------------------
do $$
declare
    v_policy record;
begin
    for v_policy in
        select p.polrelid::regclass as tabela, p.polname
          from pg_policy p
         where (p.polrelid = 'public.conexoes_integracao'::regclass
                and p.polname in ('Acesso a conexoes_integracao por organizacao',
                                  'Enable all access for conexoes_integracao',
                                  'Isolamento por tenant'))
            or (p.polrelid = 'public.chatwoot_inboxes'::regclass
                and p.polname in ('Acesso a chatwoot_inboxes por organizacao',
                                  'Enable all access for chatwoot_inboxes',
                                  'Isolamento por tenant'))
    loop
        execute format('drop policy %I on %s', v_policy.polname, v_policy.tabela);
    end loop;
end;
$$;

create policy conexoes_integracao_org_select
    on public.conexoes_integracao
    for select
    to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id));

create policy chatwoot_inboxes_org_select
    on public.chatwoot_inboxes
    for select
    to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id));

-- ---------------------------------------------------------------------------
-- A organização de uma linha de integração não muda depois de definida.
-- ---------------------------------------------------------------------------
create or replace function public.fn_organizacao_da_integracao_imutavel()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if old.organizacao_id is not null and new.organizacao_id is distinct from old.organizacao_id then
        raise exception 'A organizacao de %.% nao muda depois de definida.', tg_table_schema, tg_table_name
            using errcode = '23514';
    end if;
    return new;
end;
$$;

revoke all on function public.fn_organizacao_da_integracao_imutavel() from public, anon, authenticated;

create trigger trg_organizacao_da_conexao_imutavel
    before update of organizacao_id on public.conexoes_integracao
    for each row execute function public.fn_organizacao_da_integracao_imutavel();

create trigger trg_organizacao_da_credencial_imutavel
    before update of organizacao_id on public.credenciais_integracao
    for each row execute function public.fn_organizacao_da_integracao_imutavel();

create trigger trg_organizacao_do_chatwoot_inbox_imutavel
    before update of organizacao_id on public.chatwoot_inboxes
    for each row execute function public.fn_organizacao_da_integracao_imutavel();

-- ---------------------------------------------------------------------------
-- O mapeamento de inbox aponta só para conexão Chatwoot da mesma organização.
--
-- O nome começa por `trg_v` para disparar depois de
-- `trg_sync_chatwoot_inboxes_organizacao` (migration 27), que ainda pode
-- preencher a organização a partir do `user_id`. `conexao_id` nulo continua
-- aceito: é o que a FK faz (`on delete set null`) quando a conexão some.
-- ---------------------------------------------------------------------------
do $$
declare
    v_violacoes integer;
begin
    select count(*) into v_violacoes
      from public.chatwoot_inboxes i
      left join public.conexoes_integracao c on c.id = i.conexao_id
     where i.conexao_id is not null
       and (c.id is null or c.provedor <> 'chatwoot' or c.organizacao_id is distinct from i.organizacao_id);
    if v_violacoes > 0 then
        raise exception 'PRE-008: % linha(s) de chatwoot_inboxes apontam para conexao de outra organizacao ou provedor; quarentena manual antes desta migration', v_violacoes;
    end if;
end;
$$;

create or replace function public.fn_valida_conexao_do_chatwoot_inbox()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_organizacao_id uuid;
    v_provedor text;
begin
    if new.conexao_id is null then
        return new;
    end if;
    select c.organizacao_id, c.provedor into v_organizacao_id, v_provedor
      from public.conexoes_integracao c
     where c.id = new.conexao_id;
    if v_provedor is distinct from 'chatwoot' or v_organizacao_id is distinct from new.organizacao_id then
        raise exception 'Inbox Chatwoot so mapeia para conexao Chatwoot da mesma organizacao.' using errcode = '23503';
    end if;
    return new;
end;
$$;

revoke all on function public.fn_valida_conexao_do_chatwoot_inbox() from public, anon, authenticated;

create trigger trg_valida_conexao_do_chatwoot_inbox
    before insert or update of conexao_id, organizacao_id on public.chatwoot_inboxes
    for each row execute function public.fn_valida_conexao_do_chatwoot_inbox();

-- ---------------------------------------------------------------------------
-- Eventos de auditoria (projeção SQL de `auditEventCatalog.ts`) da
-- (re)ativação pela API autorizada, agora o único caminho para ela. Nenhum
-- código os emite antes da fatia de auditoria do PRE-008.
-- ---------------------------------------------------------------------------
insert into public.catalogo_eventos_auditoria
    (nome, versao, produtor, severidade, ator_esperado, retention_dias, alerta_regra, descricao)
values
    ('integration.connection_configured', 1, 'integrations', 'info', 'user', 1825, null,
     'Credenciais de integração gravadas pela API; a conexão volta a pendente.'),
    ('integration.connection_authorized', 1, 'integrations', 'info', 'user', 1825, null,
     'Autorização OAuth concluída; a conexão passa a conectado.')
on conflict (nome) do nothing;

-- ---------------------------------------------------------------------------
-- Autoverificação: aborta a transação se sobrar escrita do navegador (tabela
-- ou coluna) em qualquer das quatro tabelas, se o navegador ler credencial, se
-- a leitura por membership ou o DML do servidor sumirem, se sobrar policy que
-- não seja de leitura por `authenticated` sem `auth.uid()`, se um gatilho novo
-- faltar ou estiver desligado, ou se o navegador executar qualquer função que
-- cite estas tabelas.
-- ---------------------------------------------------------------------------
do $$
declare
    v_papel text;
    v_tabela text;
    v_coluna text;
    v_policy text;
    v_funcao text;
    v_gatilho text;
begin
    foreach v_tabela in array array['public.conexoes_integracao', 'public.chatwoot_inboxes',
                                    'public.credenciais_integracao', 'public.integracoes_bling'] loop
        foreach v_papel in array array['authenticated', 'anon'] loop
            if has_table_privilege(v_papel, v_tabela, 'INSERT')
               or has_table_privilege(v_papel, v_tabela, 'UPDATE')
               or has_table_privilege(v_papel, v_tabela, 'DELETE')
               or has_table_privilege(v_papel, v_tabela, 'TRUNCATE') then
                raise exception 'PRE-008: % ainda escreve em %', v_papel, v_tabela;
            end if;
            select a.attname into v_coluna
              from pg_attribute a
             where a.attrelid = v_tabela::regclass and a.attnum > 0 and not a.attisdropped
               and (has_column_privilege(v_papel, a.attrelid, a.attname, 'INSERT')
                    or has_column_privilege(v_papel, a.attrelid, a.attname, 'UPDATE'))
             limit 1;
            if v_coluna is not null then
                raise exception 'PRE-008: % ainda escreve em %.%', v_papel, v_tabela, v_coluna;
            end if;
        end loop;
        if not (has_table_privilege('service_role', v_tabela, 'SELECT')
                and has_table_privilege('service_role', v_tabela, 'INSERT')
                and has_table_privilege('service_role', v_tabela, 'UPDATE')
                and has_table_privilege('service_role', v_tabela, 'DELETE'))
           and v_tabela <> 'public.integracoes_bling' then
            raise exception 'PRE-008: service_role perdeu DML em %', v_tabela;
        end if;
    end loop;

    foreach v_papel in array array['authenticated', 'anon'] loop
        if has_table_privilege(v_papel, 'public.credenciais_integracao', 'SELECT')
           or has_table_privilege(v_papel, 'public.integracoes_bling', 'SELECT') then
            raise exception 'PRE-008: % lê credenciais de integração', v_papel;
        end if;
    end loop;
    if not (has_table_privilege('authenticated', 'public.conexoes_integracao', 'SELECT')
            and has_table_privilege('authenticated', 'public.chatwoot_inboxes', 'SELECT')) then
        raise exception 'PRE-008: authenticated perdeu a leitura de conexoes_integracao ou chatwoot_inboxes';
    end if;

    select p.polrelid::regclass::text || '.' || p.polname into v_policy
      from pg_policy p
     where p.polrelid in ('public.conexoes_integracao'::regclass, 'public.chatwoot_inboxes'::regclass,
                          'public.credenciais_integracao'::regclass)
       and (p.polcmd <> 'r'
            or coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~ 'auth\.uid'
            or not (p.polroles = array['authenticated'::regrole]::oid[]))
     limit 1;
    if v_policy is not null then
        raise exception 'PRE-008: policy % não é só leitura por organização', v_policy;
    end if;

    select t.tgname into v_gatilho
      from (values ('public.conexoes_integracao', 'trg_organizacao_da_conexao_imutavel'),
                   ('public.credenciais_integracao', 'trg_organizacao_da_credencial_imutavel'),
                   ('public.chatwoot_inboxes', 'trg_organizacao_do_chatwoot_inbox_imutavel'),
                   ('public.chatwoot_inboxes', 'trg_valida_conexao_do_chatwoot_inbox')) as t(tabela, tgname)
     where not exists (select 1 from pg_trigger g
                        where g.tgrelid = t.tabela::regclass and g.tgname = t.tgname and g.tgenabled = 'O')
     limit 1;
    if v_gatilho is not null then
        raise exception 'PRE-008: gatilho % ausente ou desligado', v_gatilho;
    end if;

    select p.oid::regprocedure::text into v_funcao
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosrc ~ '\m(conexoes_integracao|credenciais_integracao|chatwoot_inboxes|integracoes_bling)\M'
       and (has_function_privilege('authenticated', p.oid, 'execute')
            or has_function_privilege('anon', p.oid, 'execute'))
     limit 1;
    if v_funcao is not null then
        raise exception 'PRE-008: o navegador executa %, que toca as tabelas de integração', v_funcao;
    end if;
end;
$$;

notify pgrst, 'reload schema';
