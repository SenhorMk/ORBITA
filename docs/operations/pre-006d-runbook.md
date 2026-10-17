# Implantação das migrations 75–81 (PRE-003 a PRE-006D) — Staging

Plano para o projeto Supabase **Orbita_Staging** (referência `etqjqeqqbjrzyyxodntv`).

**Nada aqui foi executado em banco remoto.** Os resultados citados vêm do
laboratório descartável (Windows, Docker, cadeia canônica do ledger), salvo
quando dito "medido no Staging" ou "observado na aplicação publicada".

## 0. Estado conhecido

**Banco** (diagnóstico do revisor, somente leitura):
- `public.migracoes_aplicadas` com 77 registros, todos com checksum igual ao
  ledger de 84 entradas.
- Pendentes, em sequência: `75` a `81` (ordinais 78 a 84 do ledger).
- Duas organizações com dados comerciais.
- Nenhum item de pedido sem produto ou com produto de outra organização.
- `authenticated` ainda com DML comercial.

**Aplicação publicada** (observado em 2026-10-17, páginas públicas, sem login):
- O bundle de `https://staging.orbita.mkautobots.site` referencia um único
  projeto Supabase: `etqjqeqqbjrzyyxodntv`. O servidor usa a mesma variável
  `NEXT_PUBLIC_SUPABASE_URL` para o cliente `service_role` (`src/lib/runtime-config.ts`).
- `GET /api/liveness` responde `commit: fd196f0c460e8133fbc54487f90156ca2c4a61c7`,
  a `main` atual.
- **Consequência:** o código publicado já chama o que as migrations 75–80 criam,
  e o banco ainda não tem. Até o Marco A, falham ou ficam pendentes:
  - arquivamento de produto (`arquivar_produto`);
  - tombstones do Bling;
  - auto-registro do SAC (`registrar_cliente_do_sac`);
  - alinhamento de estoque (`alinhar_estoque_ao_saldo_do_bling`);
  - eventos de auditoria `catalog.*`, `order.*` e `customer.*` novos.

  Os eventos são recusados pelo catálogo; a resposta não muda, mas a trilha
  não grava. O Marco A é o que reconcilia código e banco.
- **Não verificado:** a associação pelo painel da Vercel. A conexão do revisor
  não acessou o projeto. As duas evidências acima são públicas e concretas,
  mas não substituem conferir a variável no painel.

## 1. Ferramenta

`scripts/migracoes-remotas.mjs` (este PR) ganhou um limite exato e uma prévia
somente leitura:

| Opção | Efeito |
|---|---|
| (nenhuma) | estado: aplicadas, pendentes e plano; não executa nada |
| `--previa` | idem, com saída 0; recusa combinar com `--aplicar` ou `--adotar` |
| `--ate-arquivo <nome.sql>` | limita o plano até esse arquivo, inclusive; exige o nome canônico exato (`80_comandos_de_clientes_e_pedidos.sql`) |
| `--ate-ordem <n>` | o mesmo pelo ordinal do ledger (o `80_…` é a ordem 83); as duas opções juntas são recusadas |
| `--aplicar --confirmar` | aplica o plano mostrado, uma migration por transação, cada uma registrada na própria transação |

A ferramenta recusa, antes de tocar no banco:
- limite inexistente, ambíguo, sem valor, numérico no lugar do nome, ou já aplicado;
- registro remoto com checksum diferente do ledger;
- registro que não é prefixo do ledger (lacuna) ou que o ledger não conhece;
- arquivo local diferente do checksum do ledger. Isso é conferido na prévia e de novo antes de cada aplicação.

Na aplicação, se outra execução registrar a mesma migration, ela para sem
reaplicar. As posteriores ao limite não são executadas nem registradas.

`--adotar` agora é recusado em banco que já registra migrations: ele marcaria
as pendentes sem executá-las. **Não usar `--adotar` no Staging.**

A saída mostra só o host do alvo (nunca a URL, que carrega usuário e senha) e,
em falha, só o SQLSTATE e a mensagem principal. Nunca o `DETAIL`, onde o
Postgres põe valores de linha.

O ensaio ponta a ponta no laboratório (Staging simulado com 77 registradas)
confirmou cada etapa:

| Etapa | Resultado |
|---|---|
| Status | 7 pendentes |
| Prévia do Marco A | 6 a aplicar, a 81 "fica de fora", nada escrito |
| Recusas | limite inexistente, número no lugar do nome, `--aplicar` sem `--confirmar`, `--adotar` com registro |
| Marco A | 83 registradas, funções e eventos da 80 presentes, a 81 **não** registrada, `authenticated` ainda insere |
| Marco B | 84 registradas; `authenticated` só lê |

