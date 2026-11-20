# ORBITA D08.1 — prova vertical e decisão proposta

**GO para revisão do protótipo. NO-GO para publicação ou ativação.** A prova cobre o fluxo IA → humano → IA com SQLite descartável, dois escritores concorrentes e portas sintéticas. Os caminhos de produção continuam sujeitos ao gate D06 e à integração descrita abaixo.

## Webhook de conta e Agent Bot no CE 4.19.1

| Ponto | Webhook de conta proposto inicialmente | Agent Bot nativo |
|---|---|---|
| Entrada | O ORBITA já tem verificação HMAC, escopo da conexão, inbox durável e normalização de mensagens/status. O listener usa subscriptions. | O listener tem outro registro, segredo e fila. Entrega mensagens e mudanças de status mesmo com conversa aberta. Se operar junto ao webhook de conta, os UUIDs de entrega são diferentes e a deduplicação precisa cruzar origens. |
| Início | O estado local reconhece a IA após autorização e confirmação de pending. Há uma janela inicial open no Chatwoot, que precisa ser tratada no ensaio. | Inbox com bot ativo pode iniciar pending e atribuir AgentBot desde a criação. A escolha do Chatwoot não conhece a política global, a organização nem a disponibilidade do ORBITA. |
| Transferência | Controle do ORBITA audita, invalida e cerca o despacho. Envia status explícito. | O caminho especial pending→open depende de autenticação como AgentBot. É uma transição local no Chatwoot, mesmo quando dispara notificação. |
| Devolução | Dono humano autorizado, resumo e CAS no ORBITA. Status pending é uma projeção confirmada. | Pending é a convenção de retorno ao bot. Essa transição sozinha não demonstra reatribuição nativa, confirmação do resumo, revogação concorrente ou ausência de POST antigo. |
| Falhas | O consumidor já existe. A implementação precisa observar atrasos e reconciliar divergências. | A fila específica tem retentativas para certos erros e pode levar pending a open em falha de mensagem. Isso cria outra transição externa a conciliar. |

