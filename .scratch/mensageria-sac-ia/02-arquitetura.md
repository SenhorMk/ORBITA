# Arquitetura proposta — mensageria, SAC e IA

**Status: proposed, aguardando revisão da proprietária.** Baseline e achados: [01-baseline-e-evidencias.md](01-baseline-e-evidencias.md). Nenhuma decisão aqui constitui autorização para implantação.

## ADR recomendado

Manter ORBITA como autoridade de domínio e Chatwoot como cockpit e adaptador do canal. Evoluir a inbox/outbox PostgreSQL existente para processamento transacional com um worker explícito, resultados ambíguos persistidos e reconciliação. Usar AI SDK dentro do stack Next.js atual para interpretação estruturada e tools somente leitura. Não introduzir Eve, broker adicional ou Workflow no MVP.

O custo aceito é operar um pequeno processo worker e implementar corretamente leases, fairness e reconciliação. Isso evita duplicar persistência e conserva atomicidade com o banco operacional já usado pelo ORBITA. Redis/Sidekiq pertencem à instalação Chatwoot; não serão usados como fila de domínio ORBITA.

### Comparação das opções

| Critério | A — PostgreSQL existente, recomendado | B — Vercel Queues | C — Vercel Workflow |
|---|---|---|---|
| Durabilidade | Commit no mesmo banco de domínio; exige backup/restore e consumidor real | Serviço gerenciado, entrega at-least-once | Steps e retomada duráveis; persistência/runtime próprios |
| Atomicidade domínio/publicação | Uma transação entre estado e outbox | Ainda exige outbox/relay para fechar dual write Postgres→queue | Início do workflow e domínio continuam exigindo reconciliação/ponte |
| Retry/crash | Leases, fencing e classificação explícita a evoluir | Retry e visibilidade gerenciados, consumidor idempotente | Replay/steps ajudam orquestração; efeito externo continua precisando idempotência |
| Ordering/dedup | Unique por escopo e sequência por agregado; não confiar em ordem global | Sem FIFO estrito; dedup tem horizonte limitado | Ordem de steps não ordena todos os eventos externos |
| Esperas longas | Estado persistido e `available_at`; nenhuma conexão aberta | Retenção máxima atual de 7 dias; não usar como registro do caso | Adequado a hooks/sleep/aprovações longas |
| Observabilidade | Reaproveita logger/auditoria; painel operacional necessário | Dashboard gerenciado, sem substituir trilha do domínio | Inspeção de runs; dados e custos precisam política de privacidade |
| Local/testes | PostgreSQL descartável, fake provider, relógio controlado | Integração de serviço/autenticação Vercel a validar | Runtime local e testes específicos; novo compilador/SDK |
| Custo | Compute do worker + I/O/armazenamento DB + operação | Operações e compute; payload cobrado por blocos de 4 KiB | Compute/operações/runtime conforme backend escolhido |
| Lock-in | SQL/RPC PostgreSQL; integração Supabase já existente | API/entrega Vercel | SDK/runtime e estratégia de persistência |
| Decisão | Usar no MVP | Reavaliar se carga/operabilidade justificar; nunca segunda fila por conveniência | Reavaliar quando orquestrações excederem a clareza das máquinas de estado |