## 2. Antes de qualquer marco

### 2.1 Backup

1. No painel do Supabase (Database → Backups), confirme um backup do dia. Se o
   plano tiver PITR, anote o horário de início da janela.
2. Opcional e recomendado: um dump lógico com a sua credencial, guardado fora
   do repositório e fora de qualquer relatório.

   ```bash
   pg_dump --format=custom --no-owner --file=orbita-staging-antes-75.dump "$SUPABASE_DB_URL"
   ```

   O procedimento de dump e restauração da cadeia canônica é ensaiado por
   `npm run test:backup` (laboratório, ticket 21).

### 2.2 Pré-verificação (somente leitura)

```bash
npm run db:remoto:status -- --url "$SUPABASE_DB_URL"
npm run db:remoto:status -- --url "$SUPABASE_DB_URL" --previa --ate-arquivo 80_comandos_de_clientes_e_pedidos.sql
```

Esperado na prévia:
- `77 aplicada(s), 7 pendente(s)`;
- `aplicar` em seis linhas, das ordens 78 a 83 (`75_…` a `80_…`);
- `fica de fora ordem 84 81_revogar_dml_direto_comercial.sql`.

No SQL editor, com papel de leitura. Cada consulta devolve contagens, nunca
dados pessoais:

```sql
-- A. Nada das 75-81 aplicado fora da ferramenta (esperado: tudo null/false/0).
select to_regclass('public.produtos_excluidos_no_bling')  as tabela_76,
       to_regclass('public.contatos_excluidos_no_bling')  as tabela_77,
       to_regprocedure('public.arquivar_produto(uuid,uuid,uuid)') as funcao_75,
       to_regprocedure('public.registrar_cliente_do_sac(uuid,uuid,text,text,text,text)') as funcao_80,
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'produtos' and column_name = 'situacao') as coluna_75,
       (select count(*) from public.catalogo_eventos_auditoria where nome like 'catalog.product_%' or nome like 'order.%') as eventos_79_80;

-- B. A 75 grava `itens_pedido.produto_nome NOT NULL` a partir do produto (esperado: 0).
select count(*) as itens_sem_produto
  from public.itens_pedido i left join public.produtos p on p.id = i.produto_id
 where p.id is null;
select count(*) as produtos_sem_nome from public.produtos where nome is null;

-- C. Itens apontando produto de outra organização (esperado: 0).
select count(*) from public.itens_pedido i join public.produtos p on p.id = i.produto_id
 where p.organizacao_id is distinct from i.organizacao_id;

-- D. Volume (para estimar a varredura das checagens da 75).
select (select count(*) from public.produtos) as produtos, (select count(*) from public.itens_pedido) as itens,
       (select count(*) from public.clientes) as clientes, (select count(*) from public.pedidos) as pedidos;

-- E. Transações longas (esperado: nenhuma acima de 1 minuto).
select pid, state, now() - xact_start as idade from pg_stat_activity
 where xact_start < now() - interval '1 minute' order by idade desc;
```

**Abortar** se:
- a prévia mostrar algo diferente do esperado;
- A tiver qualquer objeto presente;
- B ou C forem maiores que zero;
- houver transação longa.

## 3. Marco A — migrations 75 a 80

```bash
npm run db:remoto:aplicar -- --url "$SUPABASE_DB_URL" --confirmar --ate-arquivo 80_comandos_de_clientes_e_pedidos.sql
```

Saída esperada: `6 migração(ões) aplicada(s); 1 posterior(es) não tocada(s).`

**Locks:** cada migration roda na sua transação.
- A 75 adiciona colunas e checagens em `produtos` e grava `produto_nome` em
  todos os itens. Toma `ACCESS EXCLUSIVE` em `produtos` e `itens_pedido` pelo
  tempo da varredura, proporcional ao volume da consulta D.
- 76, 77 e 80 criam tabelas e funções.
- A 78 troca as policies de `movimentacao_estoque`.
- A 79 só insere linhas do catálogo.

### Validação do Marco A

```bash
npm run db:remoto:status -- --url "$SUPABASE_DB_URL"
```

Esperado: `83 aplicada(s), 1 pendente(s)`, com a 81 como única pendente.

