# Envio ao Chatwoot por consumidor real (MSG-008) — migration 90_envio_chatwoot_por_consumidor.sql

Responder no cockpit **registra uma intenção**; um processo worker separado
despacha ao Chatwoot. A mensagem só vira histórico com o recibo do Chatwoot
gravado. Arquivo na ordem 93 do ledger, empilhado sobre o MSG-001 (#136).

> **Desde o MSG-009** (migration 91, [runbook](msg-009-runbook.md)): o claim exige `p_protocolo = 2` e devolve `privada`; o worker inicia o despacho por `iniciar_envio_chatwoot`, que confere a versão do controle do atendimento (o genérico `iniciar_despacho_outbox` passa a recusar evento de `chatwoot_envios`, 55000); responder conversa de outra pessoa é 409 `outro_responsavel`.

## 1. Caminho

```text
cockpit: POST /api/chatwoot/send { conversaId, commandId, content } → 202 (nada sai daqui)
         registrar_envio_chatwoot: intenção + evento da outbox + auditoria, numa transação
worker:  liberar leases → reivindicar_envios_chatwoot (lease + token, só desde o corte)
         → autor ainda membro? conexão ligada? (antes da rede)
         → iniciar_despacho_outbox (in_flight) → POST ao Chatwoot
         → concluir_envio_chatwoot (fencing; com recibo, a mensagem espelhada na mesma transação)
cockpit: GET /api/chatwoot/send?conversaId=… → pendente | enviando | enviado | recusado | desconhecido
```

| Peça | Onde |
|---|---|
| Intenção, claim e conclusão | `registrar_envio_chatwoot`, `reivindicar_envios_chatwoot`, `concluir_envio_chatwoot` (só `service_role`) |
| Estados e reaper | outbox do MSG-007 (`iniciar_despacho_outbox`, `liberar_leases_expirados_outbox`), sem mudança |
| Rota | `src/app/api/chatwoot/send/route.ts` (POST registra, GET lista) |
| Serviço da rota | `src/services/chatwoot/envioChatwoot.ts` |
| Passada e laço | `consumidorEnvioChatwoot.ts`, `consumidorEnvioChatwootSupabase.ts`, `workerEnvioChatwoot.ts` |
| Processo | `npm run worker:envio` (`scripts/worker-envio-chatwoot.ts`) |
| Tela | `src/components/mensageria/useEnvio.ts`, `MensageriaDesktop.tsx` |

## 2. Regras

**Identidade.** `commandId` é um UUID gerado pelo navegador antes da rede e
reutilizado em qualquer repetição. Única por organização + `commandId`. O digest é
`sha256(conversa_local + "\n" + texto)`, calculado no banco.

| Pedido | Resultado | HTTP |
|---|---|---|
| comando novo | `registrado`: intenção + evento `pending` | 202 `pendente` |
| mesmo comando, mesmo texto e conversa | `existente`: a mesma intenção, no estado atual | 202 `duplicado: true` |
| mesmo comando, outro texto ou conversa | `conflito`, nada gravado | 409 `comando_divergente` |
| conversa de outra organização ou inexistente | `conversa_inexistente` | 404 |
| conexão desligada ou ausente | `conexao_indisponivel`, nada gravado | 409 |
| pessoa sem vínculo | `sem_vinculo` | 403 |
| banco fora | nada gravado, nada enviado | 503 |

A organização e o autor vêm da sessão; conexão e id remoto, da conversa local.
Capacidade exigida: `organization:access` (qualquer membro). Uma capacidade
própria de atendimento é decisão pendente.

**Despacho.** Só intenções desta tabela são reivindicadas: o backlog do envio
inline (evento `message.send` sem intenção) nunca é. Antes da rede o worker
reconfere o vínculo do autor e a conexão; sem eles, recusa (`autor_sem_vinculo`,
`nao_configurado`) sem enviar. O desfecho vem de `desfechoDoEnvioChatwoot` (MSG-007):

| Resposta | Estado | Mensagem espelhada |
|---|---|---|
| 2xx com id | `sent` (recibo) | criada na mesma transação, com `envio_id` |
| 4xx | `dead_letter` | não |
| timeout, conexão caída, 2xx inválido, 429, 5xx, exceção | `unknown` | não |
| queda antes de gravar o desfecho | `in_flight` → reaper → `unknown` | não |
| recibo com a lease vencida | recusado pelo fencing; reaper → `unknown` | não |

`unknown` nunca é reivindicado de novo. Sai só pela reconciliação do MSG-007
(`POST /api/integracoes/outbox/[eventoId]`). O Chatwoot não oferece busca por chave
de correlação: casar por texto ou horário não é prova.

**Resposta própria.** O webhook da mensagem enviada chega como `outgoing` de `user`:
o consumidor da inbox (MSG-006) não abre caso e não grava outra linha. Se ele chegar
antes da confirmação, a confirmação só acrescenta `envio_id` à linha existente.

**Um modo por tenant.** O envio inline foi removido: não há mais POST ao Chatwoot
na requisição. Com o worker desligado, as respostas ficam `pendente`.

## 3. Matriz aplicação × banco

| Aplicação \ Banco | Banco sem a 90 | Banco com a 90 |
|---|---|---|
| **App anterior** (inline, MSG-007) | estado atual | o inline continua funcionando e cria eventos sem intenção, que o worker novo nunca reivindica. O worker não roda com o app anterior. |
| **App novo** | `registrar_envio_chatwoot` não existe: a rota responde 503 **antes** de qualquer efeito. Fail closed. | comportamento alvo |

Ordem: **banco primeiro, aplicação depois, worker por último**, cada um com
autorização própria.

## 4. Implantação (nada executado nesta sessão)

1. Inventário do envio inline (somente leitura):
   ```sql
   select o.status, o.motivo_bloqueio, count(*)
     from public.outbox_eventos o
    where o.destination = 'chatwoot' and o.event_type = 'message.send'
      and not exists (select 1 from public.chatwoot_envios e where e.outbox_evento_id = o.id)
    group by 1, 2 order by 1, 2;
   ```
   `pending`/`failed_transient` aqui são envios inline que podem ter saído. Seguem
   a quarentena do runbook MSG-007 §4, nunca um worker.
2. Aplicar a 90 (`lock_timeout = 5s`): cria tabela, coluna nullable, índices e
   funções. O `ALTER` em `chatwoot_messages` pede lock breve; sem backfill.
3. Deploy da aplicação.
4. Ligar o worker só com autorização, com `CHATWOOT_SEND_WORKER_BACKLOG_DESDE` igual
   ao fim do deploy (UTC). Intenção registrada antes do corte não sai.
5. Verificação pós-aplicação (somente leitura):
   ```sql
   select has_table_privilege('authenticated', 'public.chatwoot_envios', 'select');      -- false
   select has_function_privilege('authenticated',
          'public.registrar_envio_chatwoot(uuid,uuid,uuid,uuid,text)', 'execute');        -- false
   select count(*) from public.chatwoot_envios;                                           -- 0 antes do deploy
   ```

## 5. Recuperação (forward-only)

- **Parar o despacho:** `CHATWOOT_SEND_WORKER_ENABLED=false` e reiniciar o processo.
  As intenções ficam `pending`; nada se perde. A conexão desligada (PRE-008) também
  faz o worker recusar antes da rede.
- **Nunca** voltar ao envio inline em paralelo, mapear `unknown` para `pending`
  fora do replay autorizado, ou repetir o POST como recuperação.
- **Rollback da aplicação** sobre o banco com a 90: o inline anterior volta a
  funcionar e o worker tem de estar parado (um modo por tenant). As intenções
  pendentes do app novo continuam lá e saem quando o worker voltar, a partir do corte.
- **Falha da migration:** é uma transação; a autoverificação aborta se a superfície
  ficar exposta ao navegador.

## 6. Matriz de 17 falhas (02-arquitetura.md)

| # | Caso | Prova |
|---|---|---|
| 1 | Antes do envio | consumidor: falha ao ler vínculo/credencial → `NaoEnviado` sem POST; pgTAP 51 (recusa antes do despacho) |
| 2 | Recusa definitiva | consumidor 422/401; prova real (conversa desconhecida pelo Chatwoot → `dead_letter`); pgTAP 51-52 |
| 3 | Timeout | consumidor; pgTAP 43-46 |
| 4 | ACK perdido | consumidor; **prova real**: o Chatwoot aplicou, o intermediário derrubou a resposta → `unknown`, 1 mensagem, sem reenvio |
| 5 | 2xx inválido | consumidor; **prova real** com 2xx sem id depois do efeito |
| 6 | 429 | consumidor (`limite_sem_prova`, sem retry) |
| 7 | 5xx | consumidor |
| 8 | Retry automático | só `NaoEnviado` volta à fila (MSG-007); unknown não é reivindicado (pgTAP 46; ensaio 5) |
| 9 | Retry humano | mesmo `commandId` → mesma intenção (rota, pgTAP 11 e 47, prova real); a tela só oferece "Tentar de novo" sem resposta do servidor |
| 10 | Crash depois do efeito | consumidor (sem desfecho gravado); ensaio 5 (processo morto em voo → `unknown`) |
| 11 | Crash antes do commit | ensaio 3 (registro) |
| 12 | Duplicata | ensaios 1-2 (8 pedidos simultâneos); pgTAP 11-15 |
| 13 | Fora de ordem | webhook da própria resposta antes ou depois da confirmação (pgTAP 37-42) |
| 14 | Atrasado | recibo com lease vencida (pgTAP 48-50; ensaio 6). `control_version` é do MSG-009 |
| 15 | Webhook repetido | dedup da inbox (MSG-005); resposta própria não duplica a linha (pgTAP 39, 41; prova real) |
| 16 | Compensação | **não se aplica**: não há comando compensatório; mensagem enviada não é "desfeita" |
| 17 | Reconciliação | a do MSG-007, sem mudança; consulta pelo GET mostra o motivo sem oferecer reenvio |

## 7. Contraprovas

| Sabotagem | Falha observada |
|---|---|
| Claim sem o filtro de intenção | o backlog inline é reivindicado (ensaio de concorrência, revertido) |
| Rota antiga (inline, `Date.now()`) | 8 testes vermelhos em `send/comando.test.ts` antes da troca |

## 8. Limites e riscos

- O worker usa `service_role`, que **não** é restrito pelo banco: o adapter só chama
  as funções acima, mas a chave alcança tudo. Um papel próprio exigiria também uma
  função para ler a credencial cifrada da conexão; fica como decisão.
- `chatwoot_envios.conteudo` guarda o texto da resposta sem TTL próprio: a retenção
  entra no MSG-021.
- Sem `control_version` (MSG-009): um envio já reivindicado sai mesmo que a conversa
  tenha sido assumida depois.
- A reconciliação do `unknown` continua manual e sem tela própria (MSG-007/MSG-020).
- Processo do worker com `ts-node`: serve para DEV; supervisão é do MSG-020.
