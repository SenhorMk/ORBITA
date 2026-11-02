# Implantação da migration 82 (PRE-007A) — Staging

Migration `database/82_revogar_dml_direto_financeiro.sql`, **ordem 85** do
ledger. Inventário e provas:
[`docs/security/inventario-escrita-direta-financeira.md`](../security/inventario-escrita-direta-financeira.md).

**Nada aqui foi executado em banco remoto.** Os resultados citados vêm do
laboratório descartável (Windows, Docker, cadeia canônica 01–82). Toda
aplicação remota exige autorização explícita da proprietária, à parte.

## 1. Ordem: expand/contract em duas fatias

A Vercel publica a `main` no Staging automaticamente. Por isso nenhum merge
pode publicar código que dependa de SQL ainda não aplicado. O PRE-007A vai em
duas fatias:

| Fatia | Branch | Leva | Muda o comportamento da aplicação? |
|---|---|---|---|
| 1 — banco | `fix/pre-007a-banco` | a 82, ledger, catálogo, pgTAP, detectores, este runbook e o inventário | não: nenhuma linha de `src/` muda fora de testes |
| 2 — código | `fix/pre-007a-codigo` (empilhada sobre a 1) | as correções de título passam a usar as RPCs auditadas; o cancelamento sonda a RPC antes do Bling | sim |

Estados do banco, pelo número de migrations registradas (as ordens do ledger):

| Estado | Cadeia | Como se chega |
|---|---|---|
| S77 | 01–74 | hoje, no Orbita_Staging |
| S83 | 01–80 | Marco A |
| S84 | 01–81 | Marco B |
| S85 | 01–82 | aplicar a 82 |

O ledger vai de 1 a 85 sem lacunas (`npm run db:drift:check`: 86 arquivos,
85 registrados). A ferramenta só aplica prefixos do ledger: 77 → 83 → 84 → 85.

### 1.1 Ordem exata e GO/NO-GO

| Passo | Ação | GO só se… | NO-GO |
|---|---|---|---|
| 1 | Marco A (75–80) | as condições do [`pre-006d-runbook.md`](pre-006d-runbook.md), seções 2–3 | idem |
| 2 | Marco B (81) | as condições do [`pre-006d-runbook.md`](pre-006d-runbook.md), seção 4 | idem |
| 3 | Mesclar a fatia 1 | o status remoto mostra **84** registros, sem lacuna e com checksums iguais ao ledger; o `verify` e o `test:db` do PR estão verdes; `git diff origin/main...fix/pre-007a-banco -- src ':!*.test.ts' ':!*.test.tsx' ':!src/lib/__testkit__'` está vazio | qualquer item falso; em particular, não mesclar com 75–81 pendentes |
| 4 | Aplicar a 82 pela `main` (seção 2) | `GET /api/liveness` responde o commit do merge da fatia 1; o status mostra só a 82 pendente e a prévia, uma linha; há backup recente (seção 2.1 do runbook do PRE-006D); a janela não tem DDL; a proprietária autorizou | status com outra pendência, checksum divergente, ou sem autorização |
| 5 | Validar (seção 3) | as duas consultas dão o esperado; a fumaça da fatia 1 passa | qualquer divergência: parar e ver a seção 4 |
| 6 | Mesclar a fatia 2 | o passo 5 passou no Staging; o status mostra **85/85**; o `verify` do PR está verde | 82 ausente ou não validada |

### 1.2 Matriz de compatibilidade

Prova por célula, no laboratório com o ledger **cortado** em cada ordem:
- **contrato:** toda `.rpc()`, `.from()` e evento de auditoria do `src/` daquela versão existe no banco, com o privilégio de `service_role`;
- **pgTAP:** os quatro arquivos finais da `main` (`catalog_security` 15, `comandos_de_clientes_e_pedidos` 16, `escrita_direta_comercial` 28, `estado_de_sincronizacao_da_foto_com_bling` 38) e o do PRE-007A (39).

O contrato nunca encontra `integracoes_bling`, em nenhum estado e em nenhuma
versão. É o espelho legado do callback do Bling, gravado em *best effort*
"enquanto a tabela existir"; a ausência não muda nenhum desfecho e é anterior
a este ticket.

| Código \ Banco | S77 | S83 | S84 | S85 |
|---|---|---|---|---|
| `main` (`ce6144b`) | **incompatível, e já é assim hoje**: faltam 5 RPCs, 2 tabelas e 16 eventos das 75–80. Não é efeito deste ticket; o Marco A resolve | **compatível**: contrato completo; `catalog_security`, `comandos` e `foto` verdes. `escrita_direta_comercial` dá 13 falhas porque afirma o estado depois da 81, não por incompatibilidade | **compatível**: contrato completo; os quatro pgTAP da `main` verdes (97) | **compatível**: contrato completo; os quatro pgTAP verdes; PRE-007A 39/39, inclusive 37–38 (os DELETE/UPDATE diretos das correções de título da `main`); `test:db` inteiro verde |
| `main` + fatia 1 | igual à `main` (mesmo código). Inalcançável pela ordem: a fatia 1 só entra no S84 | igual à `main`. Inalcançável pela ordem | **compatível** (passo 3) | **compatível** (passos 4–5) |
| `main` + fatia 2 | inalcançável pela ordem. Se acontecesse: as faltas da `main` mais as duas RPCs do PRE-007A | inalcançável. Faltam as duas RPCs: o cancelamento responde `Unavailable` antes do Bling e a exclusão responde 500 sem apagar | inalcançável. Mesmo comportamento do S83 | **compatível** (passo 6): contrato completo; PRE-007A 39/39; testes de rota da fatia 2 |

