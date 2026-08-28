# ROPA — Registro de Operações de Tratamento (Record of Processing Activities)

**Ticket:** 15 — Mapear tratamento LGPD, papéis e RIPD (`orbita-mvp-producao-v2`).
**Commit analisado:** `36f1b231df1f50da2cd0a9e926e7a222dff81688` (branch `fix/ticket-15-lgpd-ripd-papeis`).
**Data:** 2026-08-27.

Cada linha é uma jornada real do produto, traçada UI/webhook → rota → serviço → repositório → banco/provider. **Toda base legal listada é uma candidata proposta pelo codificador para revisão jurídica — nenhuma está decidida.** Marcação `needs-legal-review` é obrigatória em cada linha, conforme o contrato do ticket. Consentimento só é proposto onde o tratamento é opcional e genuinamente revogável sem quebrar o serviço contratado; nas demais jornadas, propor consentimento como base padrão é proibido pelo ticket.

## 1. Cadastro e autenticação do lojista

- **Rota/serviço**: `POST /api/auth/register` → `supabaseServer.auth.signUp` (`src/app/api/auth/register/route.ts`).
- **Dados**: e-mail, senha, nome (item 1 do inventário).
- **Base legal candidata**: execução de contrato (LGPD art. 7º, V) — a conta é pré-requisito para usar o serviço contratado. **needs-legal-review**.
- **Controlador/operador/suboperador**: ORBITA = controlador (relação direta com o usuário que cria a conta); Supabase Auth = operador/suboperador de infraestrutura de autenticação.
- **Compartilhamento**: nenhum além do Supabase.
- **Transferência internacional**: possível, dependendo da região do projeto Supabase (não confirmada em código) — **needs-owner**: confirmar região do projeto Supabase.
- **Salvaguarda**: resposta indistinguível anti-enumeração de contas (`register.test.ts`, ticket 07), rate limit por IP fail-closed, senha nunca persistida pelo app (delegada ao Supabase Auth).
- **Owner**: proprietário do produto / responsável técnico.

## 2. Convite e gestão de organização (membership)

- **Rota/serviço**: `POST /api/organizacoes/[id]/convites` → `createOrgInvite` → RPC `criar_convite_organizacao`; aceite via `POST /api/convites/aceitar` → RPC `aceitar_convite_organizacao`.
- **Dados**: e-mail do convidado, papel, autor do convite, `user_id`/papel do membro (itens 6-9 do inventário).
- **Base legal candidata**: execução de contrato / legítimo interesse do lojista em administrar sua equipe. **needs-legal-review**.
- **Controlador/operador**: lojista (owner da organização) = controlador da decisão de convidar; ORBITA = operador da infraestrutura de convite/membership.
- **Compartilhamento**: nenhum provedor externo confirmado para o envio do e-mail de convite (gap registrado no inventário, item 8) — **needs-owner**: confirmar como o convite chega ao convidado hoje (link manual vs. e-mail automático).
- **Transferência internacional**: mesma do item 1 (banco Supabase).
- **Salvaguarda**: convite de uso único, expira em 7 dias, RLS restrita a admin/owner, reserva atômica de vaga de plano via `pg_advisory_xact_lock` (`database/49_entitlement_reserva_atomica_ordering.sql`, ticket 13).
- **Owner**: proprietário do produto.

## 3. Conexão OAuth Bling e cofre de credenciais

- **Rota/serviço**: `GET /api/bling/authorize` → `GET /api/bling/callback` (`src/app/api/bling/*`), `credentialsVault` (`src/lib/integrations/credentialsVault.ts`).
- **Dados**: transação OAuth (item 3), credenciais cifradas do lojista no Bling (item 21), tabela legada `integracoes_bling` ainda pendente de recifragem (item 22).
- **Base legal candidata**: execução de contrato entre lojista e ORBITA (o lojista contrata a integração). **needs-legal-review**.
- **Controlador/operador**: lojista = controlador da própria conta Bling; ORBITA = operador que armazena a credencial sob mandato do lojista para operar a integração; Bling = suboperador/serviço acionado pelo lojista via ORBITA.
- **Compartilhamento**: Bling (destino direto da autenticação).
- **Transferência internacional**: Bling é `api.bling.com.br` (indício de operação no Brasil, não confirmado como residência de dados) — **needs-owner**.
- **Salvaguarda**: transação OAuth de uso único com CAS (`consumir_transacao_oauth`), rate limit por IP/ator, cookie `HttpOnly`/`SameSite=Lax`/valor opaco, credenciais cifradas AES-256-GCM em `credenciais_integracao` com RLS fail-closed. **Risco não mitigado**: tabela legada `integracoes_bling` sem confirmação de criptografia — ver `ripd.md`.
- **Owner**: responsável técnico de integrações.

