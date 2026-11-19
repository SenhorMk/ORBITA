# Bot real do Portal do Haux

MVP restrito à organização `c75eb92d-9222-49cc-ac0f-6aebaf8fa69f`, conexão G8 `bc55e20a-dd17-416c-9343-c511e3cd0b1b`, conta Chatwoot 2, WebWidget inbox 1. Não atende WhatsApp. O worker usa Gemini por `@ai-sdk/google`, sem fallback falso. O envio continua exclusivamente no worker de outbox existente.

## Comportamento

A IA acolhe, agradece e pergunta o que a pessoa precisa em português. O modelo escolhe combinações de frases aprovadas; não existe campo de texto livre enviado ao cliente. Toda resposta se identifica como automatizada. Este MVP ainda não consulta catálogo comercial ou pedido verificado: dúvidas de produtos, preço, estoque, pagamento, entrega e decisões comerciais vão para humano, assim como casos sensíveis ou incertos. Não apresentar a limitação como consulta de catálogo implantada.

Uma conversa nova só entra em IA depois da prova assinada de criação, do corte temporal aprovado e da leitura real de status/responsável no Chatwoot. O webhook precisa assinar também `conversation_created` e `conversation_updated`, preservando as três assinaturas G8 anteriores. Nunca reconstruir entrega assinada por conta própria nem habilitar conversas antigas por um UPDATE amplo.

Assumir pelo cockpit ORBITA grava o fence que invalida saídas pendentes. A IA permanece em silêncio até devolução explícita pelo responsável, com resumo, projeção confirmada e mensagem nova. Um clique somente no Chatwoot depende da chegada do webhook e da observação do canal; a fronteira de autorização imediata do MVP é o controle ORBITA. Efeito HTTP já em voo não pode ser cancelado nem reenviado cegamente; preservar `unknown` para conciliação.

## Pré-requisitos de ativação

1. D05 publicado e migrations 93–96 nas ordens 96–99, com validação por etapa.
2. Migrations aditivas desta branch: 97/98/99, ordens 100/101/102. Não foram autorizadas implicitamente pela autorização limitada às ordens 96–99. Submeter o plano exato, hashes, validações e impacto antes de qualquer DDL remoto. As tabelas novas nascem sem acesso direto e com RLS; configuração de runtime e flags nasce desligada. SQL forward-only, com lock_timeout de 5 segundos na migration de limites; em falha, parar e corrigir para frente.
3. Validar a credencial G8 real: Administrator, conta 2, inbox 1, autoassignment desligado. A leitura em 19/11 confirmou esses valores; não alterou usuário nem papel.
4. Aprovar explicitamente o executor vigente da organização e seu grant em `sac_executores_autorresposta`; configurar somente a conexão/inbox Haux em `chatwoot_ai_runtime`, com corte temporal e limite diário aprovados. A primeira ativação exige `conversa_teste_externa` igual ao ID da conversa sintética e `clientes_liberados=false`; a constraint recusa runtime ativo sem essa restrição. Projeção, geração, triagem e despacho respeitam o mesmo filtro. Depois do teste integrado aprovado, uma operação explícita pode liberar clientes e retirar a restrição. Não conceder a capacidade pelo navegador nem usar membership de outro tenant.
5. O cockpit consulta `ai_first_disponivel` no banco para permitir a devolução explícita. A RPC exige runtime vigente e políticas global/organização ativas; erro ou resposta diferente de verdadeiro bloqueia. Não depende de editar flag da Vercel. `HAUX_BOT_ENABLED` continua sendo o interruptor de inicialização do worker. Conferir as políticas por `estado_autorresposta`; ligar apenas na janela do teste integrado, sem liberar clientes antes do aceite.

## Configuração e teste real

