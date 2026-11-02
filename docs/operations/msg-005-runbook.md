# Aceite do webhook na inbox do Chatwoot (MSG-005) — migration 88_inbox_chatwoot_dedup_entrega_revisao.sql

O webhook autentica, limita e grava a entrega e o evento minimizado antes de
qualquer efeito e de qualquer 2xx. O consumo continua síncrono na mesma
requisição; a separação em worker é do MSG-006.

## 1. Ordem do caminho de entrada

Cada passo recusa sem executar os seguintes.

| Passo | Recusa | Efeito gravado |
|---|---|---|
| 1. Corpo lido em bytes, até 256 KiB | 413 | nenhum |
| 2. Formato de `X-Chatwoot-Signature`, `X-Chatwoot-Timestamp`, `X-Chatwoot-Delivery` | 401 / 400 | nenhum |
| 3. Conexão + segredo do cofre | 404 / 500 | nenhum |
| 4. HMAC sobre `{timestamp}.` + bytes originais; janela de 5 min | 401 | nenhum |
| 5. Conexão desligada | 403 | nenhum |
| 6. Limite: 300 entregas/min por conexão | 429; contador fora do ar: 503 | só o contador |
| 7. UTF-8 estrito, JSON, Zod | 400 | só o contador |
| 8. `account.id` = account da conexão; owner; escopo; inbox resolvível | 403 / 503 / 400 | só o contador |
| 9. `aceitar_entrega_inbox_chatwoot` (commit) | 409 / 403 / 400 / 503 | tudo ou nada |
| 10. Mapping da inbox e efeitos no espelho | 409 / 500 / 503, evento vira `failed` | evento durável, reentrega reprocessa |

O limite vem depois da assinatura de propósito: quem não tem o segredo não
consome a cota da conexão e não derruba entregas legítimas.

## 2. Decisão de dedup

Três identidades separadas:

| Identidade | Onde | Unicidade |
|---|---|---|
| Entrega | `inbox_entregas_chatwoot.delivery_id` (opcional no Chatwoot) | organização + conexão + delivery id |
| Evento lógico + revisão | `inbox_eventos_chatwoot.idempotency_key` (`v2:`) | organização + conexão + chave |

| Evento | Chave | Por quê |
|---|---|---|
| `message_created` | `v2:message_created:msg:{id}` | acontece uma vez por mensagem |
| `message_updated` | `v2:message_updated:msg:{id}:{marcador}:{digest}` | A→B→A é legítimo |
| `conversation_status_changed` | `v2:conversation_status_changed:conv:{id}:{status}:{marcador}` | open→resolved→open→resolved é legítimo |
| Demais | `v2:{evento}:{id ou sem-id}:{marcador}:{digest}` | forma desconhecida |

Marcador de revisão, nesta ordem: `updated_at` do provedor (`u…`), delivery id
(`d…`), timestamp assinado (`t…`). O digest cobre `content`, `message_type` e
`private` em forma canônica.

**Na dúvida a chave separa.** Sem `updated_at` e sem delivery id não dá para
distinguir, pelos bytes, uma repetição de uma segunda ocorrência idêntica. Por
isso o timestamp assinado entra: um reenvio reassinado vira uma segunda linha,
que reaplica o mesmo estado no espelho. O caminho oposto perderia a ocorrência
sem deixar rastro. `message_created` é a exceção: a chave não leva marcador, e
o reenvio é sempre duplicata.

Sem delivery id nada é inventado: não há linha em `inbox_entregas_chatwoot` e o
dedup é só pela chave.

## 3. Comportamento em redelivery

| Situação | Resposta | Inbox | Efeito |
|---|---|---|---|
| ACK perdido, evento `processed` | 200 com a resposta gravada | sem linha nova | não repete |
| Mesmo evento em outra entrega, `processed` | 200 com a resposta gravada | nova linha só em entregas | não repete |
| Evento `received` ou `failed` (falha ou queda depois do aceite) | conforme o reprocessamento | sem linha nova | reprocessa; gravações idempotentes pelo UUID local |
| Mesmo delivery id com outro evento | 409 | nada | nenhum |
| Banco fora antes do commit | 503 | nada (a transação aborta) | nenhum; a reentrega grava como nova |
| Duas entregas iguais em paralelo | as duas respondem conforme o processamento | um evento | a segunda espera o commit da primeira e pode reprocessar enquanto o evento não estiver `processed` |

O Chatwoot só reentrega se a instância fizer isso. Uma entrega com não-2xx que
não volta fica sem linha ou como `failed`: quem cobre o buraco é o sync, não este
ticket.

## 4. Implantação: matriz aplicação × banco

Banco primeiro.

| Aplicação | Banco | Resultado |
|---|---|---|
| MSG-004 | sem a 88 | estado anterior |
| MSG-004 | com a 88 | funciona: `registrar_evento_inbox_chatwoot` continua igual; revisões seguem sendo engolidas |
| MSG-005 | sem a 88 | **fail-closed**: RPC ausente vira `InboxIndisponivel`, 503, nada gravado |
| MSG-005 | com a 88 | estado alvo |

