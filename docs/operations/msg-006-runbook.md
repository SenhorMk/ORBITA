# Consumidor da inbox do Chatwoot (MSG-006) — migration 89_consumidor_inbox_caso_triage.sql

O webhook só autentica e grava (MSG-005). Um processo worker separado reivindica
cada evento e, numa transação, grava espelho, caso SAC em `TRIAGE`, auditoria e
conclusão da inbox. Arquivo na ordem 92 do ledger.

## 1. Caminho

```text
webhook autenticado → inbox (commit) → 200
worker: reivindicar (lease + token) → traduzir → aplicar (transação única)
operador: GET /api/sac/casos, painel Integrações > Mensagens recebidas
```

| Peça | Onde |
|---|---|
| Claim, aplicação e falha | `reivindicar_eventos_inbox_chatwoot`, `aplicar_evento_inbox_chatwoot`, `registrar_falha_evento_inbox_chatwoot` (só `service_role`) |
| Tradução e regra de abertura | `src/services/chatwoot/chatwootWebhookPersistence.ts` |
| Passada e laço | `consumidorInboxChatwoot.ts`, `workerInboxChatwoot.ts` |
| Processo | `npm run worker:inbox` (`scripts/worker-inbox-chatwoot.ts`) |
| Leitura | `src/services/sac/leituraDeCasos.ts`, `src/app/api/sac/casos` (só GET) |

Não existe rota que acione o consumidor. As funções negam `anon`, `authenticated`
e `public`; a migration confere isso e aborta se não for verdade.

## 2. Regras

**Abertura de caso.** Exige prova positiva: `message_created`, com id de mensagem,
`message_type` `incoming` e `sender.type` `contact`, ambos declarados. O banco recusa
`abre_caso` sem isso. Nota privada, atendente, sistema e edição só atualizam o espelho.
Tipo ou remetente ausente ou desconhecido não vira atendimento, e o evento fica
`classificacao_inconclusiva`. Com tipo desconhecido a mensagem não entra no espelho (o texto
segue no payload da inbox); com remetente desconhecido, entra sem abrir caso. O sync também
pula mensagem de tipo desconhecido.
Regra e limites são parâmetros de laboratório, sujeitos a validação com o contrato real
do MSG-001.

| Situação | Resultado | Disposição |
|---|---|---|
| Sem caso aberto na conversa | abre caso em `TRIAGE` | `caso_aberto` |
| Caso aberto na conversa | soma ao caso | `mensagem_no_caso` |
| A mensagem já abriu um caso, mesmo fechado | nada novo | `mensagem_no_caso` |
| Caso terminal e mensagem nova | novo caso com `caso_anterior_id` | `caso_aberto` |

Dois índices únicos sustentam a regra, mesmo que a função erre: um caso aberto por
conversa e um caso por mensagem de origem.

**Disposição de cada evento** (`inbox_eventos_chatwoot.disposicao`):

| Status | Disposição | Quando |
|---|---|---|
| `processed` | `caso_aberto`, `mensagem_no_caso`, `espelho_atualizado` | efeito aplicado |
| `processed` | `revisao_atrasada` | revisão mais velha que a comprovada, ou sem versão diante de uma comprovada |
| `processed` | `classificacao_inconclusiva` | sem prova de que veio do cliente: sem caso |
| `ignored` | `evento_desconhecido` | tipo fora de `message_created`, `message_updated`, `conversation_status_changed` |
| `ignored` | `conversa_nao_espelhada` | status de conversa que ainda não existe aqui |
| `ignored` | `conexao_nao_comprovada` | status em conversa legada sem conexão |
| `ignored` | `conexao_removida` | a conexão do evento não existe mais |
| `failed` | sem disposição | falha repetível, com backoff de 10 s até 5 min |
| `failed` | `falha_definitiva` | payload inválido, id fora da faixa ou 8 tentativas |

`conversation_created` e demais eventos antes criavam espelho por efeito colateral.
Agora terminam `ignored`; a conversa vem pela primeira mensagem ou pelo sync.

**Ordem.** `skip locked` separa eventos; um lock por conversa impede dois comandos
da mesma conversa em paralelo.

**Revisão.** Só `updated_at` do provedor é versão: `conversation.updated_at` para o status,
`updated_at` da mensagem para o conteúdo. `created_at` e a chegada na inbox não provam nada.

| Gravador | Linha sem versão comprovada | Linha com versão comprovada |
|---|---|---|
| Com versão igual ou mais nova | aplica | aplica |
| Com versão mais velha | aplica | mantém a comprovada |
| Sem versão (declara `null`) | aplica, na ordem de chegada | mantém a comprovada |

O gatilho `fn_espelho_chatwoot_revisao` impõe isso a todo gravador, inclusive o sync, em
`status` e `status_revisao_em` e em conteúdo, tipo e remetente da mensagem. Quem não toca
a coluna de revisão (retenção, adoção de conexão) passa: anonimizar continua apagando.