## 4. Sincronização de catálogo/clientes/pedidos/fiscal com Bling

- **Rota/serviço**: `POST /api/sync*`, `POST /api/bling/webhook`, `clienteRepository`/`produtoRepository`/`pedidoRepository` (tickets 08/10).
- **Dados**: `clientes` (item 11), endereço não persistido mas transitado (item 12), `pedidos`/`itens_pedido`/`nfes` (itens 14-15), `inbox_eventos_bling.payload` (item 28).
- **Base legal candidata**: execução do contrato entre o lojista e o cliente final dele (venda) — o ORBITA processa em nome do lojista. **needs-legal-review**.
- **Controlador/operador**: **lojista = controlador** dos dados de seus próprios clientes; **ORBITA = operador**; **Bling = suboperador** (subcontratado pelo operador para o mesmo fim). Este papel é por fluxo — não se estende a dados de conta do próprio lojista (ver item 1).
- **Compartilhamento**: Bling, bidirecional.
- **Transferência internacional**: mesma nota do item 3.
- **Salvaguarda**: isolamento multi-tenant por `organizacao_id` com FK composta e RLS canônica (ticket 08, pgTAP `catalogo_comercial_estoque_fiscal_organizacao.test.sql`), webhook com verificação HMAC e resolução de organização fail-closed (ticket 10), idempotência de webhook via `registrar_evento_inbox_bling`.
- **Owner**: responsável técnico de integrações + proprietário do produto (decisão de retenção do payload bruto).

## 5. Gestão comercial interna (CRUD clientes/produtos/pedidos/NF-e/estoque)

- **Rota/serviço**: `src/app/api/clientes/*`, `/produtos/*`, `/pedidos/*`, `/nfe`, `/dashboard`.
- **Dados**: mesmos do item 4, acessados/editados manualmente pelo lojista.
- **Base legal candidata**: execução de contrato entre lojista e cliente final; ORBITA como operador da ferramenta. **needs-legal-review**.
- **Controlador/operador**: lojista = controlador; ORBITA = operador.
- **Compartilhamento**: Bling (ao salvar, se sincronizado).
- **Transferência internacional**: mesma nota do item 3.
- **Salvaguarda**: `VerifiedOrganizationScope` obrigatório em todos os repositórios migrados (ticket 08); nenhuma rota aceita `organizacao_id` do cliente como autoridade.
- **Owner**: proprietário do produto.

## 6. Gestão financeira (contas a pagar/receber, fornecedores)

- **Rota/serviço**: `src/app/api/financeiro/*`, `financeiroRepository` (ticket 09).
- **Dados**: `fornecedores` (item 13), `contas_financeiras`/`titulos_financeiros` (item 16), tabela legada `financeiro` órfã (item 17).
- **Base legal candidata**: execução de contrato + possível obrigação legal fiscal/contábil (a confirmar qual norma se aplica a cada campo). **needs-legal-review**.
- **Controlador/operador**: lojista = controlador (dados dos próprios fornecedores/financeiro); ORBITA = operador; Bling = suboperador.
- **Compartilhamento**: Bling, bidirecional.
- **Transferência internacional**: mesma nota do item 3.
- **Salvaguarda**: FK composta `(id, organizacao_id)` recusa referência cross-tenant (pgTAP `financeiro_organizacao_ticket09.test.sql`), `upsertTitulo` idempotente via `onConflict`, logs só gravam `bling_id`/mensagem de erro, nunca valor/descrição (`09-final-evidence.md`).
- **Owner**: proprietário do produto. **needs-owner**: decisão sobre a tabela `financeiro` legada órfã (item 17 do inventário) e sobre por que `fornecedores` não é anonimizada no encerramento definitivo (ver `ripd.md`).

## 7. Conexão e atendimento via Chatwoot

- **Rota/serviço**: `POST /api/chatwoot/connect`, `/webhook/[conexaoId]`, `/send`, `/status`, `/sync` (ticket 11).
- **Dados**: `chatwoot_contacts` (item 18), `chatwoot_messages` (item 19), `inbox_eventos_chatwoot.payload` (item 20), credenciais cifradas (item 21).
- **Base legal candidata**: execução de contrato entre lojista e o contato que conversa (atendimento) — quando o contato é um cliente existente; legítimo interesse do lojista em prestar suporte, quando não há contrato prévio. **needs-legal-review** para diferenciar os dois casos.
- **Controlador/operador**: lojista = controlador dos dados do contato que fala com ele; ORBITA = operador; Chatwoot = suboperador (Cloud ou self-hosted, conforme `api_url` configurada pela organização).
- **Compartilhamento**: Chatwoot, bidirecional.
- **Transferência internacional**: Chatwoot Cloud é `app.chatwoot.com` por padrão (host dos EUA/global, não confirmado exatamente) — **needs-owner**: confirmar região quando a organização usa Chatwoot Cloud; instâncias self-hosted dependem da infraestrutura do próprio lojista.
- **Salvaguarda**: webhook por conexão com segredo único por organização (não mais um segredo global — correção de segurança do ticket 11), verificação HMAC + `timingSafeEqual`, minimização de payload (`avatar_url`/`thumbnail` removidos, `redactSensitiveData` aplicado antes de persistir), desambiguação `account_id`/`inbox_id` (migration 47) evita vazamento cross-tenant quando dois lojistas têm o mesmo `inbox_id`.
- **Owner**: responsável técnico de integrações.

