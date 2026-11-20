# D08.2 — atendimento AI-first

**Integração de contratos locais aprovada. Integração completa, ativação e publicação em NO-GO.** O patch foi desenvolvido sobre D08.1 na branch `codex/d082-ai-first`. O webhook de conta é a entrada única. O D05 continua sendo a candidata de demonstração assistida.

## O que a rodada entregou

| Camada | Entrega | Prova |
|---|---|---|
| Código | O envelope real preserva criação e responsável; diferencia responsável explicitamente vazio de dado ausente. A assinatura é verificada antes de aceitar o evento. | Captura sintética existente do CE 4.19.1, teste de normalização e rota assinada com escrita substituída por porta de teste. |
| Banco | A RPC candidata cruza criação durável, organização, conexão, conta, inbox, conversa, caso e mensagem do contato. Exige cutoff e janela de criação, executor específico, políticas e versões. CAS inicial 0→1, responsável humano vazio e auditoria idempotente. | PostgreSQL 16 descartável com a cadeia D05 intacta e SQL candidato aplicado em seguida. Permissões testadas via roles locais. |
| Geração | O serviço chama a geração validada do MSG-014, relê o contexto e registra pela RPC da 95. Identidade determinística inclui tenant, caso, run e versões. | Serviço TypeScript invocado em teste contra RPC real pelo driver PostgreSQL. Modelo de resposta e run de triagem são fixtures. O teste de replay recebe a intenção existente. |
| Operação humana | A interface orienta assumir, responder e devolver pelo ORBITA. Os controles humanos e as notas existentes continuam como base. | PostgreSQL confirma takeover, resposta humana via outbox e handback com resumo e CAS. A interface nova passou pelo lint direcionado. |
| Projeção | O planejador diferencia preparação, IA e humano. Confirma apenas pending sem assignee para IA, contém status divergente, produz open para humano sem loop quando open já está observado. | Teste local com observações injetadas. O sincronizador durável e o transporte ainda são pendências. |

O SQL 97 está sob experiments. Ele ainda não compõe catálogo ou ledger de release. O drift oficial comprova somente a cadeia congelada. O laboratório é PostgreSQL nativo com objetos de autenticação mínimos para as fixtures. Não executa o gateway PostgREST nem replica a imagem Supabase 17. O D05, D06 e D07 foram preservados.

Execução local com Node 22.23.2 e dependências já disponíveis. **90 testes Vitest em três arquivos**, **11 testes da jornada sintética D08.1** e **uma prova vertical PostgreSQL com duas esperas de lock observadas** passaram. Lint dos arquivos TypeScript tocados e drift dos 100 SQL canônicos passaram. O servidor PostgreSQL descartável foi encerrado após a prova. Não houve CI remoto, build repetido ou serviço real chamado.

## Matriz dos eventos

| Evento / ordem | Decisão | Limite ou teste |
|---|---|---|
| Assinatura inválida ou corpo adulterado | Recusar antes da inbox. | Vitest da rota. |
| Conta divergente | Recusar na conexão. | Vitest da rota e chave de conta exigida no bootstrap SQL. |
| Criação antes da primeira mensagem | Guardar evidência assinada, sem abrir caso ou conceder posse. | PostgreSQL tenant B. |
| Mensagem aplicada antes da criação | Caso fica disponível para humano. Criação posterior pode iniciar IA dentro da janela, com caso confirmado e controle ainda inicial. | PostgreSQL tenant A. |
| Repetição de criação | Mesma entrega é deduplicada pela inbox; mesmo bootstrap mantém histórico e posse. | PostgreSQL reprocessa inclusive após takeover. |
| Criação com dados insuficientes, pré-corte, outro tenant ou já atribuída | Sem autoridade inicial. O modo padrão permanece HUMAN_REQUIRED. | Negativos de tenant, executor e prova ausente no PostgreSQL. Campos de assignee exercitados no contrato. |
| Mensagem do contato | Aplica caso/contexto pelo consumidor existente. Geração só com run vigente e controle autorizado. | SQL ingress/consume e fixture de classificação do CE. |
| Mensagem enviada pelo bot ou humano; nota privada | Não abre caso novo nem aciona o produtor como mensagem do cliente. | Classificação existente e contratos locais. |
| Atualização de assignee ou status atrasada | Preservar observação. A projeção precisa ler estado atual; evento isolado nunca concede posse. | Normalização e aceite assinado reais em teste; reação temporal coberta no D08.1 sintético. |
| Divergência confirmada de status | Conter IA; jamais converter pending observado em handback. | Planejador local. Falta o sincronizador que transforma contenção em comando durável. |
| Takeover ganha lock | Envio pendente é invalidado e o worker perde a autorização. | Segundo cliente PostgreSQL observado em espera de lock. |
| Despacho autorizado antes do takeover | Preservar in_flight. Timeout ambíguo vira unknown. Comprovante positivo permite conciliar sem reenvio. | RPCs reais com recibos sintéticos; replay recusado. |

