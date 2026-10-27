# Efeito ambíguo na outbox (MSG-007) — migration 86

A outbox passa a distinguir quatro desfechos de um despacho: **não enviado**
(com prova), **recusado**, **confirmado** (com recibo do provedor) e
**desconhecido** (`unknown`). Timeout, ACK perdido, resposta inválida ou 2xx
inválido, 5xx, 429 sem prova e falha depois do despacho nunca provam que o
efeito não aconteceu: todos viram `unknown`, que não tem retry automático e só
sai por reconciliação com recibo ou por replay autorizado depois de provada a
não aplicação.

Arquivo `database/86_efeito_ambiguo_na_outbox.sql`, ordem 89 do ledger, logo
depois de `85_identidade_local_chatwoot.sql` (88). Empilhado sobre o MSG-003B.

## 1. Estado anterior (medido na cadeia 01–85 e no código de `6dff145`)

| Objeto | Antes | Risco |
|---|---|---|
| `outbox_eventos.status` | `pending/processing/sent/failed_transient/dead_letter` | não existe "pode ter acontecido" |
| `concluir_evento_outbox` (48) | aceita `sent` sem recibo; posse = `lease_owner` + expiração | `sent` inventado; worker que reusa o id depois de perder a lease é indistinguível do dono |
| `classifyError` (app) | substring decide `failed_transient` para `timeout`, `ECONNRESET`, 5xx, 429 | POST de criação repetido = mensagem duplicada |
| `liberar_leases_expirados_outbox` (48) | `processing` vencido → `failed_transient` | despacho que saiu é reenviado |
| `POST /api/chatwoot/send` | envia e depois marca numa tabela inexistente (`eventos_outbox`) | todo envio inline fica `pending` já despachado; a rota responde 500 depois de enviar |
| `registrar_evento_outbox` | chave repetida devolve o evento antigo, mesmo com outro payload | intenção trocada em silêncio |

## 2. O que muda

- Estados novos `in_flight` (despacho iniciado) e `unknown`; colunas de fencing,
  recibo, confirmação, motivo, resolução e replay; tabela `outbox_tentativas`
  (uma linha por despacho, FK composta por organização, só `service_role`).
- Máquina de estados imposta por gatilho (`fn_outbox_evento_transicao`), inclusive
  para o `service_role`: `sent` só de `in_flight` com recibo ou de `unknown` por
  reconciliação com recibo; `unknown` só sai para `sent` (reconciliação) ou
  `pending` (replay depois de `provado_nao_aplicado`); `sent` e `dead_letter` não
  regridem; intenção imutável; o gatilho sobe o fencing token a cada claim.
- RPCs (só `service_role`): `reivindicar_tentativas_outbox`,
  `reivindicar_evento_outbox`, `iniciar_despacho_outbox`,
  `concluir_tentativa_outbox`, `liberar_leases_expirados_outbox` (redefinida),
  `resolver_evento_desconhecido_outbox`, `autorizar_replay_outbox`;
  `registrar_evento_outbox` recusa a mesma chave com outra intenção (`23505`).
- Saem `concluir_evento_outbox(…7 args)` e `reivindicar_lote_outbox(text,int,int)`.
- Backfill: `sent` antigo → `confirmacao = 'legado_pre_msg007'` (com o `id` da
  resposta quando havia); envio inline do Chatwoot `pending/processing/failed_transient`
  → `unknown` com motivo `envio_inline_legado`.
- App: worker e rota inline seguem o mesmo protocolo (claim → `in_flight` →
  provedor → desfecho por CAS); o desfecho do Chatwoot é tipado
  (`desfechoDoEnvioChatwoot`); a rota responde **202 `desfecho: 'desconhecido'`**
  quando não há recibo gravado, e a tela marca "Entrega não confirmada" sem
  oferecer reenvio. Integrações ganha "Envios que exigem atenção"
  (`GET /api/integracoes/outbox`, membros da organização da sessão) e a decisão
  `POST /api/integracoes/outbox/[eventoId]` (`organization:manage`; o banco
  confere owner/admin de novo).
- Auditoria: `outbox.effect_unknown` (sistema), `outbox.effect_reconciled`,
  `outbox.replay_authorized`, `outbox.replay_refused` (pessoa). Metadata sem
  payload, conteúdo, recibo nem evidência.

## 3. Matriz aplicação × banco

