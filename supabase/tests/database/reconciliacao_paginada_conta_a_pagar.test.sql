-- reconciliacao_paginada_conta_a_pagar.test.sql
-- PRE-002, migration 74: todas as pendências alcançáveis por cursor estável
-- (criação desc, chave desc), com o total, sem repetir nem pular.
--
-- REINTRODUZIR O DEFEITO: ignore o cursor em `listar_pendencias_conta_pagar`:
-- 1, 2 e 4 falham. Compare o cursor só por `created_at` (sem a chave como
-- desempate): 1-2 falham, porque o par empatado na borda da página é pulado.

begin;

create table public.titulos_financeiros (
    id uuid primary key default gen_random_uuid(),
    organizacao_id uuid not null,
    bling_id bigint,
    tipo text not null default 'pagar',
    situacao text not null default 'aberto',
    situacao_bling smallint,
    valor numeric(10, 2),
    descricao text,
    data_pagamento date,
    unique (organizacao_id, bling_id)
);

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/21_convites_papeis_capacidades.sql
\ir ../../../database/73_tentativas_de_conta_a_pagar.sql
\ir ../../../database/74_reconciliacao_de_conta_a_pagar.sql

insert into public.organizacoes (id, nome, slug)
values ('74500000-0000-4000-8000-000000000001', 'Org T74 P', 'org-t74-p'),
       ('74500000-0000-4000-8000-000000000002', 'Org T74 Q', 'org-t74-q');

select plan(6);

-- 520 pendências; de duas em duas no mesmo instante, para o desempate valer.
insert into public.tentativas_conta_pagar
    (organizacao_id, chave, digest, valor, data_vencimento, data_emissao, estado, motivo, created_at)
select '74500000-0000-4000-8000-000000000001', ('74600000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       lpad(to_hex(n), 64, '0'), 10, '2026-10-20', '2026-10-09', 'indeterminada', 'sem_resposta',
       timestamptz '2026-01-01 00:00:00+00' + (n / 2) * interval '1 second'
from generate_series(1, 520) n;

create temp table paginas (pagina integer, chave uuid, criada timestamptz, total bigint);

-- Página a página pelo cursor; entre a 1ª e a 2ª nasce uma pendência mais nova.
do $$
declare
    v_criada timestamptz;
    v_chave uuid;
    v_pagina integer := 0;
    v_linhas integer;
begin
    loop
        v_pagina := v_pagina + 1;
        insert into paginas
        select v_pagina, l.chave, l.created_at, l.total
          from public.listar_pendencias_conta_pagar('74500000-0000-4000-8000-000000000001', 100, v_criada, v_chave) l;
        get diagnostics v_linhas = row_count;
        exit when v_linhas < 100 or v_pagina >= 10;
        select p.criada, p.chave into v_criada, v_chave
          from paginas p where p.pagina = v_pagina order by p.criada, p.chave limit 1;
        if v_pagina = 1 then
            insert into public.tentativas_conta_pagar
                (organizacao_id, chave, digest, valor, data_vencimento, data_emissao, estado, motivo, created_at)
            values ('74500000-0000-4000-8000-000000000001', '74600000-0000-4000-8000-999999999999', repeat('e', 64),
                    10, '2026-10-20', '2026-10-09', 'indeterminada', 'sem_resposta', timestamptz '2026-06-01 00:00:00+00');
        end if;
    end loop;
end $$;

select is((select count(*)::int || '/' || count(distinct chave) || '/' || max(pagina) from paginas), '520/520/6',
          '1. 520 pendências em 6 páginas, nenhuma repetida');
select ok(not exists (
    select 1 from public.tentativas_conta_pagar t
     where t.organizacao_id = '74500000-0000-4000-8000-000000000001'
       and t.chave <> '74600000-0000-4000-8000-999999999999'
       and not exists (select 1 from paginas p where p.chave = t.chave)),
    '2. nenhuma pendência anterior ao cursor é pulada');
select is((select string_agg(distinct total::text, ',') from paginas where pagina = 1) || '>'
          || (select string_agg(distinct total::text, ',') from paginas where pagina = 6), '520>521',
          '3. o total acompanha a pendência que nasceu entre as páginas');
select ok(not exists (select 1 from paginas where chave = '74600000-0000-4000-8000-999999999999'),
          '4. a pendência nova não entra atrás do cursor: aparece ao recomeçar');
select is((select count(*)::int from public.listar_pendencias_conta_pagar('74500000-0000-4000-8000-000000000002', 100,
              (select max(criada) from paginas), (select chave from paginas order by chave desc limit 1))), 0,
          '5. o cursor de uma organização não lê a outra');
select is((select count(*)::int from public.listar_pendencias_conta_pagar('74500000-0000-4000-8000-000000000001', 1000)), 500,
          '6. o limite por página é limitado no banco');

select * from finish();
rollback;
