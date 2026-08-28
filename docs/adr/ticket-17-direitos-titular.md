# ADR — Ticket 17: Direitos do titular (LGPD)

Status: implementado (núcleo técnico); decisões jurídicas explicitamente `needs-owner`.

## Contexto

Ticket 17 exige uma jornada auditável para receber, verificar, executar e
responder solicitações de titulares de dados, apoiada no mapeamento produzido
no ticket 15 (`docs/privacy/data-inventory.md`, `ropa.md`, `ripd.md`). O ticket
é explícito: o executor **não decide** política jurídica (quais tipos de
direito oferecer, texto de resposta, catálogo de exceções aceitas) — isso é
`needs-owner`. O executor **decide e constrói** o mecanismo técnico completo.

## Decisões técnicas (autoridade do executor)

### 1. Titulares suportados no MVP

- `lojista_user`: um usuário autenticado com membership em
  `membros_organizacao` solicitando sobre si mesmo. Verificação = sessão forte
  já autenticada (`resolveAuthenticatedIdentity`), sem necessidade de prova
  adicional — a sessão já é a prova de identidade.
- `cliente_final`: um cliente da loja (linha em `public.clientes`) sem conta
  própria no Orbita. Verificação exige duas provas de conhecimento
  independentes amarradas a um pedido real da organização (não apenas
  e-mail/documento informado no formulário): (a) e-mail ou telefone que bate
  com o registro em `clientes`, e (b) um código de verificação de uso único,
  com expiração, entregue apenas ao contato já cadastrado (nunca ao valor
  informado no formulário) e confirmado antes de a solicitação sair de
  `identity_pending`. O canal de entrega do código (e-mail/SMS/WhatsApp) e o
  texto da mensagem ficam `needs-owner` (dependem de canal de notificação
  ainda não padronizado neste MVP); o mecanismo (geração, hash, expiração,
  uso único, correlação ao pedido) está implementado e testado.

### 2. Autoridade do operador (quem aprova/executa)

Aprovar, negar (total/parcialmente) e executar uma solicitação em nome da
organização exige `capabilities.has('organization:manage')`
(`src/lib/organizationAuthorization.ts`) — papéis `owner`/`admin`. Um membro
com papel `member` (sem essa capability) nunca pode transicionar uma
solicitação para `in_review`/`approved`/`executing`; a tentativa é rejeitada e
auditada.

### 3. Máquina de estados

Tagged union pura, independente de framework, em
`src/domain/privacy/titularRequestStateMachine.ts`:

```
received → identity_pending → verified → in_review
  → approved | partially_denied | denied
  → executing → completed | failed
```

Toda transição passa por uma matriz explícita (`ALLOWED_TRANSITIONS`), nunca
por booleans soltos. Transições fora da matriz são rejeitadas com reason code,
nunca aplicadas silenciosamente. `denied`/`partially_denied` exigem um motivo
(`reasonCode` + `justificativa`) — nunca "exclusão silenciosa".

### 4. Sistemas alcançados (matriz de cobertura técnica)

Baseado em `docs/privacy/data-inventory.md` (ticket 15), confirmado no código
real desta sessão:

| Sistema | Onde | Adapter | Mecanismo |
|---|---|---|---|
| Banco (produtos/clientes/pedidos/financeiro) | Supabase Postgres, tabelas `clientes`/`pedidos`/`itens_pedido`/`financeiro`/`produtos` | `dbAdapter.ts` | Consulta/exportação/anonimização síncrona e real, escopada por `organizacao_id` |
| Auditoria/logs | `public.eventos_auditoria_sistema` (migration 36) | `logsAdapter.ts` | Leitura real para exportação; **retenção obrigatória** para exclusão (`retained-with-reason`) — trilha de auditoria não pode ser apagada sob demanda do titular |
| Bling | `conexoes_integracao` + `BlingClient` | `blingAdapter.ts` | Enfileira tarefa real no outbox durável (`outboxService.enqueue`, destino `bling`) com `event_type` dedicado; status da tarefa reflete o status real do evento no outbox |
| Chatwoot | `conexoes_integracao` + `ChatwootPort` | `chatwootAdapter.ts` | Mesmo mecanismo, destino `chatwoot` |
| Stripe | `assinaturas_organizacao.stripe_customer_id` | `stripeAdapter.ts` | Leitura real do identificador vinculado à organização para exportação; exclusão do Customer Stripe é `retained-with-reason` (assinatura ativa/registro fiscal de cobrança — risco de quebrar faturamento e obrigação contábil) |

