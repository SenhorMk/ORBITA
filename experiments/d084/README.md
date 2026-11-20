# D08.4 — adaptador Administrator e integração local

## Contrato de atribuição

O CE 4.19.1 procura a conversa pelo display ID na conta autenticada. O webhook também publica esse display ID. A visão de detalhe confirma conta, inbox e conversa. Na ausência de responsável, a versão CE omite o campo em `meta`. O adaptador exige um detalhe válido e interpreta essa forma como responsável vazio.

`toggle_status(open)` chama `handle_human_open`. No CE, `User#agent?` delega ao vínculo da conta corrente e `AccountUser` declara `agent` e `administrator` como valores distintos. Com papel Administrator na conta alvo, não há a atribuição explícita a si mesmo nesse caminho. A mudança ainda pode executar autoassignment ou outras automações da conta. Antes de escrever, o adaptador comprova o ID do técnico, o papel em `profile.accounts`, a inbox correta e `enable_auto_assignment=false`. Depois relê status e responsável. Um resultado incoerente fica sem confirmação e segue a regra durável de conciliação.

O controller de assignments chama AssignmentService. Enviar `assignee_id` pode substituir ou limpar o responsável e limpar o AgentBot. O endpoint não compara uma versão fornecida pelo cliente. A sequência escolhida evita assignments e mantém a assunção humana no ORBITA.

| Operação | Sequência esperada |
|---|---|
| AI-first | Depois de provar a criação e a política, ler detalhe vazio, projetar pending explícito e reler antes da autorização. |
| Handoff | Gravar o fence humano no ORBITA. Projetar open com Administrator e confirmar o mesmo responsável remoto. |
| Assunção | Atendente autorizado assume pelo ORBITA. No MVP o responsável no ORBITA independe do assignee remoto. |
| Handback | Responsável autorizado devolve no ORBITA com resumo e sem efeito público ambíguo. O adaptador só projeta pending se o remoto estiver sem responsável. A IA aguarda nova mensagem e confirmação. |
| Duplicata/eco | Webhook aceito dispara leitura; status já correspondente não produz novo POST. Efeito incerto usa leitura sem reenvio. |

A API CE não oferece CAS conjunto para papel, configuração, status e responsável. As verificações reduzem a janela, e a última leitura detecta divergência. Um teste muda o papel entre o preflight e o POST e reproduz a atribuição técnica que pode escapar à prevenção. O adaptador não desfaz a atribuição automaticamente. O ensaio real exige papel estável, autoassignment desligado, ausência de Agent Bot e de outras regras de roteamento na inbox de teste. Se houver alteração concorrente de papel/roteamento ou se o ensaio falhar, manter status remoto manual e atendimento assistido D05. Uma garantia atômica além disso exigiria uma operação provider-side que valide papel e atribuição sob a mesma transação.

Referências versionadas. [ConversationsController](https://github.com/chatwoot/chatwoot/blob/v4.19.1/app/controllers/api/v1/accounts/conversations_controller.rb), [papel por conta](https://github.com/chatwoot/chatwoot/blob/v4.19.1/app/models/concerns/user_attribute_helpers.rb), [AssignmentsController](https://github.com/chatwoot/chatwoot/blob/v4.19.1/app/controllers/api/v1/accounts/conversations/assignments_controller.rb), [AssignmentService](https://github.com/chatwoot/chatwoot/blob/v4.19.1/app/services/conversations/assignment_service.rb), [serializer de detalhe](https://github.com/chatwoot/chatwoot/blob/v4.19.1/app/views/api/v1/conversations/partials/_conversation.json.jbuilder).

## Worker e validação

`criarCanalAiFirst` vincula organização, conexão, executor e inbox. A SQL também restringe a projeção, geração e despacho à inbox cadastrada. O worker continua sendo o único produtor. A entrada de ensaio `scripts/worker-ai-first-chatwoot.ts` exige os dois flags `CHATWOOT_AI_FIRST_ENABLED` e `CHATWOOT_AI_FIRST_ENSAIO_SINTETICO`, aceita só Supabase descartável em loopback e usa modelo fake fixado. O adaptador só resolve a origem explícita da configuração. O worker existente de envio continua despachando a outbox conforme o MSG-022.

Testes com Node 22.23.2. A prova PostgreSQL 16 executa o worker com o adaptador HTTP real e transporte injetado do CE. A fixture Administrator não se atribui; Agent se atribui no controle negativo e é barrado pelo adaptador. Também foram exercitados o retorno após timeout, handback, preservação de atendente existente, isolamento, duas esperas de lock e o replay recusado de unknown. A semântica da fixture foi derivada do código da tag. Nenhuma credencial ou instância real foi usada para prová-la.

## Ledger, catálogo e PostgREST

- 97 e 98 entraram no manifesto canônico somente na branch isolada. São ordens 100 e 101, sem colisão de prefixo. 93–96 preservam ordens 96–99 e hashes. Aplicar 97 antes de 98. A 98 fecha acesso direto do service_role às operações substituídas.
- O catálogo foi capturado com as consultas oficiais em dois bancos nativos. O baseline nativo tem as contagens oficiais, mas outro fingerprint. O candidato nativo registra o delta; não serve para gravar a referência canônica. O próximo gate é reconstrução no laboratório Supabase PostgreSQL 17, comparação da base e regeneração com `npm run db:catalog:rebuild`.
- O script `postgrest-contract.sql` passou em PostgreSQL real: nomes, ordem dos argumentos, grants, referências internas e chamada como service_role. O gateway HTTP ainda precisa de teste. Após schema cache carregado em laboratório isolado, execute `node experiments/d084/postgrest-http.mjs` com `ORBITA_D084_DISPOSABLE=yes`, as duas chaves **locais** por ambiente e endpoint loopback. Verifique também a prova vertical com o cliente Supabase e execute pgTAP focalizado em controle e autorresposta. O PostgreSQL nativo não oferece a extensão pgTAP instalada.

## Ensaio real pendente

1. Só após liberação, usar tenant, inbox e conversa sintéticos com credencial descartável de Administrator, separada do token operacional. Conferir papel na conta alvo, autoassignment desligado e ausência de regras de atribuição.
2. Registrar IDs e status antes/depois de pending→open, com a conversa vazia e com um atendente de teste existente. Exigir que o ID técnico nunca apareça. Provar que uma repetição gera só leitura. Em caso de efeito ambíguo, parar a escrita e conciliar.
3. Executar pelos controles ORBITA a assunção e o handback com resumo. Conferir o silêncio do bot após o fence, a retomada somente após a nova mensagem e o recibo sintético. Manter Gemini desligado. Encerrar o worker e verificar que o heartbeat expirou.

**GO para revisão e teste controlado sintético local. NO-GO para testar contra Chatwoot operacional até liberação e credencial descartável. NO-GO para IA real. NO-GO para publicação**, inclusive pelos gates de catálogo/gateway e segurança D06. Se o ensaio real não for liberado, usar D05 assistido e a página D08.3 como simulação identificada.