Arquivo local fora do Git: `C:\Users\kakau\orbita-infra\protegido\haux-bot.env`. Foi preparado com os parâmetros G8 existentes, bot desligado e chave Gemini vazia. Inserir `GOOGLE_GENERATIVE_AI_API_KEY` diretamente ali; nunca no chat, em NEXT_PUBLIC, no Git ou em logs. `SAC_RESPOSTA_MODELO=gemini-3.8-flash` é a configuração inicial; a chamada real deve confirmar disponibilidade para a chave antes da ativação. Usar projeto Google com faturamento e limite de gastos definidos pelo titular.

Carregar o arquivo protegido no processo, mantendo seus valores fora da linha de comando. `scripts/smoke-haux-gemini.ts` faz uma única chamada real com saudação sintética e exige resultado Google válido. Não toca Chatwoot nem banco. Falha ou chave ausente é falha explícita; nenhum fake é usado.

O compose `infra/worker/haux-bot.compose.yml` cria somente o container próprio do bot e usa a rede Chatwoot existente. Informar `HAUX_BOT_ENV_FILE` com o caminho protegido e `HAUX_BOT_IMAGE_TAG` com o SHA validado. A entrada real é `worker-haux-bot.js`; não usar a entrada de ensaio D08, que continua limitada ao modelo falso e laboratório local.

Após o smoke Gemini aprovado, usar uma conversa WebWidget de teste nova no Portal do Haux, criada depois do corte. Exigir: mensagem real aceita pelo webhook G8, uma única intenção automática na outbox, um recibo real e uma única mensagem pública no Chatwoot; retry da mesma entrega sem duplicação; assumir pelo cockpit e mandar nova mensagem sem resposta IA; devolver explicitamente e mandar mensagem nova para permitir retomada. Registrar IDs e estados, sem tokens, dados pessoais ou payload bruto. Só depois liberar atendimento automático a clientes.

## Gastos e desligamento

Triagem: limite diário de início de execução do MSG-013, padrão local 20, no máximo duas chamadas por execução, 640 tokens de saída por chamada e sem retries invisíveis do SDK. Resposta: reserva durável por tentativa antes da chamada, com limite configurado no runtime entre 0 e 100 por dia UTC, e 160 tokens de saída. Lease vencida/queda do processo não apaga a reserva de custo. Ao esgotar a cota, nenhuma chamada adicional é feita e a conversa vai para humano. O limite local não configura nem substitui o orçamento de faturamento do Google.

Para corte imediato de novos despachos, executar `scripts/parar-haux-bot.ts` com o ambiente protegido: ele chama `desligar_runtime_ai_first`, que grava `ativo=false` sob a mesma trava do ingresso/despacho. Funciona mesmo se a chave Gemini tiver sido removida. Exigir retorno confirmado; se falhar, não declarar bot desligado. A política de emergência existente também pode ser desligada pelo operador autorizado. Não confundir o corte durável com apenas parar um processo.

SIGINT/SIGTERM abortam a chamada ao modelo e solicitam o mesmo fence durável. O worker, ao terminar, remove o heartbeat. Queda abrupta tem expiração de 30 segundos. Reativação exige operação separada; o script de parada nunca liga o runtime.

## Evidências já obtidas nesta branch

- Testes de identidade automática, saída sem texto livre, handback, configuração e parada sem chave.
- PostgreSQL 17 real isolado: aplicação da cadeia aditiva; 85 verificações pgTAP de controle e 68 de autorresposta.
- Runner oficial Supabase PostgreSQL 17: a base D05 reproduziu exatamente `4e588cdc5ae46a01bbae919bb4935b0a25652c387bc7844a3a42a4ef3136c5d3`; a referência aditiva é regenerada no mesmo runner a cada mudança SQL. Não foi usada a referência nativa PG16 do D08.
- Jornada de worker e disputas reais de trava PostgreSQL reaproveitada do D08: geração única, ingresso versus despacho, despacho concorrente, takeover, handback, unknown sem replay, cota esgotada sem chamada adicional e desligamento limitado ao tenant. Modelo e transporte dessa prova automatizada são fixtures explícitas, não evidência de chamada externa.
- Chamada real Gemini e resposta automática real Chatwoot: pendentes de chave e janela operacional. Não estão aprovadas por estes testes locais.
