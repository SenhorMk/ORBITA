# PRE-006D — implantação e recuperação da revogação do DML comercial

Migration `database/81_revogar_dml_direto_comercial.sql`. Este documento é o
plano; **nada aqui foi executado em banco remoto**. Tudo o que tem resultado
abaixo foi medido no laboratório descartável (`npm run test:db` e ensaios do
PRE-006D), Windows local, Docker, sobre a cadeia canônica completa (ledger com
84 migrations).

## 1. Estado esperado antes

- Banco alvo com as migrations **01–80** aplicadas e registradas em
  `public.migracoes_aplicadas`, checksums iguais ao ledger.
  - Merge na `main` não aplica SQL ([database/README.md](../../database/README.md)).
  - As migrations 75–80 podem não estar no remoto. **Não verificado nesta
    entrega:** não há credencial do banco remoto nesta sessão, e a verificação
    é da proprietária (seção 3).
- Aplicação publicada da `main` em ou depois de `9e4e3ca` (PRE-006B e PRE-006C).
  Ela não faz DML do navegador nas seis tabelas: só lê `itens_pedido`
  (`page.tsx`) e `clientes`/`produtos` (`ManualOrderModal`).
- `authenticated` com SELECT, INSERT, UPDATE e DELETE nas seis tabelas (grant
  da migration 23).
  - Medido no laboratório: `anon` sem nada, PUBLIC sem ACL, 24 policies
    `*_org_*` só de membership e RLS ligada.

## 2. Ordem

1. As pendentes de 75 a 80, se houver, na ordem do ledger. A 81 não entra antes
   delas: ela supõe as funções da 80 (`registrar_cliente_do_sac`,
   `alinhar_estoque_ao_saldo_do_bling`) e as rotas que as usam.
2. A **81** sozinha, numa janela calma.

`npm run db:remoto:aplicar -- --url <conexão> --confirmar` aplica cada
migration na sua transação e registra o checksum. Rodar primeiro só até a 80,
validar, e então a 81.

## 3. Pré-verificação (somente leitura)

```bash
npm run db:remoto:status -- --url "<conexão>"
```

Lista as pendentes e as divergentes, sem escrever. O código não cria a tabela
de registro (`estadoDasMigracoes`). Esperado antes da 81: nenhuma divergente; a
única pendente é a 81.

Depois, no SQL editor, com um papel de leitura:

```sql
-- Privilégios efetivos hoje (esperado: authenticated com S/I/U/D; anon nada).
select t, r,
       has_table_privilege(r, 'public.' || t, 'SELECT') s,
       has_table_privilege(r, 'public.' || t, 'INSERT') i,
       has_table_privilege(r, 'public.' || t, 'UPDATE') u,
       has_table_privilege(r, 'public.' || t, 'DELETE') d
  from unnest(array['produtos','categorias','clientes','pedidos','itens_pedido','movimentacao_estoque']) t
 cross join unnest(array['anon','authenticated','service_role']) r order by 1, 2;

-- As funções da 80 existem e só service_role as executa.
select p.oid::regprocedure, has_function_privilege('authenticated', p.oid, 'EXECUTE') as navegador,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as servidor
  from pg_proc p
 where p.proname in ('registrar_cliente_do_sac', 'alinhar_estoque_ao_saldo_do_bling');

-- Transações longas que possam segurar catálogo.
select pid, state, now() - xact_start as idade, left(query, 80)
  from pg_stat_activity where xact_start < now() - interval '1 minute' order by idade desc;
```

## 4. SQL

O arquivo inteiro é a `database/81_revogar_dml_direto_comercial.sql`:

```sql
set local lock_timeout = '5s';
revoke insert, update, delete, truncate
    on public.produtos, public.categorias, public.clientes,
       public.pedidos, public.itens_pedido, public.movimentacao_estoque
  from authenticated, anon, public;
-- DO $$ … $$: autoverificação — aborta se authenticated/anon ainda escreverem
-- (tabela ou coluna), se authenticated perder SELECT ou service_role perder DML.
notify pgrst, 'reload schema';
```

## 5. Locks, tempo e impacto (medidos no laboratório)

