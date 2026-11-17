# MSG-022 · controle de emergência da autorresposta SAC

## Operação local

A política efetiva exige global e organização ligados. Política ausente equivale a desligada com versão 0. Inbox, notas privadas humanas, envio humano e triagem são independentes.

- `GET /api/sac/autorresposta` consulta a organização ativa da sessão. `?escopo=global` consulta somente a política global. Resposta inclui `global`, `organizacao` e `efetiva`. Na consulta global `organizacao` é nula e `efetiva` é falsa porque falta uma organização.
- `POST` na mesma rota, com bearer da sessão e JSON estrito `{"ativa":false,"versaoEsperada":1,"motivo":"pausa operacional"}`. A versão é a do escopo alterado. Em 409, releia o estado antes de decidir. Motivo deve ser operacional, sem credenciais ou dados da conversa.
- Na organização, a sessão precisa de `organization:manage` e o banco revalida owner/admin ativo. Para o global, o ator da sessão precisa constar em `sac_operadores_autorresposta`. Provisionar e revogar essa capacidade por operação do banco, com identidade aprovada. Tabela nasce vazia e a chave da aplicação não pode concedê-la.
- Mudança e auditoria são atômicas. Cada comando aceito incrementa a versão, inclusive outra gravação do mesmo valor. A intenção e a referência do run vão para auditoria. Uma resposta 503 exige releitura para confirmar se a operação foi aplicada. Se a pausa não foi efetivada, a parada operacional do worker de envio é a alternativa imediata, com impacto também na fila humana.
- Mudança terminal encerra envios IA elegíveis ainda em `pending`, `processing` ou `failed_transient`. Estado terminal e motivo estão na outbox, com evento de auditoria. A fila humana não entra nessa varredura. `in_flight` conta como despacho autorizado e pode ter confirmação, retry por prova de não envio ou UNKNOWN. Mesmo um retry com prova de não envio precisa da versão atual para começar de novo. UNKNOWN permite conciliar por recibo. Se houver prova de ausência de envio, uma nova geração é necessária para responder por IA.

## Contrato de integração para MSG-014

1. Servidor/orquestrador deriva organização e conversa de um caso ou trabalho verificado. Usa `estado_autorresposta(organizacao_id)` para ler os dois flags e versões antes de gerar resposta, e a versão do controle da conversa pelo contrato MSG-009. Só continua em modo `AI` com autorização efetiva. O orçamento e o grounding pertencem ao orquestrador.
2. Usa ator técnico com membership vigente na organização ativa e grant explícito em `sac_executores_autorresposta`. A tabela nasce vazia e a credencial da aplicação não concede grants. Provisionar ou revogar pelo operador do banco. A remoção do membership revoga automaticamente o grant. A identidade técnica e os IDs de execução, caso, tenant e conversa vêm do trabalho autorizado no servidor.
3. Chama a RPC server-only `registrar_autorresposta_chatwoot(p_organizacao_id, p_ator_id, p_conversa_id, p_caso_id, p_command_id, p_run_id, p_conteudo, p_versao_global, p_versao_org, p_versao_conversa)`. Use a mesma chave de comando para retries da mesma intenção. `registrada` cria intenção e evento. `existente` reconhece retry já registrado. `desligada`, `obsoleta`, `executor_nao_autorizado`, `run_inelegivel`, `conexao_indisponivel` e `conflito` impedem nova intenção. Falha de infraestrutura impede o envio e deve ir para handoff.
4. O banco exige execução `sac.triagem` concluída, fora do provedor fake, com chamada ao modelo registrada e resultado que dispensa humano. Organização, caso e conversa precisam coincidir. `ai_runs.mensagens_ate` precisa ser exatamente igual a `sac_cases.ultima_mensagem_em`, em fase `TRIAGE` ou `COLLECTING_INFORMATION`. O worker de protocolo 2 chama `iniciar_envio_chatwoot`, que repete as verificações de run, executor, política e controle antes de gravar `in_flight`.
5. A intenção guarda os IDs históricos do caso e do run. Se a política de retenção remover uma origem, o próximo despacho é invalidado. O MSG-014 ainda precisa ligar o orquestrador e a devolução do MSG-009 à política e à disponibilidade real do atendimento automático. A validação do texto e dos dados consultados continua a cargo do MSG-014.

## Concorrência e rollout

Registro e despacho de IA travam política global → organização → grant técnico e membership → controle da conversa → caso e run → outbox. A leitura inicial do orquestrador é um snapshot informativo. O lock compartilhado sobre `sac_cases` serializa o despacho com a transação que aplica a inbox. Se a mensagem comitar primeiro, o envio é invalidado e nenhuma tentativa é criada. Se o despacho comitar primeiro, o envio já está `in_flight` e segue para conclusão ou conciliação. A chegada ao webhook ainda pendente de aplicação da inbox não altera a versão do caso. Nenhum lock atravessa o POST externo.

A migration 89 usa `greatest` para a data da última mensagem. Para também cercar mensagens novas com timestamp igual ou anterior, a correção B1 da migration 94 avança o marcador em pelo menos um microssegundo a cada atualização da coluna pela RPC da inbox. Uma atualização sem nova mensagem mantém a regra original da 94 e não cria outro trabalho. Com isso, o gatilho existente da 94 enfileira uma triagem para a nova versão. A mensagem mantém seu timestamp original no espelho.

Alterações globais usam lock exclusivo global. Alterações de organização usam lock global compartilhado e lock exclusivo no próprio escopo. A mudança e a invalidação ocorrem na mesma transação, preservando `in_flight` e `unknown`.

A migration 95 depende da migration 94 do MSG-013 em `16064d0` e da correção B1. As tabelas privadas nascem com RLS e sem grants diretos de aplicação. A migration adiciona a proveniência e índice parcial em `chatwoot_envios` e substitui a RPC de início mantendo a assinatura do worker. Verificar locks e volume de pendências antes de operação remota.

Banco aditivo primeiro, aplicação em seguida, MSG-014 conectado com política desligada. Operar ensaio sintético com ambos os escopos ligados apenas no ambiente autorizado. Antes de qualquer uso operacional, comprovar MSG-019, vínculo de run e prontidão de Chatwoot, e revisar atribuição de operadores. Rollback operacional por desligamento auditado. Preservar schema e histórico e corrigir para frente. Um rollback de código que recoloca uma RPC de despacho anterior a 95 pode remover a barreira, então manter IA desligada e o produtor de envios IA parado durante esse rollback.

## Comandos de verificação

- `npm run test:db` aplica a cadeia no laboratório descartável, roda o pgTAP e executa as seis corridas do MSG-022 no runner de concorrência do CI. Nenhum POST externo.
- `npm test -- src/app/api/sac/autorresposta src/services/chatwoot/consumidorInboxChatwoot.test.ts src/services/chatwoot/consumidorEnvioChatwoot.test.ts scripts/check-database-drift.test.ts` cobre fronteira HTTP, regras de consumidores e ledger.
- A demonstração publicada tem critérios próprios no diagnóstico M2. O teste local usa conteúdo sintético e verifica o protocolo do banco, sem provar recibo emitido pelo Chatwoot.
