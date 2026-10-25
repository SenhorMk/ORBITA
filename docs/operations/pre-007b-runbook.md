# Implantação da migration 83 (PRE-007B) — Staging

Migration `database/83_revogar_dml_direto_fiscal.sql`, **ordem 86** do
ledger. Inventário e provas:
[`docs/security/inventario-escrita-direta-fiscal.md`](../security/inventario-escrita-direta-fiscal.md).

**Nada aqui foi executado em banco remoto.** Os resultados citados vêm do
laboratório descartável (Windows, Docker, cadeia canônica 01–83). Toda
aplicação remota exige autorização explícita da proprietária, à parte.

## 1. Ordem: expand/contract em duas fatias

A Vercel publica a `main` no Staging automaticamente. Por isso nenhum merge
pode publicar código que dependa de SQL ainda não aplicado.

| Fatia | Branch | Leva | Muda o comportamento da aplicação? |
|---|---|---|---|
| 1 — banco | `fix/pre-007b-banco` (empilhada sobre `fix/pre-007a-banco`, PR #118) | a 83, ledger, catálogo, pgTAP, detectores, este runbook e o inventário | não: fora de testes, `src/` só ganha a linha `fiscal.document_issued` no catálogo de eventos, que nada emite |
| 2 — código | `fix/pre-007b-codigo` (empilhada sobre a 1) | o registro da NF-e emitida passa a usar a RPC auditada; a emissão sonda a RPC antes do Bling | sim |

Estados do banco, pelo número de migrations registradas (as ordens do ledger):

| Estado | Cadeia | Como se chega |
|---|---|---|
| S84 | 01–81 | Marco B |
| S85 | 01–82 | aplicar a 82 (PRE-007A) |
| S86 | 01–83 | aplicar a 83 |

O ledger vai de 1 a 86 sem lacunas (`npm run db:drift:check`: 87 arquivos,
86 registrados). A ferramenta só aplica prefixos do ledger: a 83 só entra depois da 82.

### 1.1 Ordem exata e GO/NO-GO

Os passos 1–6 do [`pre-007a-runbook.md`](pre-007a-runbook.md) vêm antes:
Marco A → Marco B → mesclar o #118 → aplicar a 82 → validar → mesclar o #119.

| Passo | Ação | GO só se… | NO-GO |
|---|---|---|---|
| 7 | Atualizar a fatia 1 sobre a `main` e mesclar | o status remoto mostra **85** registros, sem lacuna e com checksums iguais ao ledger; o `verify` e o `test:db` do PR estão verdes; `git diff origin/main...fix/pre-007b-banco -- src ':!*.test.ts' ':!*.test.tsx' ':!src/lib/__testkit__'` mostra só a linha do catálogo de eventos | qualquer item falso; em particular, não mesclar com a 82 pendente |
| 8 | Aplicar a 83 pela `main` (seção 2) | `GET /api/liveness` responde o commit do merge da fatia 1; o status mostra só a 83 pendente e a prévia, uma linha; há backup recente (seção 2.1 do runbook do PRE-006D); a janela não tem DDL; a proprietária autorizou | status com outra pendência, checksum divergente, ou sem autorização |
| 9 | Validar (seção 3) | as duas consultas dão o esperado; a fumaça da fatia 1 passa | qualquer divergência: parar e ver a seção 4 |
| 10 | Mesclar a fatia 2 | o passo 9 passou no Staging; o status mostra **86/86**; o `verify` do PR está verde | 83 ausente ou não validada |

### 1.2 Matriz de compatibilidade

Prova por célula, no laboratório com o ledger **cortado** em cada ordem:
- **contrato:** toda `.rpc()` e `.from()` do `src/` daquela versão existe no banco, com o privilégio de `service_role`, e todo evento do catálogo TypeScript existe em `catalogo_eventos_auditoria`;
- **pgTAP:** os arquivos finais da versão.

Versões de código:
- `main` pós-PRE-007A: `fix/pre-007a-codigo` (#118 + #119);
- fatia 1: a `main` pós-PRE-007A mais a fatia 1;
- fatia 2: a fatia 1 mais a fatia 2.

O contrato nunca encontra `integracoes_bling`, em nenhum estado e em nenhuma
versão. É o espelho legado do callback do Bling, anterior a este ticket (ver o
runbook do PRE-007A).

| Código \ Banco | S84 | S85 | S86 |
|---|---|---|---|
| `main` pós-PRE-007A | inalcançável pela ordem do PRE-007A: faltam as duas RPCs dele | **compatível**: contrato completo; os cinco pgTAP finais da `main` verdes. O do PRE-007B falha em 16 casos e para no 29, onde a RPC ainda não existe: ele afirma o estado depois da 83, e isso não é incompatibilidade | **compatível**: contrato completo; os seis pgTAP finais verdes (172) |
| fatia 1 | inalcançável pela ordem. Contrato completo, salvo o evento `fiscal.document_issued`, que só existe no catálogo e que nenhum código emite | **compatível** (passo 7): o mesmo, e o evento continua sem emissor | **compatível** (passos 8–9): contrato completo; 172/172; `test:db` inteiro verde (2 ciclos e concorrência) |
| fatia 2 | inalcançável. Falta a RPC: a emissão responde 503 antes do Bling | inalcançável. Mesmo comportamento do S84 | **compatível** (passo 10): contrato completo; 172/172; testes de rota da fatia 2 |

**O caminho do runbook:** (`main` pós-PRE-007A, S85) → passo 7 (fatia 1, S85)
→ passo 8 (fatia 1, S86) → passo 10 (fatia 2, S86). Todas as células do caminho são compatíveis.

## 2. Aplicação (passo 8: pela `main`, depois do merge da fatia 1)

Pré-verificação: o status mostra só a 83 pendente, e a prévia com
`--ate-arquivo 83_revogar_dml_direto_fiscal.sql` mostra uma linha.

```bash
npm run db:remoto:aplicar -- --url "$SUPABASE_DB_URL" --confirmar --ate-arquivo 83_revogar_dml_direto_fiscal.sql
```

O que a 83 faz:
- revoga INSERT, UPDATE, DELETE e TRUNCATE de `authenticated`, `anon` e PUBLIC em `documentos_fiscais`;
- remove pelo nome as policies legadas com `auth.uid()`, só se existirem (na cadeia canônica não existem);
- registra o evento `fiscal.document_issued` em `catalogo_eventos_auditoria`;
- cria a RPC auditada `registrar_documento_fiscal_emitido`, executável só por `service_role`. A fatia 1 ainda não a chama;
- não muda nenhuma linha de `documentos_fiscais`.

Ela se autoverifica e aborta a transação inteira se:
- sobrar escrita do navegador, por tabela ou por coluna;
- `authenticated` perder SELECT;
- `service_role` perder DML;
- alguma policy tiver ramo `auth.uid()` ou outro papel;
- o navegador puder executar a RPC.

**Locks**, medidos no laboratório com dois clientes, a 83 aplicada dentro de uma transação desfeita:

| Outra sessão segurando `documentos_fiscais` | Resultado da 83 |
|---|---|
| leitura (`ACCESS SHARE`) | aplicou em 6 ms |
| escrita (`ROW EXCLUSIVE`) | aplicou em 6 ms |
| `ACCESS EXCLUSIVE` (DDL, `VACUUM FULL`) | abortou em 5 s com `55P03`, sem efeito |

Num `55P03`, repetir o mesmo comando numa janela sem DDL.

## 3. Validação (passo 9: antes de mesclar a fatia 2)

```sql
select has_table_privilege('authenticated', 'public.documentos_fiscais', 'SELECT') as le,
       has_table_privilege('authenticated', 'public.documentos_fiscais', 'INSERT')
    or has_table_privilege('authenticated', 'public.documentos_fiscais', 'UPDATE')
    or has_table_privilege('authenticated', 'public.documentos_fiscais', 'DELETE') as escreve,
       has_table_privilege('service_role', 'public.documentos_fiscais', 'INSERT') as servidor_escreve;
-- Esperado: le = true, escreve = false, servidor_escreve = true.

select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as navegador,
       has_function_privilege('service_role', p.oid, 'execute') as servidor,
       exists (select 1 from public.catalogo_eventos_auditoria where nome = 'fiscal.document_issued') as evento
  from pg_proc p
 where p.proname = 'registrar_documento_fiscal_emitido';
-- Esperado: uma linha, navegador = false, servidor = true, evento = true.
```

Fumaça com a fatia 1, dados sintéticos:
1. A lista de pedidos carrega com a NF-e dos pedidos faturados (embed `nfe:documentos_fiscais`).

Fumaça depois de mesclar a fatia 2. Emitir NF-e real exige o Bling e a aprovação da proprietária:
1. Faturar um pedido de teste. Em `eventos_auditoria_sistema` aparece um `fiscal.document_issued` com o `correlation_id` da requisição e sem a chave de acesso.

## 4. Recuperação

**Nunca se concede de novo INSERT, UPDATE, DELETE ou TRUNCATE a `authenticated` ou `anon`** em `documentos_fiscais`, nem por coluna, nem "temporariamente"; também não se usa `--adotar`. Toda recuperação é conter, corrigir o comando do servidor ou reverter código.

- **Falha durante a 83:** ela volta inteira e nada muda. Leia o SQLSTATE, corrija a causa e repita o mesmo comando.
- **Fluxo legítimo quebrado com 42501 depois da 83:** ele escrevia com o token do usuário. O inventário diz que nenhum escrevia.
  1. Conter: bloquear a ação afetada.
  2. Corrigir: mover a escrita para um comando do servidor com escopo verificado.
  3. Publicar.
- **Fatia 2 publicada sem a 83:** reverter o merge da fatia 2, ou aplicar a 83. A sonda faz a emissão responder 503 antes do Bling: nenhuma nota é emitida e nada local muda.
- **RPC auditada com defeito:** a correção é uma migration nova, forward-only. Até lá, reverter a fatia 2 devolve o registro ao upsert direto com `service_role`, que a 83 não quebra (pgTAP 33).
- **Nota emitida no Bling e não registrada** (500 `compensation_required`): reconciliar pelo número e pela chave da resposta. Não repetir o `POST /api/nfe` às cegas: a consulta local não acha a nota e o Bling seria chamado de novo.