Limites e cobrança Queues foram conferidos em [Pricing and Limits](https://vercel.com/docs/queues/pricing); a página de visão geral ainda traz trechos de TTL antigo, portanto prevaleceu a página de limites e o [changelog de 7 dias](https://vercel.com/changelog/queues-now-supports-7-day-ttl). [Workflow e idempotência](https://workflow-sdk.dev/docs/foundations/idempotency) não autorizam presumir exactly-once de uma chamada de negócio externa.

### Runtime escolhido

DEV: worker Node/TypeScript do mesmo repositório, processo separado do Next, com polling de 1 s quando ativo e backoff até 5 s ocioso. Demo compartilhada/piloto: um serviço/container supervisionado na mesma região do Postgres, independente de instâncias efêmeras Next/Vercel. Escopo do processo é inbox/outbox e tarefas de IA tipadas; nenhuma fila em memória é autoridade. Começar com concorrência pequena e rate limit por conexão/organização; `SKIP LOCKED` não pode permitir dois comandos conflitantes da mesma conversa.

Readiness verifica conectividade/schema compatível; heartbeat mede atividade. Shutdown para novos claims e termina ou abandona leases de forma controlada. Cron pode ser watchdog, não consumidor principal de uma experiência conversacional. O worker chama ports de aplicação já existentes, não endpoints públicos para contornar autenticação. Credencial específica de worker com RPCs mínimos é preferida; qualquer uso transitório de service role exige escopo verificado explícito e allowlist de operações.

Trabalhos internos de triagem/visão serão tipos explícitos na outbox existente (destino interno validado por schema e allowlist), consumidos pelo mesmo runtime; `ai_runs` guarda resultados e uso, não uma segunda fila. Leitura de tools/geração ocorre fora da transação; publicação do resultado revalida versão do caso/controle e grava mensagem/proposta+outbox atomicamente. Uma geração pode ser repetida e gerar custo após crash; dedup da resposta e orçamento precisam cobrir essa possibilidade. Não transformar toda geração em UNKNOWN financeiro, nem permitir que replay de geração repita envio ao cliente.

Metas propostas para o piloto: ACK p95 <1 s após commit da inbox; idade da mensagem elegível p95 <5 s; resposta de texto p95 <15 s, incluindo IA; alertar backlog elegível >30 s por 5 min. São critérios de validação, não capacidade já medida. Lease inicial 60 s com heartbeat a cada 15 s; timeout de provider menor que lease; token monotônico por claim. Efeito em voo com lease vencido vira UNKNOWN e vai à reconciliação, não a reenvio cego.

## Diagrama e fronteiras

```text
WhatsApp Cloud API oficial (Meta)
  → Chatwoot CE (canal, cockpit e entrega)
  → webhook ORBITA (raw-body HMAC + vínculo da conexão)
  → inbox_eventos_chatwoot durável → ACK
  → worker / transação: mensagem + conversa + caso + conclusão inbox + trabalho derivado
  → controlador de atendimento (IA/HUMANO + versão)
  → triagem estruturada / AI SDK
  → tools de consulta autorizadas → dados minimizados + frescor + referências
  → proposta versionada → política determinística → aprovação humana ORBITA
  → comando de domínio (futuro) → estado + outbox na mesma transação
  → worker de efeitos → Chatwoot / Bling / PSP
  → confirmação OU UNKNOWN → reconciliação
```

| Capacidade | Responsabilidade / API pública mínima | Fronteira existente/proposta |
|---|---|---|
| Mensageria | Receber mensagens, identidade externa, conversas, autoria, exclusão/edição, controle de atendimento | Evoluir `services/chatwoot`, `chatwootInboxService` e espelhos; domínio futuro `modules/mensageria` apenas quando a primeira fatia justificar |
| SAC | Motivo, vínculo confirmado com pedido, política, caso e resolução; não guarda segredo de provider | Novo domínio/application, API `openCase`, `recordTriage`, `proposeResolution`, `decideProposal` |
| IA | Contexto minimizado, classificação, extração, resumo, explicação de candidatos; orçamento e validação de saída | Adapter AI SDK e port de tarefas; não importar Supabase/SDK no domínio |
| Consulta operacional | Autorizar escopo e cliente, retornar DTOs estreitos de pedidos, financeiro, catálogo, estoque e rastreio | Ports sobre services/repositories existentes, sem expor `.select('*')` ao modelo |
| Efeitos duráveis | Identidade, tentativas, transporte, lease, UNKNOWN, replay e reconciliação | Evoluir `outboxService`/worker; regras da troca pertencem ao SAC, não à fila |
| Trocas | Quantidade elegível, pedido original imutável, substituto e bloqueio de fulfillment | Novo agregado com ports para pedidos/estoque/pagamento |
| Pagamentos do lojista | Intenção de cobrança, liquidação, estorno, prova assinada, reconciliação | Separado do billing Stripe de assinaturas ORBITA |
| Evidências | Quarentena, varredura, MIME, storage privado, acesso/retencão | Estender infraestrutura de privacidade; não reutilizar bucket público de imagens de produto |
| Chatwoot adapter | API messages, notes, assignee/team, labels/attributes; traduz status externo | Não decide aprovação, saldo, política, preço ou autorização |

Nenhum movimento em massa de pastas. Ports públicos estreitos e composition explícita; imports cruzados só por API pública quando o módulo for criado. Nas telas ORBITA, decisões e status vêm de API autenticada; React não calcula autorização. Confirmar ações, estados de erro e conflitos de versão de forma acessível; não construir um segundo cockpit completo.

## Glossário e autoridade

**Organização** é o tenant verificado. **Conexão** é o vínculo com uma instância/conta de provider. **Conversa** é a interação persistida ORBITA; pode ter casos SAC distintos ao longo do tempo. **Mensagem** é um evento de comunicação com autoria e proveniência. **Caso SAC** registra uma necessidade do cliente. **Proposta** é uma versão imutável de resolução candidata. **Aprovação** autoriza exatamente uma versão e escopo. **Comando** é uma intenção de negócio determinística. **Efeito** é uma chamada externa observável; uma tentativa pode terminar sem sabermos se ocorreu.

ORBITA é fonte da verdade do caso, autorização, aprovação e orquestração. Dados importados de estoque/pagamento/Bling são projeções com fonte e timestamp, não fatos instantâneos garantidos. IA nunca lê memória de conversa como saldo/preço atual. Pagamento confirmado exige evidência verificável do PSP, não texto do cliente ou status editado no cockpit.

## Modelo de dados proposto — sem SQL

Nomes novos são propostas de domínio; preservar nomes existentes quando o propósito coincide. Tabelas crescem por fatias, nunca numa migration única.

| Entidade | Chaves/relações e campos essenciais | Invariantes/índices |
|---|---|---|
| `conexoes_integracao` / `chatwoot_inboxes` existentes | organização, conexão, instance/account/inbox externo, canal, status, referência de segredo cifrado | Identidade externa única por instância+account+inbox; tenant só de vínculo verificado; segredo não trafega em mensagens |
| `chatwoot_contacts/conversations/messages` evoluídas | UUID local canônico; id externo como texto; organização+conexão; FKs locais; preservar legado durante expand/contract | Unique organização+conexão+external_id; FKs compostas com organização; contas/instâncias sem colisão; não confiar em casts numéricos inseguros |
| Conversa canônica (colunas ou extensão 1:1) | ownership_mode, wait_reason, assigned_actor/team, control_version, last_inbound_seq, customer_ref verificado, verification_level | Uma autoridade de resposta por vez; CAS na versão; tenant e cliente não podem ser trocados pelo LLM |
| Mensagem canônica | direction, author_kind, provider_message_id, command_id, dedup_key, content_ref, message_type, occurred_at, received_at, status, revision | Unique por conexão+id externo; revisões separadas; outgoing próprio nunca dispara inbound humano; timestamps externos não ordenam sozinhos |
| `sac_cases` | UUID, organização, conversa, customer_ref/order_ref opcionais até verificação, reason, phase, version, policy_version | Não vincular pedido de outro cliente/tenant; índice org+phase+updated_at; um caso não apaga pedido |
| `resolution_proposals` | case_id, version, type, itens/quantidades, preço/moeda em unidade mínima, diferença, candidato, bases de estoque/preço, validade, policy_version, digest | Imutável por versão; edição gera nova versão e invalida aprovações; delta calculado pelo servidor |
| `sac_approvals` | proposal_id/version/digest, actor, capability, decisão, motivo, approved_at, expires_at | Unique decisão válida da versão; usuário externo/label não aprova; auditar tentativa negada |
| `sac_actions` / `external_effects` | command_id, org, case, proposal_version, kind, idempotency_key, payload_digest, expected_version, state, provider_ref | Unique org+command_key; mesma chave com payload diferente → conflito; estado UNKNOWN bloqueia nova criação |
| `effect_attempts` | effect_id, attempt_no, claim_token, sent_at, deadline, response_class, provider_ref, reconciliation_evidence | Append-only; sem tokens/payload cru; efeito confirmado não volta a pending |
| Inboxes existentes | org+conexão+delivery_id quando existir; event_key/revision, schema_version, content_hash, status, lease_token, available_at | Duas dedups: entrega e evento semântico. Evento inválido não altera domínio; commit precede ACK; retenção mantém tombstones |
| `outbox_eventos` existente | command/effect_id, aggregate_id/version, destination, available_at, correlation, lease, outcome tipado | Estado de domínio+outbox atômicos; índice parcial elegíveis; CAS/fencing na conclusão; UNKNOWN não é failed_transient |
| `ai_runs` | org, conversa/caso, input_message_revision, snapshot/control_version, prompt/schema/model/provider, usage, cost, status, output_ref | Chave única do processamento lógico; resultado atrasado obsoleto não envia; contexto e saída com acesso/retencão restritos |
| `attachments` / `evidence` | org, message/case, storage_key, hash, MIME real/declarado, bytes, scan_status, retention_until, deleted_at, vision_run_id | Bucket privado; autorização por owner lógico; download/visão só após clean; sem URL assinada persistida como identidade |
| `exchange_cases/items` | original_order/item, quantidade, proposta, replacement_order_id, execution_phase | Soma de trocas ativas/concluídas não supera elegibilidade por item; original preservado; lock transacional por item |
| `return_items/inspections` | exchange_item, quantity_expected/received, custody_state, inspector, disposition, inventory_movement_id | Recebimento não aumenta disponível; disposição única por quantidade; movimentos únicos e auditados |
| `payment_intents/events/allocations` do lojista | org+merchant_connection, case/proposal, amount/currency, provider_id, event_id, status, paid_amount | Webhook assinado e account binding; unique provider event; soma/quantia/moeda conferidas; refund/chargeback não tratado como paid |
| Pedido substituto / `fulfillment_authorizations` | proposta aprovada, reservation_id, payment_requirement, settlement_ref, policy_version, fulfillment_blocked | Permissão de emitir/enviar derivada de guard transacional, nunca booleano editável isolado; expiração/revogação invalida autorização |

Constraints de faixa para quantidade e dinheiro, moeda explícita, FKs por organização, índices de lease e org/aggregate. RLS em schema exposto, DML crítico restrito a fronteiras de comando; service role não remove obrigação de filtro. Auditoria e efeitos atômicos via RPC estreita ou transação pg; sequência de chamadas REST Supabase não é transação. [Supabase: proteger Data API](https://supabase.com/docs/guides/api/securing-your-api).

### Migração de identidade Chatwoot

Expandir UUIDs locais e chaves externas compostas sem remover legado; backfill por conexão comprovada, quarentena para mapeamento ambíguo. Migrar ingestion/sync, API de leitura/send e referências UI/Realtime para UUID local, com comparação de contagens e testes de duas instalações com mesmo id. Só depois contrair PK/FKs legadas e habilitar múltiplas instalações. Cada fase entrega um comportamento verificável com app+SQL+contratos; rollback anterior ao contract usa compatibility path, depois exige avanço corretivo. Nada desse backfill será executado nesta sessão.

## Máquinas de estado coerentes

Separar eixos evita misturar quem atende, por que espera, execução e logística num enum de 20 valores.

**Atendimento:** `AI | HUMAN_REQUIRED | HUMAN`. `wait_reason` independente: `NONE | CUSTOMER | APPROVAL | PAYMENT | EXTERNAL`. Assumir/informar mensagem humana incrementa control_version e revoga autorização de respostas pendentes da IA. Devolver à IA é ação explícita autorizada. Labels Chatwoot são projeções; alterações no cockpit só viram pedidos validados, nunca grants.

**Caso:** `TRIAGE → COLLECTING_INFORMATION → IDENTIFIED → RESOLUTION_PROPOSED → RESOLUTION_ACCEPTED → EXECUTING → RESOLVED → CLOSED`. Pode sair de TRIAGE para IDENTIFIED quando dados bastam; proposta rejeitada/expirada volta a IDENTIFIED; recolher dados não apaga evidências; `CANCELLED` termina caso sem apagar histórico. Reabrir CLOSED cria novo caso ligado ao anterior. `RESOLVED` exige obrigações concluídas ou dispensa formal auditada, não apenas mensagem enviada.

**Proposta:** `DRAFT → PROPOSED → APPROVED | REJECTED | EXPIRED | SUPERSEDED`. Aprovação requer pessoa/capacidade e digest atuais; quando política autorizar no futuro, registrar policy decision como ator de sistema, sem atribuir a um owner humano fictício.

**Troca:** `APPROVED → RESERVING → RESERVED → WAITING_PAYMENT (se delta>0) → READY_TO_EXECUTE → EXECUTING → COMPLETED`. Falhas permanentes levam a `NEEDS_REVIEW`; ambíguas mantêm `RECONCILIATION_REQUIRED`; expiração de reserva exige revalidar preço/estoque/aprovação. Nenhuma compensação automática cancela o pedido original. Cancelamento de rascunho libera reserva uma vez; cancelar um efeito remoto confirmado exige comando próprio.

**Retorno por item/quantidade:** `RETURN_EXPECTED → RETURN_RECEIVED → INSPECTION_PENDING → RESTOCKED | DAMAGED | DISCARDED | RETURNED_TO_SUPPLIER`. Recebimento parcial cria lotes; RESTOCKED exige inspeção aprovada e movimento único. DAMAGED não aumenta estoque vendável. Dispensar retorno exige política+aprovação explícita e razão, sem inventar recebimento.

**Pagamento:** `REQUIRED → CREATING → PENDING → CONFIRMED | FAILED | EXPIRED`; `UNKNOWN` de criação vai à reconciliação. Refund/partial_refund/dispute são registros e transições próprias; não apagar CONFIRMED histórico. Evento tardio após cancelamento vira caso operacional, não expedição automática.

**Efeito:** `PLANNED → CLAIMED → IN_FLIGHT → SUCCEEDED | REJECTED | UNKNOWN`; somente falha comprovadamente anterior ao envio ou idempotência externa documentada permite `RETRY_WAIT`. Reconciliação: `UNKNOWN → SUCCEEDED | PROVEN_NOT_APPLIED | MANUAL_REVIEW`. Consulta vazia de busca eventualmente consistente não prova ausência.

## Idempotência e concorrência

Inbound: verificar HMAC sobre bytes originais e timestamp antes de efeitos; limitar body e validar schema/account/inbox. `delivery_id` pode faltar: usar chave semântica versionada, nunca apenas hash de JSON não canônico. Created usa conexão+message id; updated inclui revision/provider updated_at e digest estável do subconjunto relevante. Eventos de estado repetidos não podem ser confundidos com mesma ocorrência. Preservar tombstone para delete impedir ressurreição por evento atrasado.

Transação de consumo trava agregado/versão e grava efeito local, auditoria, trabalho derivado e conclusão inbox juntos. Registrar evento com `INSERT ... ON CONFLICT`, não read-then-insert sujeito a corrida. Mensagem anterior em retry impede execução conflitante posterior; eventos de dados podem ser reordenados por versão ou reconciliados com snapshot fresco.

Outbound: identidade vem da intenção (`command_id`) criada antes da rede e reutilizada pelo browser no retry, não de Date.now nem do texto. Payload digest incompatível retorna 409. Não prometer exactly-once onde Chatwoot/Bling não garantem. Proveniência própria persiste command_id, message provider id, autor bot e revisão. Não usar apenas “outgoing” para distinguir atendente de bot. Private notes, activity e status não viram mensagens de cliente.

Worker reserva lote curto e só envia quando o fencing token ainda pertence a ele. Validar control_version imediatamente antes do envio; um envio já aceito pelo provider não pode ser desfeito no takeover. Registrar essa corrida residual como “resposta já em voo” visível ao atendente, bloquear todos os próximos envios. Renovar lease não autoriza repetir efeito desconhecido. Backlog do antigo envio inline deve ser reconciliado/quarentenado antes de ligar consumidor; nunca drená-lo às cegas.

## Failure matrix aplicada a cada efeito

| Falha | Estado/ação obrigatória |
|---|---|
| 1. Antes do envio | Prova de que transporte não iniciou → retry da mesma intenção com limite |
| 2. Recusa definitiva | REJECTED; erro público estável; corrigir causa, nova versão se payload mudar |
| 3. Timeout | Se pode ter enviado: UNKNOWN; reconciliar antes de repetir |
| 4. ACK perdido | UNKNOWN; buscar referência durável/recibo, não criar de novo |
| 5. 2xx inválido | UNKNOWN para criação; contrato falhou, sucesso não foi comprovado |
| 6. 429 | Honrar Retry-After; repetir só quando contrato comprova não aplicação ou chave externa protege |
| 7. 5xx | Não presumir falha sem efeito; mesma regra de UNKNOWN para POST de criação |
| 8. Retry automático | Allowlist por operação/resultado, backoff+jitter, budget e janela de validade |
| 9. Retry humano | Mesmo command_id; UI mostra UNKNOWN e não oferece “criar novamente” |
| 10. Crash depois do efeito | Tentativa durável IN_FLIGHT expirada → reconciliação; nunca pending cego |
| 11. Crash antes do commit | Transação local aborta integralmente; inbox permanece elegível; nenhum efeito antes do commit |
| 12. Duplicata | Unique/CAS devolve resultado lógico existente; auditoria de dedup sem repetir comando |
| 13. Fora de ordem | Versão/seq monotônica, predecessor ou reconciliação; não regredir terminal |
| 14. Atrasado | Conferir proposta/control_version/validade; descartar saída obsoleta, preservar evento |
| 15. Webhook repetido | Delivery dedup + semantic dedup; mesmo recibo não liquida/estoca duas vezes |
| 16. Compensação | Novo comando auditado, autorizado e idempotente; não “rollback” de HTTP |
| 17. Reconciliação | Prova com provider/ref exata, mesma conta/valor/moeda/itens; ambiguidade → humano |

| Efeito futuro | Identidade / reconciliação específica |
|---|---|
| Mensagem/private note Chatwoot | command_id + confirmação provider; usar campo de correlação somente se contrato permitir busca confiável. Sem isso, UNKNOWN requer inspeção humana, não matching por texto/horário. |
| Labels/custom attrs/assignee | Desired state com control_version; ler estado e reaplicar somente versão vigente; alteração concorrente não é “sucesso”. |
| Conta a pagar / baixa Bling | Intenções separadas. Identificador de correlação em campo documentado a validar no OpenAPI; se não existir lookup inequívoco, reconciliação manual é resultado correto. |
| Pedido substituto | Referência durável por troca+versão; aproveitar busca exata por numeroLoja da venda manual após validar contrato, não compensação automática do original. |
| Cobrança / estorno | Merchant + idempotency key oficial do PSP; confirmar evento/consulta e montante, nunca billing ORBITA como atalho. |
| Reserva / restock | RPC local transacional com movement_key única; se houver Bling, ledger local e efeito externo reconciliáveis sem dupla baixa/entrada. |
| Storage / deleção | Object key opaca estável e digest; HEAD/metadata para conciliar upload, tombstone e política de retenção para deleção. |

## Chatwoot, WhatsApp e ambientes

DEV preferido: WSL2/Linux + Docker Compose, Chatwoot CE com imagem/version/digest fixados no ticket, Rails web e Sidekiq, PostgreSQL e Redis próprios, volumes persistentes e storage de anexos separado. Não compartilhar banco Chatwoot com schema ORBITA. SMTP local opcional (captura de e-mail) e sem entrega real. Secrets fora de Git; somente exemplo sanitizado. [Guia oficial Docker](https://developers.chatwoot.com/self-hosted/deployment/docker).

Testar webhook assinado da versão instalada, não apenas fixture. Conferir problema documentado de segredo HMAC [#13809](https://github.com/chatwoot/chatwoot/issues/13809). Delivery ID é opcional segundo [guia de webhooks](https://app.chatwoot.com/hc/user-guide/articles/1677693021-how-to-use-webhooks); não inventar sua presença. Sem assinatura verificável, bloquear integração. Não modificar core Chatwoot para contornar segurança.

Registrar contratos de listagem/criação de mensagens, conversa, contato, anexos, teams, assignees, labels, custom attributes, private notes e status. Paginação, `Retry-After`, private/public, status de envio, account binding e permissões precisam fixtures da versão instalada. Quando API não oferece dedup confiável para criação, a limitação aparece no produto como pendência de reconciliação.

Expor apenas endpoints necessários para DEV via [Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/), URL efêmera, sem SLA; não expor Postgres/Redis/admin interno. O webhook de Meta aponta ao Chatwoot; webhook Chatwoot aponta ao ORBITA. Se ambos são locais, há dois destinos a tornar acessíveis. URLs devem ser atualizadas com evidência de assinatura após reinício. Quick Tunnel não é implantação permanente.

Ambiente compartilhado: Oracle Always Free é opção de laboratório, sujeito a disponibilidade/capacidade e [recolhimento de recursos ociosos](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm). Avaliar arquitetura CPU da imagem, storage e egress antes de escolher. Não condicionar MVP local a uma VPS gratuita. Staging/produção precisam DNS/HTTPS estáveis, backups cifrados externos e restore ensaiado, versionamento, métricas de workers, patching e credenciais/volumes por ambiente.

Produção/piloto externo: **Meta WhatsApp Cloud API oficial integrada ao Chatwoot**. Evolution/Baileys apenas laboratório opcional ou adapter futuro, fora do caminho crítico. Começar em inbox API/web widget para desenvolver; demo WhatsApp final exige número de teste/WABA e versão compatível. Não afirmar tarifa gratuita: validar tabela Meta por país/categoria, janela de atendimento, templates aprovados, opt-in e permissões no ticket do canal. Documentação Meta retornou 429 nesta sessão. Bloquear envio fora da janela sem template aplicável; não classificar mensagem comercial como suporte para evitar tarifa.

## IA e escolha inicial DEV

Usar AI SDK como adapter; port de aplicação por tarefas (`triage`, `summarize`, `explainCandidates`, `analyzeEvidence`) e registry de capacidades. Não criar uma interface universal enorme que finja equivalência entre providers. Configuração por organização resolve provider/model, credential_ref, capacidades aprovadas, região/retencão, limites e fallback permitido. OpenAI, Anthropic, Gemini, Groq e OpenRouter são futuros adapters; implementar apenas o caminho inicial.

Escolha inicial proposta: **Google Gemini via AI SDK e AI Gateway**, apenas dados sintéticos. O catálogo público consultado em 08/10/2026 lista `google/gemini-3.8-flash`, language, structured-output/tool-use/vision, US$0,75 por milhão de tokens de entrada e US$3,75 de saída. Fixar modelo/config por avaliação e revalidar disponibilidade antes de instalar. Catálogo não prova qualidade nem contrato de privacidade. [Catálogo consultado](https://ai-gateway.vercel.sh/v1/models).

Exemplo de dimensionamento, não orçamento aprovado: 10 mil gerações/mês × 2 mil tokens de entrada + 400 de saída = US$30/mês nessas tarifas, antes de retries, chamadas extras de tools, imagens, impostos/câmbio e outros serviços. Custo total deve somar worker, Supabase, Chatwoot/Postgres/Redis/storage/backup, egress, canal Meta e IA. Medir tokens e chamadas por caso; definir teto por organização/dia, limite por mensagem e reserva de orçamento para evitar overspend concorrente. Valores de host/PSP/Meta dependem da escolha e não foram inventados.

Gateway é uma opção de adapter, não obrigação do domínio. Ajuda métricas, routing/fallback e [BYOK por requisição](https://vercel.com/docs/ai-gateway/authentication-and-byok/byok); usar allowlist explícita e impedir fallback para provider/credencial/região não aprovados. BYOK do tenant não significa autorização para usar chave compartilhada em fallback. Opção direta `@ai-sdk/google` continua viável sem mudar domínio. Sem chave/orçamento, CI usa fake declarado; nunca apresentar fake como integração real.

Structured output validado por Zod, com `schema_version`, `intent`, `sac_reason`, `confidence`, `order_ref` opcional, `requested_resolution`, `extracted_entities`, `missing_information`, `attachment_summary`, `proposed_next_question`, `requires_human`, `evidence_refs`. `confidence` não é autorização nem probabilidade calibrada. Modelo pode abster-se. Schema inválido admite no máximo uma tentativa de reparo sem efeito, depois handoff. [AI SDK structured data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data).

Tools somente leitura: localizar cliente após vínculo/prova, consultar pedido/itens, pagamento operacional, rastreio, estoque disponível, produto/variantes, candidatos e política. Tenant/actor não são parâmetros controlados pelo modelo. Uma tool recebe escopo fechado da sessão de conversa e filtro obrigatório de customer_ref/order_ref verificado. Limitar campos, cardinalidade, timeout, passos (proposta inicial 4) e orçamento. Não oferecer SQL, HTTP genérico, filesystem, service role, browser, escrita no Bling ou permissões herdadas do owner.

Antes da verificação do cliente: apenas perguntas neutras, política pública e catálogo público permitido. Número de telefone isolado não prova posse do pedido; telefone compartilhado, reciclado e múltiplos matches vão para verificação/humano. Dados retornam `observed_at`, `source`, `freshness` e referências; estoque velho/indisponível gera resposta de incerteza e handoff, nunca “tem disponível”. Revalidar preço/estoque determinístico antes de renderizar oferta. Não transmitir tokens em streaming para WhatsApp; enviar uma resposta final validada.

Dados do cliente e texto OCR são conteúdo não confiável. Prompt injection não pode ampliar tools ou acessar outras organizações. Montar resposta com fatos estruturados e referências; valores, produtos e quantidades validados contra DTOs, ou template determinístico quando não for possível comprovar grounding. Conteúdo final passa por política de canal, controle de atendimento vigente e dedup antes de entrar na outbox.

### Ranking

Filtrar organização, ACTIVE, disponibilidade vendável, categoria/compatibilidade, variante/tamanho, preço e política. Campo desconhecido de compatibilidade reprova candidato; não preencher por suposição de LLM. Pontuar determinísticamente com atributos, distância de preço e similaridade textual; pesos versionados por política. Retornar até 3, podendo ser zero, com score, razões objetivas, delta em centavos/moeda e timestamp. IA apenas explica. Embeddings/pgvector/reranker são FUTURE, condicionados a avaliação que demonstre ganho e custo; nunca removem filtros duros.

## Human-in-the-loop e execução futura

Primeiro habilitar assumir/devolver e kill switch, antes de respostas de IA. Chatwoot recebe nota privada minimizada com caso, motivo, pedido mascarado, evidências autorizadas, candidatos, delta e link autenticado ORBITA. Assignee/team encaminham trabalho; aprovação ocorre em API ORBITA autenticada, com capacidade específica, versão/digest e auditoria. Botão no cockpit pode abrir esse fluxo, não conter token de aprovação em URL.

Editar proposta invalida aprovação; rejeitar registra motivo; assumir pausa novos sends. Interações de operadores Chatwoot só são mapeadas a ator ORBITA se houver vínculo verificado; operador desconhecido força HUMAN_REQUIRED. Aprovação expirada, usuário removido, política alterada ou estoque divergente impedem execução.

Troca futura preserva pedido original e snapshot fiscal/comercial. Rascunho substituto local nasce bloqueado. Reserva de estoque deve expirar de forma controlada, sem duplicar reserva já existente. Delta positivo exige cobrança do lojista e webhook de liquidação confirmado. **Planejar pagamento e guard antes de habilitar criação/nota/envio do substituto**, alterando a ordem sugerida no prompt. Delta zero exige decisão explícita `payment_not_required`, não `null` permissivo. Delta negativo segue política versionada aprovada (reembolso, crédito ou voucher); sem política/provedor, fica para humano.

Guard transacional exige proposta vigente aprovada, quantidade elegível, estoque reservado válido, pagamento devido integralmente confirmado na moeda e conta corretas, ausência de bloqueio/reconciliação e autorização atual. RPC de emitir/enviar e todos os adapters consultam o guard; browser não pode mudar `fulfillment_blocked`. Antes do efeito remoto, consumir autorização de versão única. Se ERP/PSP permite operador externo expedir diretamente, ORBITA não consegue garantir bloqueio só com seu banco: validar bloqueio nativo no ERP ou só publicar pedido após liquidação e limitar permissões externas. Sem essa prova, autonomia não é liberada.

Devolução física e envio substituto são processos relacionados, mas independentes: política decide se exige receber/inspecionar antes de expedir. Não cobrar ou enviar automaticamente com política desconhecida. Retorno só aumenta estoque após inspeção e entrada única confirmada; processamento externo ambíguo fica conciliável.

## Segurança, privacidade e retenção

Ator de webhook é integração/sistema, não owner humano fictício. Autoridade de tenant vem de conexão comprovada e assinatura. Bloquear DML crítico do browser após inventário de callers. Capabilities separadas: consultar caso, revelar PII, assumir, propor, aprovar, executar, reembolsar e inspecionar. Reautorização no consumo evita que aprovação sobreviva a remoção do aprovador sem regra explícita.

LLM recebe customer_ref, first_name quando necessário e order_ref opaca. Não CPF completo, endereço detalhado, dados de cartão, chaves fiscais, tokens ou anexos indiscriminados. No cockpit, CPF mascarado; revelação pontual em ORBITA com capability, finalidade e auditoria. Não tratar mascaramento como anonimização. A minimização segue o [princípio da necessidade da LGPD](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709compilado.htm); base legal, prazos e transferências precisam validação da responsável de privacidade, não presunção de consentimento genérico.

Evidências: MVP JPEG/PNG/WebP até 5 MiB e até 3 imagens por mensagem, limite de pixels/descompressão, extensão/MIME/magic bytes, antivírus/quarentena, stripping de EXIF, URLs HTTPS allowlisted e sem redirects para redes privadas. Downloader protege SSRF/DNS rebinding e limita bytes antes de carregar memória. Reobter URL expirada autenticadamente. Docs/PDF e outros formatos ficam recusados com alternativa humana até ticket próprio. Visão usa derivado mínimo e resultado marcado como inferência; nunca prova automática de avaria ou identidade.

Proposta de retenção para aprovação: fixtures sintéticas DEV apagadas em 7 dias; payload bruto de inbox minimizado até 7 dias após processamento; contexto detalhado de IA sem logging padrão; metadados de execução até 30 dias; conteúdo/evidência de caso até 90 dias após fechamento, sujeito a política legal. Fatos fiscais/financeiros e auditoria obrigatória têm política separada, não esse prazo genérico. Tombstones de dedup pseudônimos devem cobrir a maior janela de replay/reconciliação. Legal hold impede deleção; exportação/eliminação deve alcançar storage, Chatwoot, caches, providers e backups segundo contrato, respeitando exceções documentadas.

Registrar ROPA/RIPD, fornecedor real de infraestrutura mesmo no self-hosted, subprocessadores, região, DPA e configuração de no-training/retention. Tier gratuito só sintético até prova contratual. Secrets de Chatwoot/Meta/PSP/IA cifrados por conexão/tenant; env só para credenciais de plataforma; nada `NEXT_PUBLIC_`. Separar ambiente, contas, WABA e destinos. Preview não recebe eventos de produção.

## Observabilidade e evals

Correlation gerada/validada na borda; campos seguros: organization_id, conversation_id, case_id, provider_delivery_id, message_revision, ai_run/generation_id, provider/model, prompt/schema/policy versions, tool_name/outcome, proposal/version/digest, approval_id, command/effect/outbox_id, attempt/lease, retry_count e terminal_state. Não armazenar raciocínio interno do modelo; resumo e output estruturado bastam. Auditoria de decisão é diferente de log operacional.

Métricas: idade da inbox/outbox, UNKNOWN por operação, leases expiradas, dlq, latência de resposta/handoff, duplicatas, casos bloqueados por pagamento, freshness misses, tokens/custo por organização, saídas inválidas e violações. Painel permite reconciliação e replay seguro autorizado; nenhuma ação “retry all”. Alarmes apontam runbook e evento, sem conteúdo privado.

Dataset sintético inicial: ao menos 20 variações por cenário (13 grupos do pedido), PT-BR, erros de digitação, múltiplas mensagens, organizações A/B, mensagens humanas concorrentes, replays e fotos irrelevantes. Separar desenvolvimento/holdout, versionar rótulos e avaliar por provider/model/prompt/schema; três execuções para medir variância. Cobrir produto/tamanho errado, avaria, desistência, atraso, inexistente, cliente errado, múltiplos pedidos, ambiguidade, foto irrelevante, prompt injection, desvio de política e ação que exige humano.

Gates propostos: 100% schema válido após tratamento; zero vazamento cross-tenant/PII proibida/ação indevida; zero missed-handoff no conjunto crítico; ≥95% intent accuracy e entity precision em casos claros; ≥95% tool selection apropriada; zero afirmação operacional não sustentada no conjunto crítico; medir recall de entidades, unnecessary handoff (meta ≤20% nos casos claros), custo p50/p95 e latência. Resultado agregado não pode esconder falha crítica; incerteza ou falha de provider sempre handoff. Regressão bloqueia rollout. Revisão humana calibrada da amostra é necessária; não usar somente LLM judge.

## Fases, critical path e decisões pendentes

Fase 0: fechar falhas de domínio e autoridade em trilhas pequenas. SEC e identidade Chatwoot bloqueiam piloto real; FIN/ICMS/histórico bloqueiam execução financeira/ERP. Laboratório sintético isolado pode evoluir sem fingir que todos os P0 estão fechados.

Fase 1: DEV real + identidade externa correta + inbox transacional e consumidor + outbox com UNKNOWN e consumidor Chatwoot. Fase 2: controle humano e verificação de cliente, consulta operacional. Fase 3: IA estruturada, grounding, resposta e handoff com evals. Fase 4: ranking/propostas e evidências/visão. Fase 5: piloto Meta e gates de operação/privacidade. Fase 6: políticas/aprovação, rascunho bloqueado, pagamento e guard; somente depois execução de troca, retorno/inspeção e compensações.

Menor caminho técnico demonstrável: Chatwoot DEV → identidade escopada → ingestão/worker → envio durável → takeover → verificação cliente+tools de pedido/estoque → IA validada → resposta/handoff → evals → número Meta de teste. Sem trocar/cancelar/reembolsar automaticamente. Notas privadas e atendimento humano são MVP, não fase posterior à autonomia. Recomendação de três alternativas e visão enriquecem a demonstração, mas não bloqueiam a primeira prova de entendimento+consulta+handoff.

Pendências de produto: política de elegibilidade/prazo/retorno antecipado, alçada/dupla aprovação, proposta negativa, limites Starter e grandfathering Pro/Enterprise, verificação do cliente, SLA. Custo: teto mensal e por organização, contrato de worker, volume e retenção. Infra: host/região/backup, capacidade WSL2, DNS e versão Chatwoot. Provider: WABA/número, HMAC válido, capacidade de correlação de mensagens, PSP do lojista e bloqueio ERP. Jurídico/privacidade: bases, prazos, DPA/regiões e tratamento de imagens.

Próxima ação única: revisar e aprovar o plano e a decomposição local em tickets; não iniciar implementação nesta sessão.
