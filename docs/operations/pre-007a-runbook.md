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
| 1 — banco | `fix/pre-007a-banco` | a 82, ledger, catálogo, pgTAP, detectores, este runbook e o inventário | não |
| 2 — código | `fix/pre-007a-codigo` (empilhada sobre a 1) | as correções de título passam a usar as RPCs auditadas; o cancelamento sonda a RPC antes do Bling | sim |

**Ordem obrigatória:**
1. Marco A (75–80) e Marco B (81), conforme [`pre-006d-runbook.md`](pre-006d-runbook.md).
2. Mesclar a fatia 1. A `main` publicada continua igual: nenhum código novo.
3. Aplicar a 82 **pela `main`** (seção 2) e validar (seção 3).
4. Só então mesclar a fatia 2.

**Compatibilidade por fatia**, provada no laboratório:

| Código publicado \ Banco | sem a 82 | com a 82 |
|---|---|---|
| `main` atual / fatia 1 (mesmo código) | compatível (estado de hoje) | compatível: o servidor grava com `service_role`, que mantém o DML. O `test:db` inteiro passa com a 82, e os casos 37–38 do pgTAP repetem os DELETE/UPDATE diretos das correções de título |
| fatia 2 | **não publicar**. Se acontecer por engano: o cancelamento sonda a RPC e responde `Unavailable` (503) **antes** de ir ao Bling; a exclusão interna responde 500 sem apagar. Nada fica parcial | compatível |

## 2. Aplicação (pela `main`, depois do merge da fatia 1)

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

## 3. Validação (antes de mesclar a fatia 2)

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

**Não se restaura grant amplo de escrita**, nem se usa `--adotar`.

- **Falha durante a 82:** ela volta inteira e nada muda. Leia o SQLSTATE, corrija a causa e repita o mesmo comando.
- **Fluxo legítimo quebrado com 42501 depois da 82:** ele escrevia com o token do usuário. O inventário diz que nenhum escrevia.
  1. Conter: bloquear a ação afetada.
  2. Corrigir: mover a escrita para um comando do servidor com escopo verificado.
  3. Publicar.
- **Fatia 2 publicada sem a 82:** reverter o merge da fatia 2, ou aplicar a 82. Nenhum dado fica parcial: o cancelamento recusa antes do Bling e a exclusão não apaga.
- **RPC auditada com defeito:** a correção é uma migration nova, forward-only. Até lá, reverter a fatia 2 devolve as correções ao caminho anterior, que a 82 não quebra (casos 37–38).