## 8. Billing/assinatura SaaS via Stripe

- **Rota/serviço**: `POST /api/stripe/checkout`, `/portal`, `/webhook` (ticket 14).
- **Dados**: `assinaturas_organizacao` (item 23), `stripe_webhook_events.payload` (item 24).
- **Base legal candidata**: execução de contrato entre ORBITA e o lojista (relação direta de cobrança da assinatura). **needs-legal-review**.
- **Controlador/operador**: **ORBITA = controlador** (é o próprio ORBITA que cobra o lojista, relação direta, diferente das demais jornadas onde o lojista é controlador); Stripe = operador/suboperador de processamento de pagamento.
- **Compartilhamento**: Stripe.
- **Transferência internacional**: Stripe é provedor global (EUA/Irlanda conforme conta) — **needs-owner**: confirmar região da conta Stripe usada em produção e mecanismo de transferência (SCC/adequação).
- **Salvaguarda**: nenhum dado de cartão passa pelo servidor ORBITA (checkout/portal usam sessões hospedadas Stripe), assinatura de webhook verificada via SDK oficial (`stripe.webhooks.constructEvent`) antes de qualquer efeito, replay tratado como no-op, `return_path` allowlisted (não aceita URL absoluta do cliente).
- **Owner**: proprietário do produto. Ticket 14 permanece `needs-owner` para a jornada real de Test Mode (ver `.scratch/orbita-mvp-producao-v2/evidence/14-final-evidence.md` seção 6).

## 9. Entitlements/limites de plano

- **Rota/serviço**: `authorizeEntitlement` (`src/services/authorizeEntitlement.ts`), usado por `createOrgInvite` e potencialmente outras mutações (ticket 13).
- **Dados**: `historico_entitlements.metadata` (item 25), contagem de membros/conexões.
- **Base legal candidata**: execução de contrato (aplicação dos limites do plano contratado). **needs-legal-review**.
- **Controlador/operador**: ORBITA = controlador (é regra do próprio serviço ORBITA); não há dado de terceiro final aqui.
- **Compartilhamento**: nenhum.
- **Transferência internacional**: não aplicável (dado interno).
- **Salvaguarda**: política de bloqueio nunca impede `read`/`export`, mesmo com organização suspensa (`entitlementPolicy.ts`, testado explicitamente para preservar direito de acesso/portabilidade LGPD), reserva atômica de vaga via lock (ticket 13).
- **Owner**: proprietário do produto.

## 10. Ciclo de vida da organização: suspensão, retenção e encerramento

- **Rota/serviço**: RPCs `suspender_organizacao`, `reativar_organizacao`, `agendar_encerramento_organizacao`, `executar_encerramento_definitivo` (`database/35_suspensao_retencao_encerramento.sql`).
- **Dados**: `organizacoes.status`/`exclusao_agendada_para` (item 6), `historico_ciclo_vida_organizacao` (item 9), e todos os dados anonimizados/revogados no encerramento.
- **Base legal candidata**: execução de contrato (desligamento do serviço) + retenção por período de carência definido pelo produto (30 dias padrão). **needs-legal-review** quanto ao prazo correto e à base para cada categoria de dado retido durante a carência.
- **Controlador/operador**: ORBITA = operador executando a rotina; lojista = controlador da decisão de encerrar.
- **Compartilhamento**: revogação de `conexoes_integracao` (Bling/Chatwoot/Stripe) no encerramento definitivo — não é compartilhamento novo, é corte de acesso.
- **Transferência internacional**: não aplicável diretamente (ação local no banco Supabase).
- **Salvaguarda**: `executar_encerramento_definitivo` só é executável por `service_role`/`postgres` (RPC `security definer` com `revoke all` de `public`/`anon`), grava histórico auditável antes de apagar. **Lacuna identificada**: a anonimização (linhas 216-222 da migration 35) só cobre a tabela `clientes` — não cobre `fornecedores`, `chatwoot_contacts`, `chatwoot_messages`, `eventos_auditoria_sistema`, `inbox_eventos_bling`/`_chatwoot`, `outbox_eventos`, nem a tabela legada `integracoes_bling`. Ver `ripd.md` para o risco e o ticket de controle recomendado.
- **Owner**: proprietário do produto + responsável jurídico (prazo de retenção).