| Aplicação \ Banco | Banco sem a 86 | Banco com a 86 |
|---|---|---|
| **App anterior** | estado atual (defeitos da seção 1) | o envio inline chama `enqueue` (ok), envia e falha em `markSent` como hoje (tabela inexistente) → o evento fica `pending` já despachado. Nenhum worker roda em produção, então nada reenvia; mas esse `pending` precisa da quarentena da seção 4. As funções legadas não existem: qualquer chamada a `concluir_evento_outbox` falha (`42883`) — fail closed. |
| **App novo** | `reivindicar_evento_outbox` não existe → a rota falha **antes** de chamar o Chatwoot (500, nada enviado). Fail closed. | comportamento alvo |

Ordem obrigatória: **banco primeiro, aplicação logo depois**, e a quarentena da
seção 4 depois do deploy da aplicação.

## 4. Implantação (não executada nesta sessão)

Nada aqui foi aplicado em banco remoto. Aplicar exige autorização explícita.

1. Pré-checagem (read-only):
   ```sql
   select status, destination, event_type, count(*) from public.outbox_eventos group by 1, 2, 3 order by 1, 2, 3;
   select count(*) from public.outbox_eventos where status = 'sent' and response_body ? 'id';
   ```
2. Aplicar a 86 numa transação (`lock_timeout = 5s`; `ACCESS EXCLUSIVE` breve em
   `outbox_eventos` para o `ALTER`/CHECK; a tabela é pequena). Se o lock não vier
   em 5 s, a migration aborta inteira — reexecutar fora de pico.
3. Deploy da aplicação.
4. Quarentena da janela entre 2 e 3 (envios do app anterior que ficaram `pending`
   já despachados). Substituir `<fim_do_deploy>` pelo horário UTC do deploy:
   ```sql
   begin;
   -- 1. claim (o gatilho sobe o token), 2. despacho que já aconteceu, 3. desconhecido.
   update public.outbox_eventos
      set status = 'processing', lease_owner = 'quarentena-msg007', lease_expires_at = now() + interval '5 minutes'
    where destination = 'chatwoot' and event_type = 'message.send'
      and status = 'pending' and fencing_token = 0 and created_at < '<fim_do_deploy>';
   update public.outbox_eventos set status = 'in_flight', despachado_em = created_at
    where status = 'processing' and lease_owner = 'quarentena-msg007';
   update public.outbox_eventos
      set status = 'unknown', motivo_bloqueio = 'envio_inline_legado', desconhecido_em = now(),
          lease_owner = null, lease_expires_at = null
    where status = 'in_flight' and lease_owner = 'quarentena-msg007';
   -- conferir que as três contagens são iguais antes do commit
   commit;
   ```
   As três instruções passam só por transições que o gatilho admite (ensaiado no
   laboratório: 1/1/1 linha, evento final `unknown` com token 1). Nenhum gatilho
   é desligado.
5. Verificação pós-aplicação (read-only):
   ```sql
   select count(*) as inline_elegiveis from public.outbox_eventos
    where destination = 'chatwoot' and event_type = 'message.send' and status in ('pending', 'failed_transient')
      and fencing_token = 0;                                                  -- esperado 0
   select count(*) from public.outbox_eventos where status = 'sent' and confirmacao is null;   -- 0
   select to_regprocedure('public.concluir_evento_outbox(uuid,text,text,jsonb,text,text,integer)');  -- null
   select has_table_privilege('authenticated', 'public.outbox_tentativas', 'SELECT');          -- false
   ```

## 5. Recuperação (forward-only)

- **Nunca** mapear `unknown` para `pending`, nem restaurar as funções legadas,
  nem "repetir o POST" como recuperação: é exatamente o retry inseguro fechado aqui.
- Desligar o despacho sem reverter schema: desligar a conexão Chatwoot da
  organização (PRE-008); a rota inline passa a recusar a partir do claim
  (`nao_configurado`, nada enviado). Não há worker de produção para parar.
- Falha da migration: ela é uma transação; a autoverificação aborta tudo. Medido:
  falha injetada no meio deixa nenhum objeto novo, nenhuma função removida e
  nenhum status mudado (`efeito_ambiguo_na_outbox_backfill.test.sql` 1-3).
- Defeito na aplicação nova: corrigir para frente. Voltar para o app anterior
  sobre o banco novo é seguro só no sentido de não reenviar (seção 3); exige
  repetir a quarentena da seção 4 depois.
- Reconciliar um `unknown` (pessoa owner/admin): conferir no Chatwoot a conversa
  e decidir pela API — `{"acao":"reconciliar","resolucao":"confirmado","reciboRef":"<id exato da mensagem>"}`,
  ou `provado_nao_aplicado` com evidência (≥ 10 caracteres, sem dado do cliente),
  ou `revisao_manual`. Só depois de `provado_nao_aplicado`, `{"acao":"replay"}`.
  O Chatwoot não oferece busca por chave de correlação: casar por texto/horário
  não é prova, e a ambiguidade fica com humano.