## Fronteira da garantia

O commit de `iniciar_envio_chatwoot` é a fronteira do despacho. A assunção ganha para toda intenção que ainda não passou dessa fronteira. O transporte pode produzir efeito depois do takeover quando o despacho já venceu. Nenhum timeout assume atendimento. A UI orienta o uso exclusivo do ORBITA para operações humanas da jornada. Incidentes feitos apenas pelo painel Chatwoot dependem do webhook e podem ser observados com atraso. O plano de integração precisa de uma barreira para eventos assinados aceitos que ainda não foram aplicados.

## Contrato operacional do Chatwoot

- Receber apenas pelo webhook de conta da conexão. Assinar os bytes originais com timestamp e segredo da conexão. Validar a conta e usar o par conexão/inbox conhecido para roteamento. Eventos necessários: `conversation_created`, `conversation_updated`, `conversation_status_changed`, `message_created` e atualizações aplicáveis de mensagem. Não consumir outro fluxo de automação.
- A leitura deve ser GET de detalhe por conta e display ID, verificando identidade, inbox, status e assignee explicitamente presente. Depois de uma escrita, obter confirmação por leitura. Gravar a intenção de projeção com versão, apenas uma em voo por conversa. Usar status explícito, sem toggle implícito. Echo serve como sinal de leitura, sem gerar outra escrita quando a projeção já bate.
- Validar a identidade de API que preserva o assignee. `toggle_status` para open com token de User pode mudar assignee no CE. O planejador não envia esse POST. Provar a semântica de atribuição, regras de autoassignment e acesso ao inbox antes de ativar. O executor ORBITA e o usuário técnico do Chatwoot têm funções diferentes.
- Conter em caso de status ambíguo. Reconciliar o comando primeiro para que um pending antigo não ultrapasse um open novo. Fazer handback em duas etapas como no D08.1. Faltam a fila durável do sincronizador, a integração do produtor com o worker e com o repositório de contexto real, a barreira de eventos da inbox e o teste PostgREST/CE. O bootstrap SQL só pode ser chamado pelo orquestrador depois de uma projeção comprovada. O controle padrão de disponibilidade do D05 continua desligado.

Fontes do contrato, lidas na D08.1. [WebhookListener CE 4.19.1](https://github.com/chatwoot/chatwoot/blob/v4.19.1/app/listeners/webhook_listener.rb), [assinatura e entrega](https://github.com/chatwoot/chatwoot/blob/v4.19.1/lib/webhooks/trigger.rb), [controller de conversas](https://github.com/chatwoot/chatwoot/blob/v4.19.1/app/controllers/api/v1/accounts/conversations_controller.rb).

## Ensaio da banca

Na worktree com Node 22, rode `node --test experiments/d081/vertical.test.mjs`. Mostre a primeira prova na saída: mensagem inicial, resposta IA simulada, pedido de humano, assunção, resposta humana na mesma conversa, devolução com resumo e resposta à nova mensagem. A prova também mostra o limite de uma ação que chega atrasada pelo webhook. É uma demonstração terminal de serviço com SQLite e portas simuladas. Para demonstrar a interface em navegador, use a jornada assistida D05 já validada e identifique no roteiro que ela exige revisão humana.

Para revisar o contrato de banco, crie um cluster exclusivamente descartável no Windows. Com PostgreSQL 16 instalado e caminho novo para os dados, execute `initdb -D <dados-novos> -A trust -U postgres --no-locale -E UTF8`. Em outro terminal inicie `postgres -D <dados-novos> -p 55482 -h 127.0.0.1 -c shared_buffers=16MB -c max_connections=12`. Rode `./experiments/d082/prepare-postgres.ps1 -PgBin <PostgreSQL-bin> -DadosDescartaveis <dados-novos>`. Com as dependências do lock disponíveis, defina `ORBITA_D082_DISPOSABLE=yes` e rode `node --test experiments/d082/postgres.test.mjs`. Esse teste grava fixtures. Use banco novo a cada repetição. Pare somente esse cluster com `pg_ctl -D <dados-novos> -m fast -w stop`. O serviço local foi executado diretamente porque o lançador pg_ctl start falhou ao preparar token restrito.

## Decisão

- **Integração de contratos para revisão: GO.** RPC candidata e serviço demonstrados no laboratório, incluindo dois escritores em disputa e invalidação no takeover.
- **Integração completa do fluxo e ativação de IA: NO-GO.** O sincronizador, a escolha da identidade de API, a captura controlada no CE, o gate de eventos pendentes e a ligação aos workers ainda bloqueiam o fluxo operacional. MSG-021 condiciona dados reais.
- **Publicação: NO-GO.** Os gates do D06 continuam aplicáveis e a SQL candidata precisa passar pelo processo oficial antes de ser integrada ao ledger.
