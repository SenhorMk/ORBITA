# Ingestion e sync do Chatwoot pelo UUID local (MSG-003A)

Migrate do expand/migrate/contract da identidade Chatwoot. O MSG-002 entregou o
modelo (migration 85); este ticket faz o webhook e o sync gravarem e
localizarem contato, conversa e mensagem pelo `id_local`, sempre dentro de
organização + conexão. **Sem SQL novo**: o modelo, os índices e o gatilho da 85
bastam. APIs, UI, Realtime e envio continuam no caminho legado até o MSG-003B;
as chaves globais saem no MSG-004.

## 1. O que mudou

| Peça | Antes | Agora |
|---|---|---|
| `identidadeChatwoot.ts` | — | resolver `resolverIdLocal` (id remoto → UUID) e `resolverIdExterno` (UUID → id remoto), sempre com organização + conexão; falhas tipadas |
| `espelhoChatwoot.ts` | — | `gravarContato`, `gravarConversa`, `gravarMensagem`, `atualizarStatusDaConversa`: localizam pelo resolver, atualizam pelo `id_local`, ligam o filho ao pai pelo UUID local |
| `espelhoChatwootSupabase.ts` | — | store `service_role`: toda consulta filtra organização e conexão (ou linha legada sem conexão); UUIDs do escopo validados antes do filtro `or` |
| webhook (`chatwootWebhookPersistence.ts`, `chatwootWebhookService.ts`) | `upsert` pela PK global; status por `id` + organização, sem conexão | espelho + resolver; inbox guarda o desfecho pelo UUID local; falha de identidade → 409 tipado e evento `failed` |
| sync (`api/chatwoot/sync`) | `upsert` pela PK global | espelho + resolver na conexão do adapter; recusa registrada e pulada, sem contagem inventada |
| `src/lib/chavesGlobaisChatwoot.test.ts` | — | detector: só os arquivos listados nomeiam as tabelas; webhook e sync não as tocam |

O id remoto aparece só no adapter, no resolver e como dado da linha.

## 2. Algoritmo de gravação

1. Resolver: linhas da organização com o `id_externo`, na conexão do escopo ou
   sem conexão (legado). Duas ou mais → `IdentidadeAmbigua`. Uma linha de outra
   conexão vinda de um store que não filtrou → `IdentidadeDeOutraConexao`.
2. Encontrou: `update ... where organizacao_id = ? and id_local = ? and
   (conexao_id = ? or conexao_id is null)`. Linha legada é adotada (o gatilho da
   85 confere a prova). Zero linhas = outra escrita a adotou → volta ao passo 1.
3. Não encontrou: `insert` com `id`, `id_externo`, organização e conexão.
   `23505` → volta ao passo 1 uma vez: se agora encontra, era corrida da mesma
   conexão (atualiza); se não, o id é de outra conexão/organização →
   `IdentidadeDeOutraConexao` (até o MSG-004 a PK `id` é global).
4. `message_created` usa o modo `preservar`: se a mensagem já existe (um
   `message_updated` chegou antes), não sobrescreve.
5. Mensagem cuja conversa não está espelhada na conexão → `PaiNaoEspelhado`;
   status de conversa não espelhada → `conversa_nao_espelhada` no inbox, sem
   criar a conversa.

Falhas: `IdentidadeNaoEncontrada`, `IdentidadeAmbigua`,
`IdentidadeDeOutraConexao`, `PaiNaoEspelhado`, `VinculoRecusado` (23503),
`StoreIndisponivel` (503 no webhook). O log `chatwoot.identidade.recusada`
leva organização, conexão, recurso e desfecho; nunca id remoto nem conteúdo.

## 3. Matriz aplicação × banco

Banco **S88** = cadeia até a 85. O código depende das colunas da 85
(`id_local`, `id_externo`, `contato_id_local`, `conversa_id_local`).

| Código \ Banco | S87 (sem a 85) | S88 |
|---|---|---|
| MSG-002 | compatível | compatível |
| MSG-003A | **incompatível**: o resolver consulta `id_externo`, que não existe → webhook responde 503/500 e o evento fica `failed`; o sync não grava | **compatível** (`test:db`, ensaio do resolver) |

**Ordem obrigatória:** aplicar a 85 (runbook do MSG-002) e validar → só então
publicar o código do MSG-003A. Gate antes do deploy (somente leitura):