Na troca, um evento gravado pelo app antigo (chave legada) e reentregue ao novo
não é reconhecido como duplicata: é reprocessado, e os efeitos são idempotentes.
A 88 não faz backfill de chaves.

Aplicar exige autorização explícita: alvo, SQL, validação e rollback. Lock:
`lock_timeout` de 5 s; só cria objetos novos e pega `share row exclusive`
momentâneo em `organizacoes`, `conexoes_integracao` e `inbox_eventos_chatwoot`
pelas FKs. Sem reescrita de tabela nem alteração de dados. Em timeout, repetir;
a migration é transacional.

## 5. Validação depois de aplicar

```sql
select to_regclass('public.inbox_entregas_chatwoot') is not null as tabela,
       to_regprocedure('public.aceitar_entrega_inbox_chatwoot(uuid,uuid,uuid,bigint,text,text,text,jsonb)') is not null as funcao,
       has_function_privilege('authenticated', 'public.aceitar_entrega_inbox_chatwoot(uuid,uuid,uuid,bigint,text,text,text,jsonb)', 'execute') as navegador_executa;
-- esperado: true, true, false
```

A migration também se autoverifica e aborta se faltar RLS, índice único ou se o
navegador alcançar a tabela ou a função.

## 6. Pausa e recuperação (forward-only)

- **Pausar a recepção:** desligar a conexão (`status = 'desconectado'`, PRE-008).
  A entrega em curso termina e a seguinte recebe 403, sem gravar nada. Inbox e
  segredo ficam. O 403 do webhook não prova nada ao Chatwoot: entregas desse
  período só voltam pelo sync.
- **Reverter o código:** volta para o MSG-004 sem tocar no banco; a 88 é aditiva.
- **Nunca:** apagar `inbox_entregas_chatwoot` ou `inbox_eventos_chatwoot` para
  "destravar" uma entrega (o dedup se perde e o efeito pode repetir), dar ACK sem
  persistir, nem relaxar a assinatura.
- **Defeito na função:** nova migration com `create or replace`; a 88 não se edita.

## 7. Dados e retenção

`inbox_entregas_chatwoot` guarda delivery id, chave e referências, sem conteúdo.
Só o `service_role` lê ou escreve. As linhas caem em cascata com o evento, a
conexão e a organização. A chave não contém conteúdo privado: em `message_updated`
o texto entra só como digest truncado. O payload minimizado segue em
`inbox_eventos_chatwoot`, ainda sem TTL (herdado).

Logs: `chatwoot.webhook.aceita`, `chatwoot.webhook.recusada` e
`chatwoot.webhook.falha`, com conexão, organização, tipo do evento, delivery id
como `correlationId` e desfecho. Sem conteúdo, nome, assinatura ou erro cru do
banco; a resposta HTTP também não carrega texto interno.

## 8. Efeitos externos: matriz de casos

Fatia sem efeito de saída: recebe e grava, não chama o Chatwoot. Timeout, ACK
perdido do provedor, 2xx inválido e reconciliação de saída não se aplicam aqui
(a saída é do MSG-007/MSG-008). O ACK perdido deste lado é o inverso: coberto no
§3.

## 9. Limitações conhecidas

- **Contrato real não comprovado.** `X-Chatwoot-Delivery`, `updated_at` e o
  formato de `conversation_status_changed` (o consumidor lê `conversation.*`)
  não foram comparados com uma instância real; depende da evidência do MSG-001.
- `X-Chatwoot-Delivery` não é coberto pela assinatura. Quem captura uma requisição
  assinada pode, dentro dos 5 min, reenviá-la com outro delivery id e gerar uma
  "revisão" de `message_updated` ou status sem `updated_at`, regravando conteúdo
  já autêntico. Não forja conteúdo.
- A ordem de aplicação das revisões ainda é a de chegada: a inbox guarda as duas,
  mas o espelho fica com a última que chegou. Ordenar é do consumidor (MSG-006).
- Entrega forjada sem o segredo ainda custa uma consulta e uma decifragem antes
  do HMAC (o limite vem depois da assinatura).

## 10. Evidência

| Prova | Onde |
|---|---|
| Catálogo, recusas, revisões, instalações, contraprovas SQL | `supabase/tests/final/inbox_dedup_chatwoot.test.sql` |
| 100 concorrentes, queda antes do commit, visível no retorno, desligar × aceitar | `scripts/database-concurrency-inbox-chatwoot.mjs` (`npm run test:db`) |
| Ordem do caminho, redelivery, limites, logs | `src/app/api/chatwoot/webhook/[conexaoId]/webhook.test.ts` |
| Chave e aceite tipado | `src/services/chatwootInboxService.test.ts` |

Limitação da prova: o ensaio exercita a função no Postgres; o handler HTTP é
testado com uma inbox fiel em memória. A costura entre os dois (PostgREST) não
foi exercitada de ponta a ponta.
