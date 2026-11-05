# 35 — EXE-003: Criar cobrança da diferença no PSP do lojista

**Status:** draft — proposta local, aguardando aprovação da decomposição; não iniciado.
**Classificação:** FUTURE
**Risco:** alto. **Esforço relativo:** 3/3 (1 pequeno, 2 moderado, 3 maior; limitado a uma fatia verificável, não estimativa de dias).
**Blocked by:** [EXE-002](34-exe-002-criar-substituto-local-bloqueado-e-reservar-estoque.md), [MSG-007](18-msg-007-representar-efeito-ambiguo-e-impedir-retry-inseguro-na-outbox.md), [PRE-001](01-pre-001-registrar-tentativa-financeira-antes-da-criacao-no-bling.md), [PRE-002](02-pre-002-reconciliar-criacao-e-baixa-financeiras-sem-duplicar.md)
**Decisões externas:** D8: PSP/merchant do lojista e contrato de cobrança; Stripe billing ORBITA não decide esta escolha.

## Objetivo e entrega vertical

Delta positivo gera uma intenção de pagamento da conta do lojista, com URL segura e estado; retorno do cliente não confirma liquidação.

## Por que existe

Entrega comportamento necessário ao marco indicado abaixo, reaproveitando fronteiras existentes em vez de criar infraestrutura paralela.

## Arquivos / áreas prováveis

Novo payment application/adapter; SAC; UI de pagamento; Chatwoot mensagem. Caminhos são pistas da main `e71354e`, não obrigação de mover pastas. Conferir fonte atual e AGENTS.md antes de implementar.

## Schema afetado

payment_intents vinculadas a org/merchant/proposal; external_effects e tentativas. Se houver mudança persistente, app, migration forward-only, constraints/índices/RLS, catálogo/ledger e testes SQL pertencem a esta mesma fatia. Não executar DDL remoto sem apresentação de alvo/SQL/validação/rollback/locks e autorização explícita.

## API afetada

Criar/consultar intenção via port PSP; endpoint escolhido após decisão de provider. Validar request/response com Zod, falhas tipadas e contrato versionado. Não converter falha de provider em sucesso simulado.

## Env necessário

Credenciais/test account/webhook secret do PSP por lojista; separadas Stripe billing ORBITA. Somente nomes e exemplos sanitizados em documentação; secrets fora de Git e do bundle, separados por ambiente.

## Segurança

Escopo deriva de sessão verificada ou conexão autenticada, nunca de organização passada apenas pelo cliente/modelo. Autorizar ação/capability separadamente; queries privilegiadas filtram organização. Aplicar invariantes específicos abaixo, testes cross-tenant e negação sem efeitos.

## LGPD

Minimizar conteúdo e identificadores; fixtures sintéticas; não logar CPF, tokens, cookies, mensagens privadas ou URLs assinadas. Dados novos entram no inventário e nos fluxos de exportação/retencão/eliminação do plano. Se este ticket habilita foto/provider novo, estender evidência de MSG-021 antes de dados reais.

## Invariantes

Valor/moeda calculados no servidor; idempotency oficial; cobrança criada não libera pedido; UNKNOWN não cria outra cobrança.

## Failure modes

ACK perdido, 2xx inválido, 429/5xx, merchant errado, alteração de valor, link malicioso, clique duplo. Para cada efeito externo deste ticket, aplicar também os 17 casos da matriz em [arquitetura](../02-arquitetura.md): timeout, ACK perdido e 2xx inválido não comprovam ausência do efeito. Para fatia sem efeito externo, marcar os casos inaplicáveis com justificativa na evidência.

## Acceptance criteria

- [ ] Sandbox PSP selecionado contém no máximo uma intenção por comando; pagamento permanece pendente; URL callback não altera bloqueio.
- [ ] Organização A/B, usuário sem capability e entrada inválida têm resultado comprovado, sem side effect indevido.
- [ ] Schema e aplicação foram verificados juntos em banco descartável, incluindo constraints e caminho de recuperação.
- [ ] Evidência anexada identifica SHA, ambiente, comandos, resultados e limitações; nenhum teste não executado é declarado aprovado.

## Testes obrigatórios

ACK perdido, 2xx inválido, 429/5xx, merchant errado, alteração de valor, link malicioso, clique duplo. Usar seam de domínio/adapter e contrato do comportamento; quando houver DB, executar testes reais de transação/concorrência em stack descartável. Gates de implementação: `npm test`, `npm run typecheck`, `npm run secrets:check`, `npm run lint:ratchet`, `npm run aislop`, `npm run build`. Somar `npm run test:db` para SQL, `npm run e2e -- <spec>` para jornada e gates de catálogo/boundaries disponíveis. Revisão final deve conferir evidências, não apenas mocks verdes.

## Sabotage / negative tests

Tentar contornar: Valor/moeda calculados no servidor; idempotency oficial; cobrança criada não libera pedido; UNKNOWN não cria outra cobrança. Adulterar tenant, referência, versão ou payload relevante; duplicar requisição e interromper a operação no ponto crítico descrito nos testes. Resultado esperado: recusa/UNKNOWN/reconciliação conforme o contrato, nunca sucesso inventado ou repetição destrutiva.

## Observabilidade

Eventos de início, decisão, recusa e término com correlation_id, organização, recurso, versão e outcome; efeito/tentativa/lease quando aplicável. Demonstrar um evento de falha redigido e sua ligação à evidência de aceite. Métricas e auditoria seguem [plano](../02-arquitetura.md), sem conteúdo privado por padrão.

## Smoke

Executar a jornada descrita em “Objetivo e entrega vertical” com fixture sintética e verificar: Sandbox PSP selecionado contém no máximo uma intenção por comando; pagamento permanece pendente; URL callback não altera bloqueio. Registrar referências locais/provider e fronteiras verificadas. Smoke real só no ambiente explicitamente autorizado; simulador deve ser identificado.

## Rollback

Desligar novas cobranças; conciliar/cancelar expiradas segundo contrato, nunca apagar recibos. Migration permanece forward-only; preservar histórico/tentativas e revalidar mensagens em voo. Nunca usar restauração ampla de grants, apagar ledger ou repetir POST desconhecido como recuperação.

## Documentação

Atualizar contrato/runbook da área e [baseline](../01-baseline-e-evidencias.md) quanto ao achado fechado. Anexar evidências sob pasta própria do ticket, sincronizar status/blockers no índice e registrar qualquer mudança de decisão arquitetural antes de codificar em torno dela.

## Bloqueia próxima fase?

Gate delta positivo; depende decisão de PSP/merchant e contrato. Consultar também os gates globais de piloto e execução em [índice](../03-tickets-e-dependencias.md). `BLOCKER` pode bloquear efeitos futuros sem impedir laboratório sintético isolado.