```sql
select count(*) from information_schema.columns
 where table_schema = 'public' and column_name = 'id_local'
   and table_name in ('chatwoot_contacts', 'chatwoot_conversations', 'chatwoot_messages'); -- 3
```

## 4. Rollback

- Código: reverter para o MSG-002 (escrita legada compatível, que o gatilho da
  85 continua completando). Nada no banco precisa mudar; não há SQL a desfazer.
- Eventos que falharam no inbox durante a janela: reprocessar depois do
  rollback ou do conserto. Cada gravação é idempotente pelo UUID local.
- Congelar onboarding de segunda instalação até o MSG-004.

## 5. Matriz de efeitos externos

Este ticket não cria efeito externo: o webhook é entrada e o sync só lê do
Chatwoot (GET). Os 17 casos de timeout/ACK perdido/2xx inválido não se aplicam
a escrita no provedor. O caso equivalente do lado de dentro, a resposta do
banco perdida depois do commit, é coberto pela idempotência: a reentrega
resolve a mesma linha pelo resolver e não duplica.

## 6. Evidência

- `src/services/chatwoot/espelhoChatwoot.test.ts` (21): instalações A1/A2/B1
  com os mesmos ids nos dois modelos (antes e depois do MSG-004), duplicação,
  reprocessamento, fora de ordem, corrida intercalada, adoção legada,
  ambiguidade, vínculo de outra conexão, store indisponível e contraprovas
  (store sem filtro de conexão, busca global).
- `src/services/chatwoot/espelhoChatwootSupabase.test.ts` (5): filtros exatos
  da query e bloqueio de injeção pelo escopo.
- `src/app/api/chatwoot/webhook/[conexaoId]/webhook.test.ts`: B com os ids de A
  → 409 tipado, evento `failed`, log redigido; mensagem antes da conversa e
  reprocessamento; `message_updated` antes de `message_created`; status cruzado.
- `src/app/api/chatwoot/sync/sync.test.ts`: A/B nos dois modelos, re-sync,
  adoção legada, troca de organização durante o sync, sync + webhook
  concorrentes.
- `src/app/api/chatwoot/sync/sync.test.ts` (modelo pós-MSG-004): três
  instalações (A, segunda de A, B) com os ids 5/50/500 por webhook e sync,
  concorrentes, com reprocessamento e `message_updated` antes do
  `message_created`: três árvores, nenhuma mistura.
- `scripts/database-concurrency-resolver-chatwoot.mjs` (em `test:db`), contra
  Postgres real com bloqueio observado: corrida da mesma conexão converge,
  B nunca toma a linha de A, adoção legada não troca de instalação, vínculo
  cruzado → 23503, `authenticated` → 42501; PRE-008 × MSG-002: desligar e
  reativar a conexão pelo `update` da rota de connect, com o evento de
  auditoria pela RPC real, mantém `conexao_id`, UUIDs e o vínculo conversa →
  contato; simulação pós-contração com 3 instalações, replay do sync isolado e
  contraprovas (sem conexão = 2, global = 3, update por id = 3).

## 6a. Integração com o PRE-008 (combinação #125 + #127 + #128)

- Webhook em conexão desligada (PRE-008) não chega ao store de identidade
  (MSG-002/003A): o teste do PRE-008 em `webhook.test.ts` agora confere que o
  store não recebeu nenhuma chamada.
- A reativação (`POST /api/chatwoot/connect`) reaproveita a mesma linha de
  `conexoes_integracao`; não existe rota de disconnect (desligar é
  `status = 'desconectado'` no servidor). Como `conexao_id` não muda, a
  associação de identidades sobrevive ao ciclo — provado no ensaio acima.
- O adapter (`ChatwootAdapter.forScope`) recusa conexão desligada; o sync usa a
  conexão do adapter, então não grava por conexão desligada.
- Nenhum conflito semântico encontrado; nada foi corrigido na integração.

Limitações: o webhook e o sync são exercitados com fakes do Chatwoot e do
store; o store real é provado pelas mesmas instruções SQL no laboratório, não
pelo PostgREST (o laboratório não sobe a API). Nenhuma chamada real.

## 7. Pendências conhecidas

- Retenção (`retentionDbAdapter`) ainda checa o contato por `id` + organização,
  via RPC da migration 51: entra na contração do MSG-004.
- O `resolverIdExterno` exige conexão provada; linha legada em quarentena não é
  traduzida para envio (MSG-003B decide a mensagem ao operador).