**Gap de infraestrutura pré-existente (não jurídico, `needs-owner` técnico):**
o worker de outbox (`runOutboxWorkerOnce`, ticket 12) já é genérico e durável,
mas **nenhuma rota de produção o invoca com adapters reais de provider** ainda
(confirmado: nenhum caller de `runOutboxWorkerOnce`/`drainOutboxWorker` existe
fora dos próprios testes). Ou seja: o evento de exclusão/exportação do Bling e
do Chatwoot fica corretamente enfileirado e durável, mas só é **entregue** ao
provider quando esse gap de wiring (que antecede este ticket) for fechado com
uma rota/cron que registre `providers.bling`/`providers.chatwoot` reais. Até
lá, uma tarefa endereçada a Bling/Chatwoot permanece honestamente `retryable`
— nunca `completed` fictício.

### 5. Exceções

Mecanismo: toda negação/retenção exige `reasonCode` de um enum fechado
(`titular_solicitacao_excecoes.fundamento`) e aparece na resposta ao titular.
**Catálogo de fundamentos aceitos (quais motivos jurídicos são válidos em
cada tipo de direito) é `needs-owner`** — o código aceita qualquer fundamento
não vazio registrado por um operador com `organization:manage`, mas não
pré-aprova nenhum fundamento especificamente (isso é política jurídica).

### 6. Exportação

Streaming para arquivo temporário local, cifrado com AES-256-GCM (chave
efêmera por exportação, nunca reaproveitada), `expires_at` persistido,
manifest JSON versionado (`schemaVersion`, sistemas cobertos, contagens,
hash). Filtra: segredos/tokens de `conexoes_integracao`/`vault`, dados de
outros titulares, metadados internos (`lease_owner`, IDs internos de outras
organizações). Cleanup: job idempotente que apaga arquivos com
`expires_at < now()` e marca a exportação como `expired` na tabela de
histórico.

## Lacunas jurídicas (`needs-owner`)

1. **Tipos de direito exatos a oferecer** no MVP: implementados como núcleo
   técnico testável **acesso, exportação (portabilidade), correção e
   exclusão/anonimização**. Oposição e revogação de consentimento specific
   ficam de fora desta entrega — o Owner decide se entram no MVP; a máquina
   de estados e o modelo de tarefas já suportam adicionar um novo
   `tipo_direito` sem migration de ruptura.
2. **Texto/modelo exato da resposta ao titular** (e-mail/carta formal): não
   escrito. O sistema produz um payload estruturado (estado, motivo, sistemas
   cobertos, prazo) que um template de resposta jurídica ainda precisa
   envelopar.
3. **Catálogo de fundamentos legais aceitos** para negar/reter dado (ex.:
   obrigação fiscal, obrigação contábil, interesse legítimo, execução de
   contrato): mecanismo pronto, lista de fundamentos válidos por tipo de
   direito não populada.
4. **Canal/copy de entrega do código de verificação para `cliente_final`**:
   mecanismo (geração/hash/expiração/uso único) pronto; canal de envio real
   (e-mail transacional, SMS) depende de decisão de produto/custo ainda não
   tomada neste MVP.
5. **SLA operacional exato** (dias corridos vs. úteis, prorrogação): a coluna
   `sla_vencimento` é calculada com um prazo técnico configurável (default 15
   dias corridos, alinhado ao art. 19 LGPD para confirmação de existência de
   tratamento) — o Owner deve confirmar se este é o prazo correto para cada
   tipo de direito.
6. **Wiring de produção do outbox** para Bling/Chatwoot (item técnico, não
   jurídico): ver seção 4 acima.