**O caminho do runbook:** (`main`, S77) hoje → passo 1 (`main`, S83) → passo 2
(`main`, S84) → passo 3 (fatia 1, S84) → passo 4 (fatia 1, S85) → passo 6
(fatia 2, S85).
- Todas as células depois do ponto de partida são compatíveis.
- A de partida é o estado atual do Staging, anterior a este ticket.

## 2. Aplicação (passo 4: pela `main`, depois do merge da fatia 1)

Pré-verificação: o status mostra só a 82 pendente, e a prévia com
`--ate-arquivo 82_revogar_dml_direto_financeiro.sql` mostra uma linha.

```bash
npm run db:remoto:aplicar -- --url "$SUPABASE_DB_URL" --confirmar --ate-arquivo 82_revogar_dml_direto_financeiro.sql
```

O que a 82 faz:
- revoga INSERT, UPDATE, DELETE e TRUNCATE de `authenticated`, `anon` e PUBLIC nas quatro tabelas financeiras;
- remove pelo nome as policies legadas com `auth.uid()`, só se existirem (na cadeia canônica não existem);
- cria as duas RPCs auditadas, executáveis só por `service_role`. A `main` da fatia 1 ainda não as chama;
- não muda nenhuma linha de dados.

Ela se autoverifica e aborta a transação inteira se:
- sobrar escrita do navegador, por tabela ou por coluna;
- `authenticated` perder SELECT;
- `service_role` perder DML;
- alguma policy das quatro tiver ramo `auth.uid()` ou outro papel.

**Locks**, medidos no laboratório com dois clientes:

| Outra sessão segurando | Resultado da 82 |
|---|---|
| leitura (`ACCESS SHARE`) | aplicou em 32 ms |
| escrita (`ROW EXCLUSIVE`) | aplicou em 12 ms |
| `ACCESS EXCLUSIVE` (DDL, `VACUUM FULL`) | abortou em 5 s com `55P03`, sem efeito |

Os locks vêm de dois pontos:
- o REVOKE não espera nem atrás de `ACCESS EXCLUSIVE`;
- quem espera é o `pg_get_expr` da autoverificação das policies, que pede `ACCESS SHARE`.

Num `55P03`, repetir o mesmo comando numa janela sem DDL.

## 3. Validação (passo 5: antes de mesclar a fatia 2)

```sql
select t, has_table_privilege('authenticated', 'public.' || t, 'SELECT') as le,
          has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || t, 'DELETE') as escreve,
          has_table_privilege('service_role', 'public.' || t, 'INSERT') as servidor_escreve
  from unnest(array['titulos_financeiros','fornecedores','contas_financeiras','categorias_financeiras']) t;
-- Esperado: le = true, escreve = false, servidor_escreve = true nas quatro.

select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as navegador,
       has_function_privilege('service_role', p.oid, 'execute') as servidor
  from pg_proc p
 where p.proname in ('excluir_lancamento_interno_auditado', 'cancelar_despesa_local_auditada');
-- Esperado: navegador = false, servidor = true nas duas.
```

Fumaça com a `main` da fatia 1, dados sintéticos:
1. A tela financeira carrega (lista, resumo, categorias).
2. Sincronizar o financeiro funciona.

Fumaça depois de mesclar a fatia 2:
1. Lançar uma despesa interna e excluí-la. Em `eventos_auditoria_sistema` aparece um `finance.entry_deleted` com o `correlation_id` da requisição.

## 4. Recuperação

**Nunca se concede de novo INSERT, UPDATE, DELETE ou TRUNCATE a `authenticated` ou `anon`** nas quatro tabelas, nem por coluna, nem "temporariamente"; também não se usa `--adotar`. Toda recuperação é conter, corrigir o comando do servidor ou reverter código.

- **Falha durante a 82:** ela volta inteira e nada muda. Leia o SQLSTATE, corrija a causa e repita o mesmo comando.
- **Fluxo legítimo quebrado com 42501 depois da 82:** ele escrevia com o token do usuário. O inventário diz que nenhum escrevia.
  1. Conter: bloquear a ação afetada.
  2. Corrigir: mover a escrita para um comando do servidor com escopo verificado.
  3. Publicar.
- **Fatia 2 publicada sem a 82:** reverter o merge da fatia 2, ou aplicar a 82. Nenhum dado fica parcial: o cancelamento recusa antes do Bling e a exclusão não apaga.
- **RPC auditada com defeito:** a correção é uma migration nova, forward-only. Até lá, reverter a fatia 2 devolve as correções ao caminho anterior, que a 82 não quebra (casos 37–38).