## 3. Queda e concorrência

Fatia sem efeito externo: nada aqui chama o Chatwoot. Timeout de provedor, ACK
perdido do provedor e reconciliação de saída não se aplicam. O ACK perdido deste
lado é a segunda linha abaixo.

| Situação | O que acontece |
|---|---|
| Queda antes do commit | a transação aborta inteira; a lease vence e outro worker retoma com token maior |
| Queda depois do commit (resposta perdida) | o evento já está `processed`; o claim não o devolve |
| Worker pausado com lease vencida | `posse_perdida`, nada gravado |
| Lease vence com a transação aberta | a linha travada faz o claim pular; o commit em curso vale |
| Dois workers | `skip locked`: cada evento com um só dono |
| Redelivery durante o consumo | espera o commit (milissegundos) e responde 200 como duplicata |
| Redelivery depois de processado | 200, sem evento novo, sem claim |
| Conexão desligada | o claim não pega; em voo, o evento volta a `received` sem gastar tentativa |
| Evento que derruba o worker | 8 tentativas, depois `falha_definitiva` auditada |

A lease (60 s) não é renovada: cada evento é uma transação curta, e vencer no meio
só faz a aplicação ser recusada e o evento voltar.

## 4. Implantação: matriz aplicação × banco

Nada aqui foi aplicado em banco remoto. Aplicar exige autorização explícita: alvo,
SQL, validação e rollback. Banco primeiro.

| Aplicação | Banco | Resultado |
|---|---|---|
| MSG-005 | sem a 89 | estado anterior |
| MSG-005 | com a 89 | funciona; `concluir_evento` respeita a lease, então não atropela um worker |
| MSG-006 | sem a 89 | webhook aceita e grava; `GET /api/sac/casos` responde 500; o worker não sobe nada |
| MSG-006 | com a 89, worker desligado | recepção durável; os eventos ficam `received` |
| MSG-006 | com a 89, worker ligado | estado alvo |

Lock: `lock_timeout` de 5 s. `ACCESS EXCLUSIVE` breve em `inbox_eventos_chatwoot`,
`chatwoot_conversations` e `chatwoot_messages` para os `ALTER`; o índice único novo
em `chatwoot_messages` bloqueia escrita enquanto é construído (proporcional à
tabela). Sem reescrita de tabela. Em timeout, repetir: a migration é transacional.

**Antes de ligar o worker**, inventariar o que está parado. Evento anterior ao corte
(`CHATWOOT_INBOX_WORKER_BACKLOG_DESDE`) não é consumido; recuar o corte exige inventário e
autorização, porque evento antigo abre caso quando consumido. Não apagar nem alterar eventos
para simular backlog limpo:

```sql
select status, event_type, min(created_at), max(created_at), count(*)
  from public.inbox_eventos_chatwoot
 where status in ('received', 'failed', 'processing') and disposicao is null
 group by 1, 2 order by 1, 2;
```

Validação depois de aplicar:

```sql
select to_regclass('public.sac_cases') is not null as tabela,
       has_function_privilege('authenticated', 'public.aplicar_evento_inbox_chatwoot(uuid,text,bigint,jsonb)', 'execute') as navegador_aplica,
       has_table_privilege('authenticated', 'public.sac_cases', 'select') as navegador_le;
-- esperado: true, false, false
```

## 5. Configuração

| Variável | Padrão | Papel |
|---|---|---|
| `CHATWOOT_INBOX_WORKER_ENABLED` | `false` | kill switch; sem `true` o processo termina sem consumir |
| `CHATWOOT_INBOX_WORKER_BACKLOG_DESDE` | nenhum | obrigatório com o worker ligado: instante ISO; sem ele o processo recusa a partida. Evento mais antigo não é reivindicado nem alterado |
| `CHATWOOT_INBOX_WORKER_POLL_MS` | 1000 | intervalo com trabalho |
| `CHATWOOT_INBOX_WORKER_IDLE_MAX_MS` | 5000 | recuo máximo ocioso ou com o banco fora |
| `CHATWOOT_INBOX_WORKER_LEASE_SECONDS` | 60 | 5 a 300 |
| `CHATWOOT_INBOX_WORKER_BATCH` | 10 | 1 a 50 |
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | | acesso. Valor fora da faixa recusa a partida |

O `npm run worker:inbox` usa `ts-node`, dependência de desenvolvimento: serve para
DEV e laboratório. Empacotar e supervisionar o processo é do MSG-020.

**Credencial.** Hoje o worker usa `service_role`. **O banco não restringe esse papel às
três RPCs**: o limite está só no adapter, e a chave alcança qualquer tabela. A 89 prepara
`orbita_worker_inbox`: `NOLOGIN`, sem nenhuma tabela, com `EXECUTE` só nas três funções, que
gravam a auditoria sem depender do JWT. Provado no pgTAP. Habilitar é decisão pendente e
exige, por ambiente: dar login ou `grant orbita_worker_inbox to authenticator`, emitir uma
credencial própria sem `service_role` e trocar a do worker. Nada disso foi feito.

