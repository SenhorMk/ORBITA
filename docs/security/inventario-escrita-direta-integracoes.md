# Inventário da escrita direta — conexões de integração (PRE-008)

Escopo: `conexoes_integracao`, `chatwoot_inboxes`, `credenciais_integracao`,
o espelho legado `integracoes_bling` e as funções do banco que citam essas
tabelas. Base: `main` `ce19a9a`. Fontes, todas executadas:
- código em `src/`: varredura de `.from(...)`/`.rpc(...)`, do cliente do navegador, do cliente com a sessão do usuário e das rotas;
- laboratório descartável (Windows, Docker) com a cadeia canônica cortada no ledger. As quatro tabelas são idênticas de S77 a S86: nenhuma migration de 75 a 83 as toca (`grep` e medição).

Nada foi executado em banco remoto, no Chatwoot ou no Bling.

Entrega em três fatias:

| Fatia | Branch | Base | Leva |
|---|---|---|---|
| código | `fix/pre-008-codigo` | `main` | este inventário; conexão desligada sem efeito; Zod no corpo do connect do Chatwoot. Sem SQL e sem objeto novo no banco: compatível de S77 a S87 |
| banco | `fix/pre-008-banco` | `fix/pre-007b-banco` (#122) | migration `84_proteger_conexoes_de_integracao.sql` (ordem 87), ledger, catálogo, pgTAP, detectores e o runbook [`pre-008-runbook.md`](../operations/pre-008-runbook.md) |
| auditoria | `fix/pre-008-auditoria` | fatia de banco | a (re)ativação pela API passa a gravar `integration.connection_*` |

**Nenhum caller grava com o token do usuário.** Por isso a revogação da 84 não
depende de RPC nova, e a branch `fix/pre-008-rpc` não existe: o detector
`src/lib/escritaDiretaIntegracoes.test.ts` (fatia de banco) prova que nenhum
arquivo do navegador nem da sessão do usuário nomeia as quatro tabelas. A
terceira fatia existe só para o critério "reconexão auditada": ela grava evento
de catálogo novo, e o teste de paridade do catálogo exige a linha SQL da 84.

## 1. Navegador (chave anônima + sessão do usuário)

O navegador **não lê nem grava** nenhuma das quatro tabelas, nem por `.from`,
nem por embed, e não chama RPC. A tela de Integrações
(`src/components/integracoes/IntegrationsPanel.tsx`) fala com
`POST /api/bling/connect`, `GET /api/bling/authorize`,
`POST /api/chatwoot/connect` e `GET /api/integracoes/saude`. O cliente com a
sessão do usuário (`createActorScopedSupabaseClient`) não toca as tabelas.

**Realtime:** nenhuma das quatro está publicada.

**O que o navegador conseguia antes da 84, pelo PostgREST e com o próprio
token** (o grant de DML da migration 25 mais a policy `FOR ALL` por membership):

| Ataque | Quem | Efeito |
|---|---|---|
| `PATCH status=conectado` | qualquer membro, inclusive `member` | reativa uma conexão desligada ou pendente sem OAuth nem `organization:manage` |
| `PATCH metadata={"client_id": …}` | idem | `GET /api/bling/authorize` passa a mandar o lojista para outro aplicativo |
| `PATCH organizacao_id=<B>` | membro de A e de B | o WITH CHECK só exige membership no destino: a conexão (e o webhook dela) muda de organização |
| `DELETE` | qualquer membro | a credencial some junto (`on delete cascade`); inbox, outbox e espelhos ficam com `conexao_id` nulo |
| `INSERT … status=conectado` | qualquer membro | conexão "conectada" sem credencial nenhuma |

Em `chatwoot_inboxes` o navegador só tinha SELECT; `credenciais_integracao` e
`integracoes_bling` já não concediam nada a `authenticated`/`anon`.

## 2. Servidor (service role, escopo verificado)

| Rota / caller | Acesso | Organização vem de | Capacidade | Zod |
|---|---|---|---|---|
| `POST /api/bling/connect` | lê, insere, atualiza `conexoes_integracao` (`pendente`, `client_id` só depois do cofre); grava o cofre | sessão verificada | `organization:manage` | `blingCredentialsPayloadSchema` |
| `GET /api/bling/authorize` | lê `metadata.client_id` | sessão verificada | `organization:manage` | `organizacao_esperada` da query só recusa |
| `GET /api/bling/callback` | upsert `pendente` → cofre → auditoria → `conectado` | transação OAuth consumida (state + cookie) | a do authorize | tokens pelo contrato do OAuth |
| `POST /api/bling/webhook` | lê as conexões Bling e o `client_secret` do cofre para o HMAC | a conexão cujo segredo confere | assinatura | contrato do evento |
| `POST /api/chatwoot/connect` | lê, insere, atualiza (`pendente`); desfaz a linha nova se o cofre recusar | sessão verificada | `organization:manage` | **`ChatwootConnectBodySchema`** (fatia de código) |
| `POST /api/chatwoot/webhook/[conexaoId]` | lê `id, organizacao_id, status`; o mapping de inbox passou para `aplicar_evento_inbox_chatwoot`, no worker (MSG-006) | a conexão do path, provada pelo HMAC com o segredo dela | assinatura + `account_id` conferido com o cofre | `ChatwootWebhookEventSchema` |
| `POST /api/chatwoot/sync` | registra o mapping de inbox de conversas lidas com as credenciais da própria organização | sessão verificada | `organization:access` | contrato da Application API |
| `ChatwootAdapter.forScope` (send, status, sync) | lê a conexão e o cofre | escopo verificado | a da rota | `ChatwootCredentialsPayloadSchema` |
| `blingCredenciaisSupabase` (token do Bling) | lê `id, status`; `acquire/release_conexao_token_lock`; regrava o cofre na renovação | escopo verificado | a da rota | `blingVaultCredentialsSchema` |
| `GET /api/integracoes/saude` | lê status e saúde (erro sanitizado), nunca o cofre | sessão verificada | membership | — |
| `entitlementLifecycleRepository` | conta conexões | org do ciclo de vida | — | — |

Gravadores diretos, todos com `supabaseServer` (o detector os fixa):
`bling/callback/route.ts` (`conexoes_integracao`),
`bling/connect/route.ts`, `chatwoot/connect/route.ts`,
`lib/integrations/credentialsVault.ts` (`credenciais_integracao`) e
`services/chatwoot/chatwootInboxRegistration.ts` (`chatwoot_inboxes`, recebe o
cliente por parâmetro; o único caller, o sync, passa o `supabaseServer`).

Funções do banco que citam as tabelas, medidas em S86. Nenhuma é executável por
`authenticated` ou `anon`:
- `aplicar_evento_inbox_chatwoot` (migration 89, só `service_role`): grava `chatwoot_inboxes` com a organização e a conexão da linha da inbox;
- `acquire_conexao_token_lock`, `release_conexao_token_lock`, `acquire_bling_token_lock` (security invoker, só `service_role`);
- `atualizar_saude_conexao`, `concluir_evento_outbox`, `executar_encerramento_definitivo` (security definer, só `service_role`);
  desde a migration 86 (MSG-007), `concluir_evento_outbox` não existe mais: a conclusão é
  `concluir_tentativa_outbox`, por compare-and-set de dono, fencing token e lease, e
  atualiza a saúde só da conexão da mesma organização do evento;
- backfills `migrar_bling_para_organizacoes`, `migrar_bling_conexoes_organizacao_contabilizado`, `migrar_chatwoot_para_organizacoes`;
- gatilho `fn_sync_credenciais_integracao` (recusa credencial de outra organização com `23503`).

## 3. Banco — matriz de privilégios efetivos (`has_table_privilege`)

| Tabela | Papel | S77–S86 (antes) | S87 (depois da 84) |
|---|---|---|---|
| `conexoes_integracao` | `authenticated` | S I U D (12 colunas graváveis) | **S** (0 colunas) |
| | `anon` | — | — |
| | `service_role` | S I U D T | S I U D T |
| `chatwoot_inboxes` | `authenticated` | S | S |
| | `service_role` | S I U D T | S I U D T |
| `credenciais_integracao` | `authenticated` / `anon` | — | — |
| | `service_role` | S I U D T | S I U D T |
| `integracoes_bling` | `authenticated` / `anon` | — | — |
| | `service_role` | só `TRUNCATE` (e `REFERENCES`, `TRIGGER`) | igual |

**Policies:** antes, uma `FOR ALL` por membership em `conexoes_integracao`
(migration 25) e outra em `chatwoot_inboxes` (migration 27). Depois da 84, só
`*_org_select`. `credenciais_integracao` não tem policy nenhuma, antes e
depois. A de `integracoes_bling` (`auth.uid() = user_id`, papel PUBLIC) fica:
sem grant, ela não é alcançável.

## 4. Fatia de código: o que muda na aplicação

1. **Conexão desligada não produz efeito** (`status = 'desconectado'`,
   `src/lib/integrations/conexaoDesligada.ts`). Nenhum caminho respeitava o
   status, e nenhum código o grava: era um estado sem efeito. Agora:
   - webhook do Chatwoot: 403 `Conexão Chatwoot desligada` depois da
     assinatura e antes de mapping, inbox ou efeito. Com assinatura inválida
     continua 401, sem revelar o estado;
   - webhook do Bling: a conexão desligada não é candidata ao HMAC, então o
     evento dela não casa e é recusado; as outras organizações não mudam;
   - `ChatwootAdapter.forScope`: não monta adapter nem lê o cofre;
   - token do Bling: a conexão conta como ausente, e nem se renova o token.

   É a alavanca de contenção do rollback ("pausar a conexão afetada"). Religar
   é refazer a conexão pela API autorizada. Lê só a coluna `status`, que existe
   desde a 25: compatível de S77 a S87.
2. **`organizacao_esperada` no Zod** em `POST /api/chatwoot/connect`. Antes ela
   era lida do corpo cru, e um valor que não fosse texto desligava a guarda em
   silêncio. Agora é 400. O campo sai do objeto antes do cofre.

## Achados

1. **Corrigido (fatia de banco): DML direto em `conexoes_integracao`.** Ver a
   tabela da seção 1. Provado no laboratório: em S86 o UPDATE do `member` passa;
   em S87 cai com `42501` na própria tabela (pgTAP 1–9), e com o grant de volta
   por engano a RLS ainda não deixa tocar linha nenhuma (pgTAP 34).
2. **Corrigido (fatia de banco): organização mutável e inbox sem vínculo
   conferido.** Nem o `service_role` move conexão, credencial ou inbox para
   outra organização (`23514`), e o inbox só aponta para conexão Chatwoot da
   mesma organização (`23503`).
3. **Corrigido (fatia de código): `desconectado` não bloqueava nada.**
4. **Corrigido (fatia de auditoria): a reconexão não deixava rastro.**
5. **Para decisão (sem mudança aqui):**
   - **O webhook age como o owner.** Chatwoot e Bling resolvem o owner da
     organização e usam o id dele como ator dos efeitos e da auditoria. O ticket
     pede um "ator integração". Mudar isso toca as colunas `user_id` (NOT NULL,
     FK para `auth.users`) dos espelhos do Chatwoot e o anti-forjamento da
     auditoria. Organização sem owner continua recusada (403), sem efeito.
   - **Não existe API de desconexão.** Nenhuma rota grava `desconectado`. Até
     haver uma, pausar é operação de servidor (runbook, seção 4).
   - **Uso de conexões no billing sempre zero.** `entitlementLifecycleRepository`
     e `enforceIntegrationLimit` contam `status = 'ativa'`, valor que a
     constraint não admite. `enforceIntegrationLimit` não tem caller. É dívida
     do PRE-011, não deste ticket.
   - **`executar_encerramento_definitivo` grava `status = 'revogada'`**, que a
     mesma constraint recusa: o encerramento definitivo de uma organização
     com conexão falha inteiro. Medido no laboratório em S86, numa transação
     desfeita: `23514 conexoes_integracao_status_check`. A 84 não muda isso.
   - **`integracoes_bling`**: o `service_role` não tem SELECT/INSERT/UPDATE, então
     o callback usa o cofre da organização. A tabela guarda tokens de antes do
     cofre; removê-la é ticket próprio.

## Matriz de efeitos externos (17 casos)

O PRE-008 não cria efeito externo novo: não chama o Chatwoot nem o Bling de um
jeito diferente. A fatia de código só **deixa de** produzir efeito por conexão
desligada, sempre antes de qualquer chamada ao provedor. Os 17 casos da
arquitetura (timeout, ACK perdido, 2xx inválido, crash antes e depois do
efeito, replay…) não se aplicam a uma recusa que acontece antes do efeito. O
callback OAuth, da fatia de auditoria, já gravava em três escritas sem
transação; a auditoria entra antes da última, e a falha dela deixa
`pendente`, o mesmo desfecho de uma falha do cofre.

## Testes que provam (fatia de código)

| Prova | Onde |
|---|---|
| Conexão desligada: webhook Chatwoot recusa sem mapping, inbox nem efeito | `chatwoot/webhook/[conexaoId]/webhook.test.ts` |
| Desligada com assinatura inválida: 401, estado não revelado | idem |
| Organização A/B: desligar A não afeta B no webhook do Bling | `bling/webhook/tenants.test.ts` |
| Adapter não monta e não lê o cofre | `chatwoot/chatwootAdapter.forScope.test.ts` |
| Token do Bling: desligada é "sem conexão"; os outros status seguem | `blingCredenciaisContrato.test.ts` |
| Entrada inválida (`organizacao_esperada` não textual): 400, nada gravado | `chatwoot/connect/connect.test.ts` |
| Organização do corpo não é autoridade (409; `organizacao_id` ignorado) | idem |
| Usuário sem capability: 403 | idem (já existia) |
| Segredo fora da resposta e do log | idem |

**Contraprovas** (Vitest), todas detectadas, com os arquivos restaurados idênticos (hash conferido):
- webhook do Chatwoot sem a checagem de status;
- webhook do Bling sem o filtro de status;
- token do Bling sem a checagem;
- adapter sem a checagem;
- `organizacao_esperada` voltando a aceitar qualquer coisa (`.catch(undefined)`);
- a guarda de organização esperada desligada.

## Cobertura pedida pela proprietária

pgTAP = `supabase/tests/final/conexoes_de_integracao.test.sql` (fatia de banco).

| Item | Prova |
|---|---|
| Reatribuir `organizacao_id`, account, inbox ou segredo com o token do navegador | pgTAP 5–13: status, `client_id`, organização (membro de A e B), DELETE, INSERT, mapping de inbox (move e claim) e credencial. A account do Chatwoot vive no cofre (12) e em `chatwoot_inboxes.account_id` (10, 11); nenhuma das duas é gravável pelo navegador |
| Conexão compartilhada entre duas organizações | pgTAP 7 e 24–26 (nem navegador nem servidor movem conexão, credencial ou inbox), 27 (inbox de B na conexão de A), 31 (credencial de A na conexão de B); webhook com `inbox_id = 1` em A e em B sem mistura (`webhook.test.ts`, já existia) |
| Reconexão sem prova de posse da conta | Só o OAuth do Bling declara `conectado`, e só com a transação OAuth consumida (`callback.test.ts`, já existia); na fatia de auditoria, o ator ainda membro é exigido e a autorização é auditada antes (`persistencia-atomica.test.ts`, `auditoriaDeConexao.test.ts`). O connect do Chatwoot nunca declara `conectado` ("salvar credenciais não declara a instância conectada", já existia); a posse é provada a cada entrega pelo HMAC e pelo `account_id` do cofre (`webhook.test.ts`). O navegador não declara `conectado` (pgTAP 5, 9) |
| Associação indevida de inbox | pgTAP 11, 27, 28 (inbox na conexão Bling), 29; webhook com `account_id` diferente do cofre → 403 (já existia) |
| Desconexão com operações pendentes | Não há consumidor de outbox para o Chatwoot hoje: o envio é inline. Com a conexão desligada, o envio registra a tentativa como falha, não chama o Chatwoot nem grava mensagem (`chatwoot/send/desligada.test.ts`, novo); a entrega inbound é recusada antes do inbox (`webhook.test.ts`); mapping e credencial ficam (pgTAP 32–33). Uma entrega que já passou da checagem quando a pausa acontece termina normalmente: não há lock entre as duas (risco residual) |
| Revogação que não quebra funcionalidade autorizada | pgTAP 23 (reconexão pelo servidor) e 35; os seis pgTAP anteriores verdes em S87 e o `test:db` inteiro; o detector prova que nenhum caller escreve com o token do usuário; as suítes de rota de connect, callback, webhook e sync seguem verdes |
| Autenticação de webhooks, cofre e tokens | Chatwoot: assinatura ausente, inválida, adulterada, timestamp e `account_id` (`webhook.test.ts`); Bling: HMAC por conexão, corpo adulterado, cofre indisponível (`tenants.test.ts`); cofre e espelho legado ilegíveis pelo navegador (pgTAP 12, 13); segredo fora da resposta e do log (`connect.test.ts`) |
| Dono da organização perde o acesso | Webhook do Chatwoot: 403 sem mapping, inbox nem efeito (`webhook.test.ts`, novo); webhook do Bling: 403 (`webhook.test.ts` do Bling, já existia); callback OAuth com o ator fora da organização: a conexão fica `pendente` (fatia de auditoria); as rotas de connect exigem sessão e `organization:manage` (401/403, já existia). A integração não passa a agir em nome de outro membro |
| Preservação de callbacks, sincronizações e operações existentes | Matriz S77–S87 (contrato e pgTAP); suítes completas verdes nas três fatias; `merge-tree` código × auditoria limpo |