## 6. Matriz de 17 falhas (02-arquitetura.md) — onde cada caso é provado

| # | Caso | Prova |
|---|---|---|
| 1 | Antes do envio | `matrizDeFalhas.test.ts` 1 (retry da mesma intenção, tokens 1-2-3, limite → dead_letter); pgTAP 7, 15a (claim vencido sem despacho volta à fila), 24-25 |
| 2 | Recusa definitiva | matriz 2; pgTAP 26-27; rota `uuid-local.test.ts` (422) |
| 3 | Timeout | matriz 3 (efeito aplicado, um único despacho); rota 202 |
| 4 | ACK perdido | matriz 4; pgTAP 1-6; rota 202 |
| 5 | 2xx inválido | matriz 5 (inclusive "confirmado" sem recibo); worker; pgTAP 8; rota 202 |
| 6 | 429 | matriz 6 (sem prova → unknown; com prova documentada → Retry-After honrado); serviço (`p_retry_delay_sec`) |
| 7 | 5xx | matriz 7; rota 202 |
| 8 | Retry automático | matriz 8 (allowlist de desfechos); pgTAP 2-3, 24-25 |
| 9 | Retry humano | matriz 9; pgTAP 34-42; rotas `outbox.test.ts`; tela `EnviosComAtencao.test.tsx` e mensageria ("Entrega não confirmada" sem "Recuperar texto") |
| 10 | Crash depois do efeito | matriz 10; pgTAP 19-23; ensaio de concorrência 2 |
| 11 | Crash antes do commit | matriz 11 (falha ao gravar `in_flight` → nada enviado); pgTAP 46-49; backfill 1-3 |
| 12 | Duplicata | matriz 12; pgTAP 30-31; ensaio 1 (lotes disjuntos) e 3 (replay duplo → 55000) |
| 13 | Fora de ordem | matriz 13; pgTAP 12, 27, 45 |
| 14 | Atrasado | matriz 14; pgTAP 15-18; ensaio 4. `control_version` é do MSG-009 |
| 15 | Webhook repetido | **não se aplica**: a outbox não consome webhooks; dedup de entrega é da inbox (MSG-005) |
| 16 | Compensação | **não se aplica**: não há comando compensatório nesta fatia; provado que nenhuma "reversão" leva `unknown` a `pending` (pgTAP 5-6) |
| 17 | Reconciliação | matriz 17; pgTAP 39, 43-45; rotas `outbox.test.ts` |

Cross-tenant: pgTAP 36-37, 52-53, 60-62; rotas (organização só da sessão,
404 fora do escopo). Sem capability: pgTAP 35; rotas (403 antes de tocar o banco).

## 7. Contraprovas medidas (laboratório local, `supabase test db`)

| Sabotagem | Falha |
|---|---|
| Conclusão e início do despacho sem comparar o fencing token | pgTAP 16-18; ensaio de concorrência detecta o token antigo devolvendo à fila um despacho em voo |
| Sem `ck_outbox_eventos_sent_confirmado` e com `sent` aceito de qualquer estado | pgTAP 10-11 |
| Reaper devolvendo `in_flight` vencido à fila | pgTAP 20-22 |
| `desfechoDoEnvioChatwoot` tratando timeout como não enviado | matriz 3, 8, 9; rota "timeout" |
| Validação do desfecho aceitando recibo vazio | matriz 5; worker "outside the contract" |

Restaurar: reaplicar a 86 (idempotente na mesma transação) e o arquivo original.

## 8. Limites e riscos

- O envio continua inline na requisição; o consumidor real é do MSG-008. A
  identidade da intenção ainda nasce de `Date.now()` na rota: um reenvio humano
  depois de `unknown` cria outra intenção. A tela não oferece esse reenvio, mas
  o MSG-008 precisa do `command_id` vindo do navegador.
- Lease do envio inline: 60 s; timeout do adapter: 10 s. Se a conclusão chegar
  depois da lease, o recibo não é gravado e o evento fica `unknown` até o reaper
  (nenhum worker de produção o chama hoje) ou a reconciliação.
- A reconciliação é manual (API; a tela só autoriza o replay). Não há UI para
  registrar recibo/evidência nesta fatia.
- `outbox_tentativas` não tem TTL próprio (segue o evento).
