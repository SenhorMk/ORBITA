# Implantação da migration 84 (PRE-008) — Staging

Migration `database/84_proteger_conexoes_de_integracao.sql`, **ordem 87** do
ledger. Inventário dos callers e grants:
`docs/security/inventario-escrita-direta-integracoes.md` (fatia de código,
`fix/pre-008-codigo`).

**Nada aqui foi executado em banco remoto, no Chatwoot ou no Bling.** Os
resultados citados vêm do laboratório descartável (Windows, Docker, cadeia
canônica cortada no ledger). Toda aplicação remota exige autorização explícita
da proprietária, à parte.

## 1. Ordem: expand/contract em três fatias

A Vercel publica a `main` no Staging automaticamente. Por isso nenhum merge
pode publicar código que dependa de SQL ainda não aplicado.

| Fatia | Branch | Base | Leva | Depende de objeto novo no banco? |
|---|---|---|---|---|
| código | `fix/pre-008-codigo` | `main` | conexão desligada sem efeito; Zod no connect do Chatwoot; o inventário | não: só lê `conexoes_integracao.status`, que existe desde a 25 |
| banco | `fix/pre-008-banco` | `fix/pre-007b-banco` (#122) | a 84, ledger, catálogo, pgTAP, detector, este runbook | não muda a aplicação: fora de testes, `src/` só ganha as duas linhas `integration.connection_*` no catálogo de eventos, que nada emite |
| auditoria | `fix/pre-008-auditoria` | a de banco | callback OAuth e rotas de connect gravam `integration.connection_*` | não em tempo de execução (`registrar_evento_auditoria` não consulta o catálogo); o teste de paridade exige a linha SQL da 84 no repositório |

Não existe `fix/pre-008-rpc`: nenhum caller grava com o token do usuário, e
a 84 não cria RPC.

Estados do banco, pelo número de migrations registradas (ordens do ledger):

| Estado | Cadeia | Como se chega |
|---|---|---|
| S77 | 01–74 | hoje, no Orbita_Staging |
| S84 | 01–81 | Marco A e Marco B |
| S85 | 01–82 | PRE-007A |
| S86 | 01–83 | PRE-007B |
| S87 | 01–84 | aplicar a 84 |

As quatro tabelas do PRE-008 são idênticas de S77 a S86 (nenhuma migration de
75 a 83 as toca). O ledger vai de 1 a 87 sem lacunas (`npm run db:drift:check`:
88 arquivos, 87 registrados).

### 1.1 Ordem exata e GO/NO-GO

A fatia de código é independente: pode ser mesclada na `main` a qualquer
momento, antes ou depois dos marcos. Os passos 1–10 dos runbooks do PRE-006D,
PRE-007A e PRE-007B vêm antes dos passos abaixo.

| Passo | Ação | GO só se… | NO-GO |
|---|---|---|---|
| C | Mesclar `fix/pre-008-codigo` | `verify` do PR verde | — |
| 11 | Atualizar a fatia de banco sobre a `main` e mesclar | o status remoto mostra **86** registros, sem lacuna e com checksums iguais ao ledger; `verify` e `test:db` do PR verdes; `git diff origin/main...fix/pre-008-banco -- src ':!*.test.ts' ':!*.test.tsx' ':!src/lib/__testkit__'` mostra só as duas linhas do catálogo de eventos | qualquer item falso; em particular, não mesclar com a 83 pendente |
| 12 | Aplicar a 84 pela `main` (seção 2) | `GET /api/liveness` responde o commit do merge do passo 11; o status mostra só a 84 pendente e a prévia, uma linha; backup recente (seção 2.1 do runbook do PRE-006D); janela sem DDL e sem transação longa nas quatro tabelas (seção 2, locks); a proprietária autorizou | outra pendência, checksum divergente, ou sem autorização |
| 13 | Validar (seção 3) | as consultas dão o esperado; a fumaça passa | qualquer divergência: parar e ver a seção 4 |
| 14 | Mesclar a fatia de auditoria | passo 13 passou; status **87/87**; `verify` do PR verde | 84 ausente ou não validada |

### 1.2 Matriz de compatibilidade

Prova por célula, no laboratório com o ledger **cortado** em cada ordem:
- **contrato:** toda `.rpc()` e `.from()` do `src/` daquela versão existe no banco com o privilégio de `service_role`, e todo evento do catálogo TypeScript existe em `catalogo_eventos_auditoria`;
- **pgTAP:** os arquivos finais da fatia de banco (sete).

Em todos os estados e versões o contrato não encontra `integracoes_bling` para
`service_role`: é o espelho legado do callback, best-effort, anterior a este
ticket (ver o runbook do PRE-007A).

Versões de código: `main` (`ce19a9a`); `main` + código; a fatia de banco
(#122 + 84); a de auditoria (banco + auditoria).

| Código  Banco | S77 | S84 | S86 | S87 |
|---|---|---|---|---|
| `main` e `main` + código | **incompatível, e já é assim hoje**: faltam 5 RPCs, 2 tabelas e 16 eventos das 75–80; o Marco A resolve. A fatia de código não acrescenta falta nenhuma: o contrato dela é idêntico ao da `main` nos quatro estados | **compatível** | **compatível**: os seis pgTAP anteriores verdes (172). O do PRE-008 falha em 24 de 35: ele afirma o estado depois da 84 | **compatível**: os sete pgTAP verdes (207) |
| banco | inalcançável pela ordem | inalcançável. Faltariam `fiscal.document_issued` e os dois `integration.*`, que nada emite | **compatível** (passo 11): faltam só os dois `integration.*`, que nada emite | **compatível** (passos 12–13): contrato completo; 207/207; `test:db` inteiro verde |
| auditoria | inalcançável | inalcançável | inalcançável pela ordem. Se acontecesse, os eventos seriam gravados mesmo assim (a RPC não consulta o catálogo); faltaria só a linha de retenção do catálogo | **compatível** (passo 14): contrato completo; 207/207; testes de rota da fatia |

Medido em S86, sem a 84 (a contraprova do achado): um `member` reativa uma
conexão desligada e troca o `client_id` (1 linha), e quem é membro de A e de B
move a conexão de A para B (1 linha).

**O caminho do runbook:** (`main` + código, S86) → passo 11 (+ banco, S86) →
passo 12 (+ banco, S87) → passo 14 (+ auditoria, S87). Todas as células do
caminho são compatíveis.

## 2. Aplicação (passo 12: pela `main`, depois do merge da fatia de banco)

Pré-verificação: o status mostra só a 84 pendente, e a prévia com
`--ate-arquivo 84_proteger_conexoes_de_integracao.sql` mostra uma linha.

```bash
npm run db:remoto:aplicar -- --url "$SUPABASE_DB_URL" --confirmar --ate-arquivo 84_proteger_conexoes_de_integracao.sql
```

O que a 84 faz:
- revoga INSERT, UPDATE, DELETE e TRUNCATE de `authenticated`, `anon` e PUBLIC em `conexoes_integracao` e `chatwoot_inboxes`, e tudo deles em `credenciais_integracao` e `integracoes_bling` (que já não tinham nada);
- troca as policies `FOR ALL` por membership de `conexoes_integracao` e `chatwoot_inboxes` por `*_org_select`, só leitura;
- cria `fn_organizacao_da_integracao_imutavel` e três gatilhos: a organização de conexão, credencial e inbox não muda depois de definida (`23514`);
- confere as linhas existentes de `chatwoot_inboxes` e aborta se alguma apontar para conexão de outra organização ou provedor; cria `fn_valida_conexao_do_chatwoot_inbox` e o gatilho (`23503`);
- registra `integration.connection_configured` e `integration.connection_authorized` em `catalogo_eventos_auditoria`;
- não muda nenhuma linha de dados.

Ela se autoverifica e aborta a transação inteira se:
- sobrar escrita do navegador, por tabela ou por coluna, em qualquer das quatro;
- o navegador ler credencial;
- `authenticated` perder SELECT em `conexoes_integracao` ou `chatwoot_inboxes`;
- `service_role` perder DML;
- sobrar policy que não seja de leitura por `authenticated` sem `auth.uid()`;
- um gatilho novo faltar ou estiver desligado;
- o navegador executar qualquer função que cite as quatro tabelas.

**Locks.** Diferente da 83, a 84 cria e remove policies e gatilhos: precisa de
`ACCESS EXCLUSIVE` em `conexoes_integracao` e `chatwoot_inboxes`. Medido no
laboratório com dois clientes, a 84 aplicada dentro de uma transação desfeita:

| Outra sessão | Resultado da 84 |
|---|---|
| nenhuma | aplicou em 39 ms |
| `SELECT` em transação aberta em `conexoes_integracao` | abortou em 5 s com `55P03`, sem efeito |
| `UPDATE` em transação aberta em `conexoes_integracao` | idem |
| `SELECT` em transação aberta em `chatwoot_inboxes` | idem |
| `ROW EXCLUSIVE` em `credenciais_integracao` (gatilho novo) | idem |
| `ACCESS EXCLUSIVE` em `conexoes_integracao` | idem |

Enquanto espera o lock (até 5 s), a 84 também segura as leituras novas
dessas tabelas, que entram na fila atrás dela: webhook, sync e saúde podem
demorar até 5 s nessa janela. Por isso a janela precisa estar sem transação
longa nelas.

Webhooks, sync e a tela de saúde fazem leituras curtas. Num `55P03`, repetir o
mesmo comando: nada foi aplicado.

## 3. Validação (passo 13)

```sql
select t,
       has_table_privilege('authenticated', t, 'SELECT') as le,
       has_table_privilege('authenticated', t, 'INSERT') or has_table_privilege('authenticated', t, 'UPDATE')
         or has_table_privilege('authenticated', t, 'DELETE') as navegador_escreve,
       has_table_privilege('service_role', t, 'UPDATE') as servidor_escreve
  from unnest(array['public.conexoes_integracao', 'public.chatwoot_inboxes', 'public.credenciais_integracao']) t;
-- Esperado: conexoes e inboxes: le = true; credenciais: le = false;
-- navegador_escreve = false nas três; servidor_escreve = true nas três.

select p.polrelid::regclass, p.polname, p.polcmd
  from pg_policy p
 where p.polrelid in ('public.conexoes_integracao'::regclass, 'public.chatwoot_inboxes'::regclass,
                      'public.credenciais_integracao'::regclass);
-- Esperado: duas linhas, *_org_select, polcmd = r.

select count(*) from pg_trigger
 where tgname in ('trg_organizacao_da_conexao_imutavel', 'trg_organizacao_da_credencial_imutavel',
                  'trg_organizacao_do_chatwoot_inbox_imutavel', 'trg_valida_conexao_do_chatwoot_inbox')
   and tgenabled = 'O';
-- Esperado: 4.
```

Fumaça com dados sintéticos (sem chamar o Chatwoot nem o Bling):
1. A tela de Integrações carrega o status das conexões (`GET /api/integracoes/saude`).
2. Salvar credenciais Chatwoot sintéticas numa organização de teste responde 200 e a conexão fica `pendente`.

Fumaça depois do passo 14: o passo 2 grava `integration.connection_configured`
em `eventos_auditoria_sistema`, com o `correlation_id` da requisição e metadata
só com provedor e status.

## 4. Recuperação

**Nunca se concede de novo INSERT, UPDATE, DELETE ou TRUNCATE a `authenticated`
ou `anon`** nessas tabelas, nem por coluna, nem "temporariamente", e não se
recria policy de escrita; também não se usa `--adotar`. Toda recuperação é
conter, corrigir o comando do servidor ou reverter código.

- **Falha durante a 84:** ela volta inteira e nada muda. Leia o SQLSTATE:
  - `55P03`: lock, repetir;
  - `P0001 PRE-008: … linha(s) de chatwoot_inboxes apontam…`: há mapping cruzado no banco. Não corrigir automaticamente: listar as linhas, decidir com a proprietária e só então repetir.
- **Fluxo legítimo quebrado com 42501 depois da 84:** ele escrevia com o token do usuário. O inventário diz que nenhum escrevia. Conter (pausar a conexão afetada), mover a escrita para um comando do servidor, publicar.
- **Pausar uma conexão** (contenção do ticket), com a fatia de código publicada: pelo servidor, `update public.conexoes_integracao set status = 'desconectado' where id = '<conexao>' and organizacao_id = '<org>';`. Webhooks, envio, sync e token deixam de produzir efeito por ela; mapping, credencial e histórico ficam (pgTAP 32–33). Religar é refazer a conexão pela tela (connect, e o OAuth no Bling).
- **`23514` de organização imutável num fluxo do servidor:** é defeito do caller, que tentou mover a linha. Não remover o gatilho; corrigir o caller.
- **Fatia de auditoria com defeito:** reverter o merge dela. O callback volta a declarar `conectado` sem o evento; nada no banco precisa mudar.
- **Mensagens em voo:** a 84 não toca inbox, outbox nem espelhos. Uma entrega do Chatwoot que chegue durante a janela é lida pelo `service_role`, que não perde privilégio.

## 5. Provas

| Prova | Onde |
|---|---|
| Navegador (owner, admin, member de A; owner de B) não escreve nas quatro tabelas | pgTAP 1–4 (recusa por privilégio na própria tabela) |
| PATCH de status (reativar), de `client_id`, de organização (membro de A e B), DELETE e INSERT "conectado" | pgTAP 5–9 |
| Mapping de inbox: não move, não reivindica a inbox de A | pgTAP 10, 11 |
| Segredo: o navegador não lê credencial nem o espelho legado | pgTAP 12, 13 |
| anon sem nada; nenhuma coluna gravável; policies só de leitura; nenhuma função executável | pgTAP 14–18 |
| Nenhuma tentativa mudou nada (hash) | pgTAP 19 |
| Leitura por membership; A/B isolados | pgTAP 20–22 |
| Reconexão legítima pelo servidor (connect → cofre → callback) | pgTAP 23 |
| Organização imutável para conexão, credencial e inbox, mesmo no servidor | pgTAP 24–26 |
| Inbox só na conexão Chatwoot da mesma organização; inbox 1 em A e em B sem colisão | pgTAP 27–29 |
| Entrada inválida (status fora do contrato, credencial cruzada) | pgTAP 30, 31 |
| Pausar preserva mapping e credencial; apagar solta o inbox | pgTAP 32, 33, 35 |
| Segunda barreira: com o UPDATE de volta, a RLS não deixa tocar linha | pgTAP 34 |
| Navegador e sessão do usuário não nomeiam as tabelas; gravadores e capacidade fixados | `src/lib/escritaDiretaIntegracoes.test.ts` |

**Contraprovas SQL**, rodadas no laboratório. Cada sabotagem dentro da
transação do teste, desfeita pelo `rollback`:

| Sabotagem | Detectada por |
|---|---|
| `grant update on conexoes_integracao to authenticated` | 1–7, 15 |
| `grant insert, delete on conexoes_integracao to authenticated` | 1–4, 8, 9, 15 |
| `grant insert on chatwoot_inboxes to authenticated` | 1–4, 11, 15 |
| `grant select on credenciais_integracao to authenticated` | 12 |
| `grant execute on atualizar_saude_conexao to authenticated` | 18 |
| policy `FOR ALL` por membership recriada | 16, 17, 34 |
| `drop trigger trg_organizacao_da_conexao_imutavel` | 24 |
| `drop trigger trg_valida_conexao_do_chatwoot_inbox` | 27, 28 |
| a 84 **sem o REVOKE**, aplicada sobre S86 | a própria migration aborta: `P0001 PRE-008: authenticated ainda escreve em public.conexoes_integracao` |
| a 84 sem o REVOKE **e** sem a autoverificação | aplica, e o pgTAP derruba 1–9 e 15 |
| sem a 84 (S86) | o pgTAP derruba 24 de 35 |

**Contraprovas dos detectores** (Vitest), com os arquivos restaurados idênticos:
- a tela de Integrações gravando `conexoes_integracao`;
- gravador novo no servidor (`outboxService` reativando conexão);
- `registerChatwootInboxIfNeeded` chamado com outro cliente;
- `POST /api/chatwoot/connect` com `organization:access` no lugar de `organization:manage`.

## 6. Riscos residuais

- **Data API:** a negação foi provada no Postgres com os papéis e claims que o PostgREST usa (`set role authenticated` + `request.jwt.claim.*`), sem subir o PostgREST: o `[api]` do laboratório está desligado.
- **E2E:** não executado; não há ambiente E2E descartável, e a jornada real exige o Chatwoot e o Bling.
- **Lock de `ACCESS EXCLUSIVE`** nas duas tabelas durante a 84 (seção 2).
- **Webhook age como o owner**, não como um ator de integração; e não há API de desconexão. Ver as decisões no inventário.