Fontes da versão instalada informada, confrontadas no D08. [WebhookListener](https://github.com/chatwoot/chatwoot/blob/v4.19.1/app/listeners/webhook_listener.rb), [AgentBotListener](https://github.com/chatwoot/chatwoot/blob/v4.19.1/app/listeners/agent_bot_listener.rb), [Conversation](https://github.com/chatwoot/chatwoot/blob/v4.19.1/app/models/conversation.rb), [ConversationsController](https://github.com/chatwoot/chatwoot/blob/v4.19.1/app/controllers/api/v1/accounts/conversations_controller.rb), [Trigger](https://github.com/chatwoot/chatwoot/blob/v4.19.1/lib/webhooks/trigger.rb).

**Decisão recomendada.** Usar a entrada que o ORBITA conhece e manter um produtor e uma outbox. O nativo tem vantagem real para atribuição e fila visual imediata, mas instalar o adaptador acrescenta credencial e transições externas e mantém todo o trabalho de segurança do ORBITA. Se for obrigatório ver a identidade AgentBot nativa desde a criação no dashboard, o caminho proposto não cobre esse requisito visual. Revisar essa condição antes de homologar.

## Conversa nova e autoria

Na primeira mensagem própria do cliente em uma conversa nova comprovada, o consumidor reserva a identidade da conversa pelo vínculo organização/conexão/conta/inbox e identificador externo. Bootstrap é transacional e único, exige políticas AND, executor ativo especificamente autorizado e prontidão, sem histórico humano preexistente. Vai para preparação com autoridade humana disponível e IA bloqueada. Confirmação de pending pela projeção, CAS e revalidação ativam AI no ORBITA. Com política desligada ou falha, o humano fica apto a assumir. Conversa anterior à janela de ativação, já reivindicada ou de origem incerta fica fora do bootstrap. Religar política jamais reabre essas conversas.

Em produção, novidade precisa de evidência persistida de criação e corte de ativação, com correlação da primeira mensagem e verificação de ausência de atribuição/atividade humana. Se os eventos vierem invertidos, reter a candidatura por janela limitada até provar os requisitos. Ausência de linha no espelho não é prova de conversa nova. O laboratório injeta essa prova como fixture `verifiedNew`. Ela não deve ser recebida do payload público.

O bot é o modo AI, com responsável humano vazio no ORBITA. O executor técnico do ORBITA é separado do usuário de API do Chatwoot. **Não usar o usuário integracao-orbita como assignee.** O controller do Chatwoot pode autoatribuir ao abrir via token de User agente e limpar ai_assignee. Validar em ensaio isolado uma identidade/capacidade e sequência API que preservem assignee e notificações esperadas; checar autoassignment e regras de automação no início open. Esse é bloqueante se não houver configuração comprovada. O fake só grava status e preserva esse limite.

## Garantia e operações exclusivas

Takeover, escalonamento que bloqueia, devolução e envio humano do fluxo devem passar pelo ORBITA. O operador recebe confirmação somente depois do commit do takeover. O despacho usa transação de autorização que verifica versões e grava `in_flight` sob o mesmo controle concorrente. Se takeover ganha, cancela intenção pendente e o worker não chama o transporte. Se despacho ganha, o efeito externo já autorizado pode chegar depois. Isso inclui pausa do processo entre commit e início do POST. Um check adicional antes do POST apenas estreita a janela. Nenhum desses protocolos revoga um POST já admitido.

Se o requisito significar **nenhuma nova entrega visível depois da confirmação de takeover**, o produto precisará aguardar conciliação dos envios já admitidos antes de confirmar silêncio, com indicação de bloqueio de despacho imediato e incerteza visível. `unknown` não admite promessa temporal nem retry cego. A operação humana continua disponível. Alterar estado ou responder diretamente no Chatwoot antes de assumir no ORBITA não tem garantia instantânea: a suite comprova que o despacho local ainda pode vencer antes da chegada do webhook. Para impor exclusividade, remover esse caminho do procedimento e restringir permissões/uso de dashboard conforme configuração comprovada. Se coexistência irrestrita for obrigatória, manter NO-GO para a garantia.

## Geração, autorização e sincronização

1. Mensagem canônica deduplicada atualiza revisão local mesmo se chega atrasada. O produtor único reivindica trabalho por lease com token, lê contexto isolado e chama o modelo fora da transação. O retorno validado só se torna intenção se tenant, revisão, controle e versões global/org permanecem atuais e a concessão técnica continua ativa. Duas tentativas podem chamar o modelo se a primeira perde a lease; somente a vigente registra intenção.
2. Na composição futura, reutilizar o serviço de geração MSG-014, triagem vigente da 94 e RPCs MSG-022 da 95. Run de triagem e proveniência da geração são registros distintos. Usar o executor específico, chave pela revisão e snapshot das políticas. O protótipo repete as invariantes centrais em SQLite e não executa RPCs, grants, RLS ou prova de run real. A geração sintética é injetada, inclusive rejeição de output, erro e escalonamento. Nenhum dado real ou credencial.
3. O sincronizador registra uma intenção por conversa com versão e efeito em curso. Webhook de status sinaliza readback, bloqueando a IA enquanto a observação está pendente. Echo compatível não produz outro POST. Evento antigo pending não autoriza devolução. Divergência lida gera contenção, sem atribuir identidade pelo webhook. No caminho normal, preparar pending, escalonar open e devolver pending. Devolução exige responsável, capacidade, resumo e versão, sem envio IA ambíguo. Nesta prova a IA responde à próxima mensagem inédita após devolução para evitar responder novamente à mensagem já atendida.
4. Status remoto não possui CAS compartilhado. Um pending em curso pode terminar após takeover. O único claim serial impede que um segundo POST ultrapasse aquele em curso; depois de terminar, o comando atual corrige para open. Timeout ambíguo retém o claim e contém IA. Na produção, recuperação requer conciliação explícita e trilha de comando. O laboratório mantém `unknown` e preserva atendimento humano, sem implementar operação de destravar. Também falta reconciliar claim interrompido por crash e detectar perda de webhook por leitura periódica.

## Rodar e revisar

Em Node 22.23.2 no diretório da worktree:

```sh
node --test --test-timeout=15000 experiments/d081/vertical.test.mjs
```

Sem dependências externas. O SQLite real usa arquivo temporário e transações BEGIN IMMEDIATE. Os testes cobrem o percurso completo, políticas, membros, tenant, idempotência, status atrasado, geração vencida, timeout ambíguo e disputa de escritores SQLite via duas threads, além das duas ordens forçadas entre takeover e despacho. O laboratório começa depois da fronteira HMAC e não usa HTTP, UI, PostgreSQL, Gemini ou Chatwoot. Os testes não permitem concluir que locks do PostgreSQL ou a instância CE tenham sido validados.

## Próxima decisão

Aprovar a entrada canônica de conta e o controle exclusivo pelo ORBITA para integrar em nova candidata. Antes de ativar: escolher caminho de status sem atribuição técnica, provar bootstrap com eventos reais sintéticos, implementar geração e status duráveis, confirmar actor/run/fences da 95 e a barreira de eventos duráveis ainda não aplicados usando a ordem existente de locks. Rodar PostgreSQL concorrente e ensaio CE isolado após autorização específica. MSG-021 continua condição para dados reais. Até os gates fecharem, a demonstração assistida permanece disponível com suas capacidades já validadas.
