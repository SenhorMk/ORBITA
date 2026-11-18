# D08.3 — ensaio e verificação do atendimento AI-first

**GO para revisão e integração sintética. NO-GO para conexão operacional, ativação de IA e publicação.** O patch parte do D08.2. A candidata D05 e as migrations 93–96 permanecem congeladas. SQL 97/98 foram aplicadas separadamente no laboratório e continuam fora do catálogo oficial.

| Entrega | Implementado | Prova e limite |
|---|---|---|
| Produtor único | Worker com heartbeat de 30 s, leases de geração por tenant/caso/revisão e token de conclusão. Reutiliza o modelo do MSG-014 e a RPC do MSG-022. A RPC anterior fica sem grant direto para service_role. | Worker TypeScript executado contra PostgreSQL real com modelo fake. Envio de mensagem continua no consumidor da outbox, sem segundo produtor. A entrada de processo para o ambiente operacional depende da porta de projeção homologada. |
| Inbox já aceita | Aceite e despacho IA concorrem pela mesma trava por conexão. A guarda consulta eventos ainda recebidos, em processamento ou falhos. Falha persistente aparece como bloqueio até replay ou triagem do evento. | Espera de lock observada no PostgreSQL. Lease da inbox expirada sob controle, evento reprocessado e chave duplicada reutilizada. Outra organização com o mesmo ID externo não bloqueou o teste. |
| Pending/open | Lease e fases duráveis para leitura, escrita e efeito incerto. Usa readback antes de confirmação. Echo apenas relê. Escrita sem recibo volta por leitura. | Postgres real com canal fake. A leitura atrasada não reverte uma abertura externa observada. Divergência confirmada retira a autorização da IA pelo CAS; timeout sozinho não assume atendimento. |
| Handoff e handback | Escalonamento pela triagem vigente. Resposta humana e handback passam pelo controle existente. A devolução exige capacidade, resumo, políticas, conexão e ausência de envio público pendente/ambíguo. O resumo é sanitizado e usado na resposta à próxima mensagem. | PostgreSQL verificou handback bloqueado enquanto a resposta humana estava na fila, depois envio humano, handback e resposta IA registrada na nova revisão. |
| Duplo envio e efeitos externos | A guarda complementa o fencing do MSG-022. Só um despachante registra autorização. O reaper e a conciliação existentes tratam `in_flight` e `unknown`. | Duas sessões concorreram no banco. `unknown` recusou replay cego e aceitou comprovante sintético. O transporte real não foi chamado. |
| UI | A disponibilidade da conversa usa configuração fechada por padrão, políticas, heartbeat e confirmação da projeção para IA. O atendimento humano segue pelo ORBITA. | Testes focados da rota. O ensaio de navegador abaixo é sintético e separado do cockpit D05. |

O ponto de decisão local é o commit da autorização. Webhook aceito primeiro impede despacho até aplicação e, para status/atribuição, até nova observação confirmada. Se o despacho vencer, o transporte pode produzir seu efeito posteriormente. Ações feitas só no painel Chatwoot permanecem assíncronas. Um evento inválido ou sem identidade suficiente pode conter IA no escopo da conexão. O vencimento de leases não muda a responsabilidade para humano.

## Roteiro no navegador

Com Node 22, execute `node experiments/d083/demo-browser.mjs` e abra [a página local no Edge](http://127.0.0.1:55836). A página opera apenas em loopback e mostra o histórico da conversa #1. O modelo, o canal e o PostgreSQL do circuito operacional são substituídos no ensaio por portas simuladas e SQLite.

1. Clique em **Enviar primeira mensagem**. Observe a resposta simulada e `AI / pending`.
2. Clique em **Pedir atendente**. Observe `HUMAN_REQUIRED / open` e silêncio da IA.
3. Clique em **Assumir pelo ORBITA** e **Enviar resposta humana**. A resposta entra no mesmo histórico.
4. Clique em **Devolver com resumo**. Observe `AI / pending`. A IA aguarda nova mensagem.
5. Clique em **Cliente envia nova mensagem**. Observe nova resposta simulada. Reinicie o processo para zerar o ensaio.

O smoke percorreu as seis etapas por HTTP e também passou no Edge headless. Para repeti-lo com o Edge já instalado, defina `ORBITA_D083_EDGE` para o executável e rode `node --test experiments/d083/demo-browser.test.mjs`. Para demonstrar a interface do aplicativo ORBITA, use o D05 assistido já validado. O ensaio acima demonstra a troca de responsabilidade e usa um modelo e canal simulados.

Os gates desta rodada passaram com Node 22.23.2. Foram 85 testes Vitest em seis arquivos, uma integração PostgreSQL 16 com duas esperas de lock observadas, um smoke Edge, lint dos TypeScript tocados, typecheck e drift dos 100 SQL canônicos. O servidor PostgreSQL descartável foi encerrado.

## Reproduzir a prova PostgreSQL

Use PostgreSQL descartável em loopback na porta 55482, como na preparação D08.2. Crie um banco novo `orbita_d083` a partir da cadeia canônica com a 97 aplicada, sem fixtures de teste. Execute `psql -X -h 127.0.0.1 -p 55482 -U postgres -d orbita_d083 -v ON_ERROR_STOP=1 -1 -f experiments/d083/98_ai_first_worker.sql`. Com as dependências já disponíveis, defina `ORBITA_D083_DISPOSABLE=yes` e rode `node --test experiments/d083/postgres.test.mjs`. Use banco novo a cada execução. A prova ajusta timestamps das leases para acelerar o ensaio de reinício. Não há gateway PostgREST neste laboratório.

## Depois da liberação do ambiente de Claude

1. Confirmar credenciais e permissões no cofre sem copiar seus valores. Manter a entrada única de webhook de conta, com assinatura, conta e inbox vinculadas. Confirmar no log o aceite durável de eventos de teste, sem repetir o smoke básico do widget.
2. Validar GET por conta e ID de conversa, status atual, inbox e assignee. Provar uma capacidade para gravar `pending/open` e reler sem atribuir ao usuário técnico. Em 4.19.1, `toggle_status(open)` pode atribuir a conversa quando o token pertence a um agente. A porta `alterarSemAtribuir` exige comprovação desse contrato. Autoassignment desligado por si só não altera esse comportamento. [Controller da versão 4.19.1](https://github.com/chatwoot/chatwoot/blob/v4.19.1/app/controllers/api/v1/accounts/conversations_controller.rb#L76).
3. Depois dessa prova e da autorização, instanciar `executarWorkerAiFirst` com Supabase da organização, o adaptador de status e modelo sintético. Testar a ordem que recebe dois webhooks antes do despacho e o reinício. Confirmar estado, responsável vazio, histórico e receipt, sem chamar Gemini. A projeção sem receipt só aceita leitura até comprovar o efeito. Se não houver confirmação, conter IA e manter o atendimento humano.
4. Antes de aplicar 97/98 fora do laboratório, incluir no ledger/catálogo oficial e validar com PostgREST e PostgreSQL da versão do projeto. A ativação exige nova autorização, infraestrutura isolada validada e o gate de segurança D06. D05 assistido continua sendo o plano da banca para o cockpit.