## 6. Pausa e recuperação (forward-only)

- **Parar o consumo:** desligar o processo ou o kill switch. A recepção continua
  gravando, e os eventos ficam `received`. Em voo, a lease vence e outro retoma.
- **Pausar uma instalação:** desligar a conexão (MSG-005 §6).
- **Reverter o código:** volta para o MSG-005 sem tocar no banco; a 89 é aditiva. Com
  o worker parado, o webhook antigo volta a consumir na requisição.
- **`falha_definitiva`:** não há replay nesta fatia. Corrigir a causa e tratar por
  nova migration ou procedimento autorizado.
- **Nunca:** apagar linhas da inbox para destravar, editar `status` de um evento
  concluído (o gatilho recusa), ou ligar o worker sem conferir o backlog.
- **Defeito na função:** nova migration com `create or replace`.

## 7. Observabilidade e dados

Logs `chatwoot.inbox.*` (`inicio`, `termino`, `recusada`, `falha`, `sem_resposta`,
`passada`, `claim_falhou`, `worker_*`) com organização, conexão, evento, delivery id
como `correlationId`, token, tentativa e desfecho. Sem conteúdo, nome ou telefone.
Exemplo de falha redigida: `chatwoot.inbox.falha` com `outcome: falha_23503`.

Auditoria na mesma transação, com `actor_id` nulo e `_source: worker`:
`sac.case_opened` e `chatwoot.inbox_event_failed`. `sac_cases` guarda ator de sistema
explícito e só ids, fase e datas. O texto continua em `chatwoot_messages`. Apagar a
conversa leva o caso em cascata, e a inbox perde só o vínculo.

## 8. Limitações conhecidas

- **Não é E2E real.** A prova usa handler, PostgREST, Postgres e worker reais, mas a
  entrega é assinada pelo teste (Chatwoot local depende do MSG-001) e a sessão do
  operador é injetada (o laboratório não tem GoTrue). O contrato real de
  `X-Chatwoot-Delivery`, `updated_at` e do status continua sem comprovação.
- **Sem `updated_at` real.** Se a API e os webhooks do Chatwoot não mandarem esse campo, nada
  fica comprovado: vale a ordem de chegada, e um snapshot atrasado pode sobrescrever. Depende
  da evidência do MSG-001.
- **Sync não cura edição perdida.** Com versão comprovada, o sync sem versão não corrige
  conteúdo cujo webhook mais novo se perdeu.
- **Mensagem que só chega pelo sync não abre caso.**
- **Revisão fora do espelho.** Contato não tem versão: a última gravação de nome e telefone vale.
- **Mensagem inconclusiva não aparece na conversa.** Com tipo desconhecido ela só está na inbox,
  e não há replay nesta fatia. Se o contrato real do MSG-001 não trouxer esses campos, nenhum
  caso abre: a regra precisa ser revista com a evidência, não afrouxada às cegas.
- **Sem trabalho derivado.** Nenhum trabalho de triagem é enfileirado: não há
  consumidor antes do MSG-013, que deve incluí-lo nesta transação.
- **Credencial.** O worker usa `service_role`, que o banco não restringe (§5).
- **Sem fairness por organização.** O claim é por ordem de chegada; o limite de 300
  entregas/min por conexão reduz, mas não elimina, a disputa entre organizações.
- **Parada graciosa só em teste de unidade.** `SIGTERM` no Windows mata o processo; a
  prova com processo real usa morte abrupta.
- **Retenção: pendência sob o MSG-021.** `sac_cases` e o payload da inbox seguem sem TTL
  próprio. Tráfego de dados reais continua proibido até os gates do MSG-021.

## 9. Evidência

| Prova | Onde |
|---|---|
| Superfície, claim, fencing, regra do caso, organizações, disposições, atomicidade, falha | `supabase/tests/final/consumidor_inbox_caso.test.sql` |
| Concorrência, quedas reais de conexão e contraprovas | `scripts/database-concurrency-consumidor-inbox.mjs` |
| Webhook → PostgREST → worker → operador, processo morto e reiniciado, navegador recusado | `src/services/chatwoot/consumidorInbox.integracao.test.ts`, por `scripts/database-integracao-consumidor-inbox.mjs` |
| Tradução, passada, kill switch, logs | `src/services/chatwoot/consumidorInboxChatwoot.test.ts` |
| Rota e tela do operador | `src/app/api/sac/casos/casos.test.ts`, `src/components/integracoes/MensagensRecebidas.test.tsx` |

Tudo roda em `npm run test:db`, menos os dois testes de unidade da última faixa. A
prova integrada baixa uma imagem do PostgREST fixada por digest.
