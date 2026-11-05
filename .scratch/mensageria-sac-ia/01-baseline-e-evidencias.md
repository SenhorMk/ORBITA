# Baseline e evidências — 08/10/2026

## Escopo e método

Análise estática da main canônica, contratos públicos e skills locais. Não é certificação do banco implantado nem smoke de providers. Não houve leitura de credenciais, consulta de dados pessoais, alteração remota, instalação de dependências, branch, commit, PR ou implementação.

`gh api repos/SenhorMk/orbita/branches/main` confirmou **e71354ee3f05f95436f82620b0303c7221f4f493**. `gh pr list --state open` retornou `[]`. [PR #106](https://github.com/SenhorMk/ORBITA/pull/106) está MERGED, merge `8b456b67971235da68e932b6eb4e36cce763bb8b`, em 06/10/2026 às 21:55:35 de São Paulo; o merge é ancestral da main confirmada. [Quality gates da main](https://github.com/SenhorMk/ORBITA/actions/runs/37689556961) aparece completed/success. Isso não comprova migrations aplicadas nem funcionamento de canais reais.

O checkout aninhado disponível está em `bdfcc8f7fb59973a88aa21f32ee2e764a40248aa`. Para não alterar seus arquivos, foram obtidos os objetos da main com `fetch --no-tags --no-write-fetch-head` e extraído um snapshot temporário. A análise abaixo usa esse SHA remoto, não o HEAD antigo. O status inicial do checkout estava limpo. O arquivo do usuário foi lido integralmente.

O Graphify disponível é de 30/08/2026, corpus `src`, 2.095 nós e 4.769 relações. Serviu apenas como índice para OutboxService, ChatwootAdapter, FinanceiroRepository e suas áreas. Está desatualizado para esta main; não foi reconstruído, pois esta sessão não altera fronteiras nem instala ferramentas. Toda conclusão material foi conferida no fonte remoto extraído.

## Estado real

| Área | Evidência na main | Implicação |
|---|---|---|
| Stack | [package.json](https://github.com/SenhorMk/ORBITA/blob/e71354ee3f05f95436f82620b0303c7221f4f493/package.json): Next 16.3.6, React 19.2.4, Supabase JS ^2.112.3, Zod ^4.4.3, pg, Stripe; Vitest e Playwright | Não existe `ai`, `workflow` ou `@vercel/queue` declarado. Integrar ao stack atual, sem Eve. |
| Arquitetura | `src/app/api`, `src/services`, `src/repositories`, `src/domain`, `src/lib` | Camadas existentes e algumas fronteiras de domínio; monólito modular incremental. |
| Identidade | `src/lib/auth.ts`, `organizationAuthorization.ts`, `requestOrganizationContext.ts`, `verifiedOrganizationScope.ts` | Auth.getUser verifica bearer; membership e seleção persistida resolvem organização; capacidades atuais são grossas (`organization:access/manage`). SAC precisa capacidades próprias. |
| Persistência | `database/03…72`, `schema_master.sql`, `migrations.lock.json`, `catalog-reference.json`, `supabase/tests/database` | Seguir ledger e ordenação reais; não reservar número de migration agora nem assumir contagem de arquivos igual ao maior prefixo. |
| Inbox | migrations 28/29; `blingInboxService.ts`, `chatwootInboxService.ts` | Já existe durabilidade/dedup parcial. Não criar segunda inbox paralela sem necessidade. |
| Jobs | migration 30 e `sync_jobs`; checkpoint por organização na 65 | Sync tem estado/leases. Não reutilizar jobs de sync como SAC; reaproveitar técnica e runtime de polling, mantendo tipos separados. |
| Outbox | migrations 31/48; `outboxService.ts`, `outbox/outboxWorker.ts` | Há claim com lease/SKIP LOCKED, retry e dead letter; nenhum caller de produção de `runOutboxWorkerOnce`/`drainOutboxWorker` encontrado. |
| Chatwoot | `src/services/chatwoot/*`, `src/app/api/chatwoot/*`, `docs/integrations/chatwoot-contract.md` | HMAC, account binding, schemas, API adapter e espelhos já existem. Não é integração do zero. |
| Pedidos | `pedidoRepository.ts`; venda manual e migrations 53,57,59,60,66,67,68 | Já existe referência durável e reconciliação de venda manual, corrida com webhook e proteção de estoque. Reaproveitar decisões, sem supor que criação financeira herda essas garantias. |
| Estoque | `produtos.estoque/estoque_reservado`, RPCs e migrations 56,58,66,67 | Consulta de disponível deve descontar reserva e carregar frescor; execução exige reserva atômica e ledger idempotente. |
| Billing | `src/services/stripe/*`, `src/lib/stripe/stripeWebhookHandler.ts`, migrations 34/49 | Stripe atual cobra assinatura ORBITA. Não é prova de infraestrutura para receber pagamento de cliente final do lojista. |
| Privacidade | `src/domain/privacy`, `src/services/privacy`, migrations 50/51, `docs/privacy/*` | Estender inventário, retenção e direitos do titular; não criar política concorrente. Contratos/regiões dos fornecedores permanecem pendentes no inventário existente. |
| Telemetria | `src/lib/observability/logger.ts`, `src/lib/dadosSensiveis.ts`, migrations 36/52/69/71 | Há logger/redação e auditoria. Algumas rotas ainda usam console/mensagens do provider; observar fronteiras de mensageria especificamente. |

## Revalidação dos blockers

As referências abaixo apontam à mesma [árvore fixa](https://github.com/SenhorMk/ORBITA/tree/e71354ee3f05f95436f82620b0303c7221f4f493). “Confirmado” significa confirmado no código versionado, não explorado remotamente.

| Achado | Estado | Evidência e consequência |
|---|---|---|
| FIN-01 | Confirmado | `src/app/api/financeiro/despesaHandler.ts`: `sincronizarComBling` chama `criarContaPagar` antes de `salvarTitulo`; falha retorna como recusa. Não há identidade de tentativa persistida antes do POST. Criação e baixa são efeitos distintos. ACK perdido pode levar a duplicação por retry humano. |
| WH-01 produto | Confirmado | `src/app/api/bling/webhook/route.ts:293–318`: ramo de produto/estoque usa `processProdutoEvent`; apenas pedido testa `isDeletionEvent`. Delete pode cair em leitura/upsert. |
| WH-01 contato | Confirmado | Mesmo arquivo, ramo de contato chama `processContatoEvent` independentemente da ação; nome ausente pode virar `Cliente #id`. |
| SEC-01 | Confirmado no SQL versionado | migrations 22/23/24 concedem SELECT/INSERT/UPDATE/DELETE a authenticated em tabelas centrais; 45 mantém policies de títulos por membership. A 37 fecha RPCs, não elimina esses grants de tabelas. Inventariar cumulativamente 09–72 e callers antes de revogar. Confirmar catálogo real no ticket, com leitura autorizada. |
| SEC-01 conexões | Exposição adicional a revisar | migration 25 concede DML em `conexoes_integracao`. Integridade do mapeamento de conexões participa da autoridade de webhooks. Testar se constraints/RLS impedem cada mutação indevida; não confundir grant encontrado com exploração comprovada. |
| Produto histórico | Confirmado | `produtoRepository.ts:223` faz `.delete()`; `src/app/api/produtos/delete/handler.ts` exclui no Bling e depois localmente. Mudar para arquivamento e proteger referências históricas; não basta tratar webhook. |
| Fornecedor | Confirmado | `LancamentoDeDespesa.tsx:80–107` envia `cpf_cnpj`, `cidade`, `estado` e espera DTO de fornecedor; route lê `cnpj`, `municipio`, `uf`, devolve resposta crua e força `indicadorIe:1`. Consulta ainda sai do browser para BrasilAPI. |
| ICMS residual | Confirmado | `src/services/bling.ts:786–806` infere indicador 1 de documento com 14 dígitos. Venda manual cria contato por caminho legado (`envioAoBling.ts`/port); contrato precisa indicador explícito ou desconhecido tratado sem inferência. |
| Planos | Divergência com requisito comercial confirmado | migration 33 semeia Starter=3, Pro=10, Enterprise=1000 membros; BillingPanel lê esses limites. O pedido exige Pro=4/Enterprise=10. Não foi confirmada a configuração efetivamente implantada nem política de grandfathering. |
| Identidade Chatwoot | Novo blocker confirmado | migration 27 usa `id int primary key` global para contacts/conversations/messages. Índices `(organizacao_id,id)` não removem PK global. Upserts em `chatwootWebhookPersistence.ts` usam id remoto sem conflito composto. Instalações diferentes podem colidir. |
| Dedup Chatwoot | Novo blocker confirmado | `chatwootInboxService.ts:40–69`: `message_updated` usa mesmo id; status usa conversa+status. Updates sucessivos e reabertura repetida podem ser descartados como duplicata. Chave não inclui conexão; delivery header não está no RawDelivery atual. |
| Atomicidade inbound | Gap confirmado | `chatwootWebhookPersistence.ts` grava contato, conversa e mensagem em chamadas separadas; conclusão da inbox é outra operação. Falha parcial exige transação, não apenas upserts. |
| Outbound | Novo blocker confirmado | `src/app/api/chatwoot/send/route.ts:128` usa `Date.now()` como identidade, enfileira e envia inline sem lease; `saveMessageLocally` atualiza conversa por id. Não ativar consumidor sobre backlog existente antes do corte e reconciliação. |
| Retry de efeitos | Gap confirmado | `outboxService.ts:classifyError` classifica timeout/network/5xx por texto como transitório; `outboxWorker.ts` só distingue success/error. Não representa UNKNOWN para criação ambígua. |

Os callers de navegador encontrados incluem leituras diretas de clientes/produtos em `ManualOrderModal.tsx` e espelho da mensageria. O levantamento preliminar não autoriza afirmar que não há DML legítimo em nenhum caller; cada ticket SEC exige inventário completo de imports, RPCs, Realtime, Storage e rotas antes de restringir. Preservar leituras autorizadas; minimizar colunas de PII em separado.

## Skills usadas e precedência

Já instaladas e lidas: Graphify, orbita-architecture e sua referência; build-agents; ai-sdk; create-a-backend; queues; workflow; supabase; supabase-postgres-best-practices; react-best-practices; verification; orbita-security; orbita-observability; orbita-integrations (Chatwoot/webhooks); orbita-database; orbita-bling; orbita-modular-monolith; domain-modeling; env-vars; ai-gateway. Referências internas de segurança, integração, logging, banco, Bling e boundaries foram lidas.

`to-tickets` foi localizado em `.agents/skills/to-tickets/SKILL.md` na pasta de trabalho. Nenhuma instalação necessária. Não foi encontrada skill dedicada de WhatsApp/Meta ou PII no catálogo disponibilizado; os equivalentes disponíveis e documentação oficial cobrem essas áreas. Skill-installer foi consultada durante a descoberta; nenhum pacote foi instalado.

As instruções do usuário prevalecem: não executar bootstrap Eve, instalar AI SDK, puxar envs, alterar banco ou usar database-sentinel. Orientação antiga de skill que cita Sentinel foi desconsiderada conforme AGENTS.md. O fluxo to-tickets será usado para elaborar fatias e dependências; sua etapa de publicação exige aprovação da decomposição. Até lá, arquivos são **rascunhos**, não `ready-for-agent`.

## Limites da verificação

Não foram executados testes, build, migrations ou smoke reais nesta sessão documental. Há evidência remota de CI verde, não resultado de execução local. Catálogo SQL implantado, versão real do Chatwoot, assinatura HMAC dessa instância, WABA/número Meta, contas de pagamento, DPAs e orçamento exigem evidência nos respectivos tickets. Documentação Meta respondeu HTTP 429 nesta pesquisa; tarifas, janela e permissões deverão ser revalidadas antes do piloto. Isso não muda a escolha de canal solicitada.