## 11. Auditoria e observabilidade

- **Rota/serviço**: RPC `registrar_evento_auditoria` (`database/36_auditoria_correlacao_telemetria.sql`), `src/lib/observability/logger.ts`.
- **Dados**: `eventos_auditoria_sistema` (item 26: `actor_id`, `ip_address`, `user_agent`), logs estruturados (item 27).
- **Base legal candidata**: legítimo interesse do controlador em segurança e prevenção de fraude (LGPD art. 7º, IX). **needs-legal-review** — em especial quanto à retenção indefinida de IP/user-agent, que pode não superar o teste de proporcionalidade sem prazo definido.
- **Controlador/operador**: ORBITA = controlador (é telemetria do próprio serviço, não dado repassado por conta do lojista).
- **Compartilhamento**: nenhum provedor terceiro de log identificado no código; destino real de stdout depende do host de produção (não mapeado — needs-owner).
- **Transferência internacional**: depende do host de produção (needs-owner).
- **Salvaguarda**: RLS restringe leitura de `eventos_auditoria_sistema` a owner/admin da própria organização; `logger.ts` redige segredos (`SENSITIVE_KEY_PATTERN`) mas **não** redige e-mail/nome/telefone/IP em `context` livre — gap.
- **Owner**: responsável técnico de segurança/observabilidade.

## 12. Jobs duráveis (inbox/outbox/sync)

- **Rota/serviço**: `outboxWorker.ts`, RPCs `reivindicar_lote_outbox`, `concluir_evento_outbox`, `liberar_leases_expirados_outbox` (ticket 12).
- **Dados**: `inbox_eventos_bling`/`_chatwoot.payload`, `outbox_eventos.payload`/`.response_body` (item 28).
- **Base legal candidata**: legítimo interesse operacional em garantir entrega confiável dos efeitos de integração contratados pelo lojista (execução de contrato, subordinada à jornada de origem — itens 4 e 7). **needs-legal-review**.
- **Controlador/operador**: segue o papel do fluxo de origem (lojista controlador quando o payload é de cliente/pedido; ORBITA operador).
- **Compartilhamento**: reenvio ao provedor de origem/destino apenas (Bling/Chatwoot); nenhum terceiro adicional.
- **Transferência internacional**: mesma nota dos itens 3/7.
- **Salvaguarda**: lease com expiração (`lease_expires_at`) previne perda silenciosa por worker morto, `FOR UPDATE SKIP LOCKED` real, redação de erro antes de persistir (`classifyError`/`redactSensitiveData`). **Lacuna identificada**: nenhuma das quatro tabelas tem TTL/purge de payload — retenção efetivamente indefinida. Ver `ripd.md`.
- **Owner**: responsável técnico de integrações.

## 13. Rate limiting anti-abuso

- **Rota/serviço**: `src/lib/rateLimit.ts` + `rateLimitStore.ts`, aplicado em `register`, `bling_authorize`, `bling_callback` (ticket 07).
- **Dados**: `limite_taxa_tentativas.chave` (item 5, pode conter IP).
- **Base legal candidata**: legítimo interesse em segurança/prevenção de abuso (LGPD art. 7º, IX). **needs-legal-review**.
- **Controlador/operador**: ORBITA = controlador.
- **Compartilhamento**: nenhum.
- **Transferência internacional**: não aplicável.
- **Salvaguarda**: fail-closed (503 se o store estiver indisponível, nunca abre a porteira), janela deslizante testada (`rateLimit.test.ts`).
- **Owner**: responsável técnico de segurança.

## Papéis do ORBITA — resumo por natureza do dado (não global)

| Natureza do dado | Papel do ORBITA | Controlador |
|---|---|---|
| Conta/login do próprio lojista (jornada 1) | Operador de infraestrutura sob Supabase; controlador da relação de conta | ORBITA |
| Dados de clientes finais/fornecedores do lojista, sincronizados via Bling (jornadas 4-6) | Operador | Lojista |
| Dados de contatos de atendimento via Chatwoot (jornada 7) | Operador | Lojista |
| Billing da assinatura SaaS do próprio lojista com o ORBITA (jornada 8) | Controlador (relação direta de cobrança) | ORBITA |
| Telemetria/auditoria de segurança do próprio serviço (jornadas 11-13) | Controlador | ORBITA |

Esta distinção por fluxo é a exigida pelo ticket ("não globalmente"); nenhum contrato de operador foi presumido — a existência de um contrato de processamento de dados (DPA) entre ORBITA e cada lojista não está confirmada no repositório e é **needs-owner**.