```sql
-- Funções e eventos presentes; a 81 ainda não (authenticated ainda insere).
select to_regprocedure('public.arquivar_produto(uuid,uuid,uuid)') is not null as f75,
       to_regprocedure('public.registrar_exclusao_de_produto_no_bling(uuid,text,timestamp with time zone)') is not null as f76,
       to_regprocedure('public.registrar_cliente_do_sac(uuid,uuid,text,text,text,text)') is not null as f80_sac,
       to_regprocedure('public.alinhar_estoque_ao_saldo_do_bling(uuid,uuid,uuid,integer,integer)') is not null as f80_estoque,
       has_function_privilege('authenticated', 'public.registrar_cliente_do_sac(uuid,uuid,text,text,text,text)', 'EXECUTE') as navegador_executa_80,
       (select count(*) from public.catalogo_eventos_auditoria
         where nome in ('catalog.product_saved','order.status_changed','customer.sac_contacts_registered')) as eventos,
       has_table_privilege('authenticated', 'public.produtos', 'INSERT') as navegador_ainda_insere;
-- Esperado: f75..f80_estoque = true, navegador_executa_80 = false, eventos = 3, navegador_ainda_insere = true.

-- Itens com o retrato do produto (esperado: 0).
select count(*) from public.itens_pedido where produto_nome is null;
```

Na aplicação publicada (`fd196f0`), com dados sintéticos:
1. Editar um produto e conferir o evento `catalog.product_saved` em `/api/auditoria`.
2. Sincronizar categorias.
3. Arquivar um produto de teste.
4. Cancelar um pedido de teste e conferir `order.status_changed`.
5. Sincronizar o SAC.

Só seguir para o Marco B se tudo isso funcionar.

## 4. Marco B — migration 81

Pré-verificação: o status mostra só a 81 pendente, e a prévia com
`--ate-arquivo 81_revogar_dml_direto_comercial.sql` mostra uma linha.

```bash
npm run db:remoto:aplicar -- --url "$SUPABASE_DB_URL" --confirmar --ate-arquivo 81_revogar_dml_direto_comercial.sql
```

A 81 revoga INSERT, UPDATE, DELETE e TRUNCATE de `authenticated`, `anon` e PUBLIC
nas seis tabelas comerciais.
- Ela se autoverifica: aborta a transação se sobrar escrita do navegador ou se
  a leitura sumir.
- Usa `lock_timeout` de 5 s.
- Não toma lock de tabela: medido no laboratório, leitura e escrita do servidor
  seguem durante a revogação.
- Não muda nenhuma linha de dados.

### Validação do Marco B

```sql
select t, has_table_privilege('authenticated', 'public.' || t, 'SELECT') as le,
          has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || t, 'DELETE') as escreve,
          has_table_privilege('service_role', 'public.' || t, 'INSERT') as servidor_escreve
  from unnest(array['produtos','categorias','clientes','pedidos','itens_pedido','movimentacao_estoque']) t;
-- Esperado: le = true, escreve = false, servidor_escreve = true nas seis.
```

Repetir a fumaça do Marco A. Conferir também:
- a lista de pedidos e o detalhe de um pedido, que leem `itens_pedido` com o produto embutido;
- "Nova venda", que lê clientes e produtos.

## 5. Recuperação

**Não se restaura grant amplo de escrita**, nem se usa `--adotar` para
"destravar" a ferramenta.

- **Falha durante um marco:** a migration que falhou volta inteira, e as
  anteriores continuam aplicadas e registradas. Leia o SQLSTATE, corrija a
  causa e rode o mesmo comando com o mesmo limite; ele retoma da que falhou.
- **Defeito de dados descoberto depois do Marco A:** as migrations são
  forward-only. A correção é uma migration nova, revisada, aplicada com a mesma
  ferramenta. Restaurar o backup (seção 2.1) é a última opção e exige decisão
  da proprietária, porque descarta o que foi gravado depois.
- **Fluxo legítimo quebrado com 42501 depois do Marco B:** ele escrevia com o
  token do usuário.
  1. Conter: bloquear a ação afetada na tela ou responder 503 na rota.
  2. Corrigir: mover a escrita para um comando do servidor com escopo verificado.
  3. Publicar a correção.

  Exceção de produto: um grant estreito por coluna, numa migration nova, com
  policy e teste.

## 6. Compatibilidade aplicação × banco

| Aplicação publicada \ Banco | até a 74 (hoje) | 75–80 (Marco A) | 75–81 (Marco B) |
|---|---|---|---|
| `fd196f0` (`main` atual, observada no Staging) | **incompatível**: funções e eventos das 75–80 ausentes | compatível | compatível |
| anterior ao PRE-006A | compatível | não verificado | não verificado |