- **Locks:** com a revogação aberta numa transação, o `pg_locks` mostrou só os
  locks da própria transação (`transactionid` e `virtualxid`). Não houve lock
  de tabela.
  - Uma leitura e uma escrita do servidor em `produtos` passaram em 6 ms e
    3 ms com a revogação aberta.
  - Atrás de um `LOCK ... ACCESS EXCLUSIVE` de outra sessão, a revogação não
    esperou (1 ms).
  - O `lock_timeout` de 5 s cobre o caso raro de outra DDL concorrente no
    mesmo catálogo.
- **Tempo:** a migration altera o ACL de seis linhas de `pg_class` e roda a
  autoverificação. No laboratório, a aplicação inteira da 81 é instantânea
  diante do resto da cadeia. Não depende do volume de dados.
- **Impacto:** nenhuma linha de dados muda.
  - Requisições em voo do servidor (`service_role`) não são afetadas.
  - Uma escrita direta do navegador passa a receber `42501 permission denied`.
    Hoje nenhum código do produto faz isso (`escritaDiretaComercial.test.ts`).

## 6. Pós-verificação

```sql
-- Esperado: authenticated só SELECT; anon nada; service_role S/I/U/D.
-- (mesma consulta da seção 3)

-- Esperado: 0 linhas.
select a.attrelid::regclass, a.attname, r
  from pg_attribute a
 cross join unnest(array['anon','authenticated']) r
 where a.attrelid in ('public.produtos'::regclass, 'public.categorias'::regclass, 'public.clientes'::regclass,
                      'public.pedidos'::regclass, 'public.itens_pedido'::regclass, 'public.movimentacao_estoque'::regclass)
   and a.attnum > 0 and not a.attisdropped
   and (has_column_privilege(r, a.attrelid, a.attname, 'INSERT') or has_column_privilege(r, a.attrelid, a.attname, 'UPDATE'));
```

Fumaça na aplicação publicada, com uma organização sintética:
1. Listar pedidos e abrir um (lê `itens_pedido` com o produto embutido).
2. Abrir "Nova venda" (lê clientes e produtos).
3. Editar um produto sem mexer no saldo.
4. Sincronizar categorias.
5. Cancelar um pedido de teste.
6. Sincronizar o SAC.

Conferir na auditoria (`/api/auditoria`) os eventos `catalog.*`, `order.*` e
`customer.*` correspondentes.

## 7. Critérios para abortar

- O status mostra divergente, ou a pendente não é só a 81. Parar e reconciliar
  a cadeia antes.
- A migration falha: `lock_timeout` ou a autoverificação. A transação inteira
  volta e nada muda. Repetir numa janela calma; se for a autoverificação,
  investigar o grant que sobrou antes de tentar de novo.
- A pós-verificação mostra qualquer escrita de `authenticated`/`anon`, ou
  `service_role` sem DML. Tratar como incidente (seção 8), sem reabrir grants.

## 8. Recuperação

**Não se restaura grant amplo de escrita.** `grant insert, update, delete … to
authenticated` reabriria exatamente o que a 81 fecha, para todas as
organizações e todos os papéis.

Se um fluxo legítimo quebrar com `42501` depois da 81, é porque ele escrevia
com o token do usuário, e isso é um defeito do fluxo.
1. **Conter:** desabilitar a ação afetada na tela, ou responder 503 na rota,
   com um aviso. Os dados ficam intactos, porque a 81 não muda nenhuma linha.
2. **Corrigir:** mover a escrita para um comando do servidor (rota com escopo
   verificado e `service_role`), com o teste correspondente, como no PRE-006B
   e no PRE-006C.
3. **Rastrear:** registrar o incidente, com a auditoria do período, e publicar
   a correção.

Se, por exceção, uma coluna precisar ser gravável pelo navegador, isso é uma
decisão de produto com uma migration nova, estreita (`grant update (coluna)`),
policy e teste. Nunca um grant de tabela inteira.

## 9. Compatibilidade aplicação × schema

| Aplicação \ Banco | sem a 81 | com a 81 |
|---|---|---|
| `main` ≥ `9e4e3ca` | funciona (estado atual) | funciona: nenhum caminho do navegador escreve; o servidor usa `service_role` (provado em laboratório) |
| entre PRE-006A e `9e4e3ca` | funciona | sem escrita direta do navegador desde o inventário do PRE-006A, mas sem as migrations 79–80 as rotas da 80 falham; **não suportado** |
| anterior ao PRE-006A | funciona | **não verificado** |

Ordem recomendada: aplicar até a 80, publicar a `main` atual e só então a 81.
