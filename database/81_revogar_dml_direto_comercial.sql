-- 81_revogar_dml_direto_comercial.sql
-- Forward-only. PRE-006D: o navegador deixa de poder escrever direto nas seis
-- tabelas comerciais.
--
-- ESTADO ANTERIOR (medido no laboratório com a cadeia canônica 01-80):
--   `authenticated` tem SELECT, INSERT, UPDATE e DELETE efetivos em produtos,
--   categorias, clientes, pedidos, itens_pedido e movimentacao_estoque, por
--   grant explícito (migration 23). `anon` e PUBLIC não têm nada. As policies
--   `*_org_{select,insert,update,delete}` (só membership) são o único limite:
--   qualquer membro, inclusive `member`, insere, altera e apaga linhas da
--   própria organização pelo PostgREST com o próprio token — estoque, livro
--   de movimentação, pedidos e clientes — sem passar pelas APIs, pela
--   capacidade nem pela auditoria.
--
-- O QUE MUDA: INSERT, UPDATE, DELETE e TRUNCATE saem de `authenticated`,
-- `anon` e PUBLIC nas seis tabelas. Revogar o privilégio da tabela também
-- revoga os de coluna correspondentes, então nenhum `GRANT UPDATE (coluna)`
-- sobrevive.
--
-- O QUE NÃO MUDA:
--   - SELECT de `authenticated`: as telas leem `itens_pedido` (com
--     `produtos` embutido), `clientes` e `produtos` direto, sob RLS.
--   - `service_role`: todas as mutações legítimas (rotas, jobs, webhook) e as
--     RPCs `security definer` executáveis só por ela.
--   - RLS e policies, inclusive as de escrita: sem grant elas não são
--     alcançáveis, e ficam como segunda barreira por organização se um grant
--     voltar por engano.
--   - Gatilhos: rodam como quem dispara (`service_role` nos fluxos legítimos)
--     ou como definer.
--   - Nenhuma RPC muda: nenhuma função que escreve nas seis tabelas é
--     executável por `anon`/`authenticated` (medido; o teste final cobra).
--
-- RECUPERAÇÃO: não se restaura grant amplo. Se um fluxo legítimo quebrar,
-- ele dependia do token do usuário — corrige-se o comando no servidor e, até
-- lá, bloqueia-se a ação afetada (ver docs/operations/pre-006d-runbook.md).

-- Não esperar indefinidamente atrás de transação longa: falha rápido e se
-- repete numa janela calma.
set local lock_timeout = '5s';

revoke insert, update, delete, truncate
    on public.produtos,
       public.categorias,
       public.clientes,
       public.pedidos,
       public.itens_pedido,
       public.movimentacao_estoque
  from authenticated, anon, public;

-- Autoverificação: aborta a transação se sobrar qualquer capacidade de
-- escrita do navegador (tabela ou coluna) ou se a leitura sumir.
do $$
declare
    v_tabela text;
    v_papel text;
    v_coluna text;
begin
    foreach v_tabela in array array['produtos', 'categorias', 'clientes', 'pedidos', 'itens_pedido', 'movimentacao_estoque'] loop
        foreach v_papel in array array['authenticated', 'anon'] loop
            if has_table_privilege(v_papel, 'public.' || v_tabela, 'INSERT')
               or has_table_privilege(v_papel, 'public.' || v_tabela, 'UPDATE')
               or has_table_privilege(v_papel, 'public.' || v_tabela, 'DELETE')
               or has_table_privilege(v_papel, 'public.' || v_tabela, 'TRUNCATE') then
                raise exception 'PRE-006D: % ainda escreve em public.%', v_papel, v_tabela;
            end if;
            select a.attname into v_coluna
              from pg_attribute a
             where a.attrelid = ('public.' || v_tabela)::regclass and a.attnum > 0 and not a.attisdropped
               and (has_column_privilege(v_papel, a.attrelid, a.attname, 'INSERT')
                    or has_column_privilege(v_papel, a.attrelid, a.attname, 'UPDATE'))
             limit 1;
            if v_coluna is not null then
                raise exception 'PRE-006D: % ainda escreve em public.%.%', v_papel, v_tabela, v_coluna;
            end if;
        end loop;
        if not has_table_privilege('authenticated', 'public.' || v_tabela, 'SELECT') then
            raise exception 'PRE-006D: authenticated perdeu a leitura de public.%', v_tabela;
        end if;
        if not (has_table_privilege('service_role', 'public.' || v_tabela, 'SELECT')
                and has_table_privilege('service_role', 'public.' || v_tabela, 'INSERT')
                and has_table_privilege('service_role', 'public.' || v_tabela, 'UPDATE')
                and has_table_privilege('service_role', 'public.' || v_tabela, 'DELETE')) then
            raise exception 'PRE-006D: service_role perdeu DML em public.%', v_tabela;
        end if;
    end loop;
end;
$$;

-- O PostgREST recarrega o cache de esquema (no-op sem ouvinte).
notify pgrst, 'reload schema';
