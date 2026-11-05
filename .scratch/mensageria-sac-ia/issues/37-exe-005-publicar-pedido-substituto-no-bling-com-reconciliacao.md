# 37 — EXE-005: Publicar pedido substituto no Bling com reconciliação

**Status:** draft — proposta local, aguardando aprovação da decomposição; não iniciado.
**Classificação:** FUTURE
**Risco:** alto. **Esforço relativo:** 3/3 (1 pequeno, 2 moderado, 3 maior; limitado a uma fatia verificável, não estimativa de dias).
**Blocked by:** [EXE-004](36-exe-004-confirmar-pagamento-e-autorizar-fulfillment-no-servidor.md), [MSG-007](18-msg-007-representar-efeito-ambiguo-e-impedir-retry-inseguro-na-outbox.md), [PRE-009](09-pre-009-unificar-cadastro-de-fornecedor-e-consulta-cnpj.md), [PRE-010](10-pre-010-remover-inferencia-de-icms-da-criacao-legada-de-contato.md)
**Decisões externas:** D9: guard no ERP/limitação de operadores externos comprovados antes de permitir emissão/expedição.

## Objetivo e entrega vertical

Substituto autorizado chega ao ERP com referência durável e sem alterar pedido original; ACK perdido gera reconciliação.

## Por que existe

Entrega comportamento necessário ao marco indicado abaixo, reaproveitando fronteiras existentes em vez de criar infraestrutura paralela.

## Arquivos / áreas prováveis

Bling order adapter; pedidos/SAC application; outbox; UI execução. Caminhos são pistas da main `e71354e`, não obrigação de mover pastas. Conferir fonte atual e AGENTS.md antes de implementar.

## Schema afetado

Pedido substituto e external_effect; authorization consumed_version; provider ref. Se houver mudança persistente, app, migration forward-only, constraints/índices/RLS, catálogo/ledger e testes SQL pertencem a esta mesma fatia. Não executar DDL remoto sem apresentação de alvo/SQL/validação/rollback/locks e autorização explícita.

## API afetada

POST pedido Bling e GET por referência exata; emissão/envio guardados. Validar request/response com Zod, falhas tipadas e contrato versionado. Não converter falha de provider em sucesso simulado.

## Env necessário

Bling test connection; modo permitido após sandbox/manual aprovado. Somente nomes e exemplos sanitizados em documentação; secrets fora de Git e do bundle, separados por ambiente.

## Segurança

Escopo deriva de sessão verificada ou conexão autenticada, nunca de organização passada apenas pelo cliente/modelo. Autorizar ação/capability separadamente; queries privilegiadas filtram organização. Aplicar invariantes específicos abaixo, testes cross-tenant e negação sem efeitos.

## LGPD

Minimizar conteúdo e identificadores; fixtures sintéticas; não logar CPF, tokens, cookies, mensagens privadas ou URLs assinadas. Dados novos entram no inventário e nos fluxos de exportação/retencão/eliminação do plano. Se este ticket habilita foto/provider novo, estender evidência de MSG-021 antes de dados reais.

## Invariantes

Nenhum efeito ERP antes de guard válido; numeroLoja só após contrato comprovado; criação remota não equivale a envio; não cancelar original como compensação.

## Failure modes

ACK perdido, busca zero/múltipla, perda do lock, approval expirada, webhook antes do ACK, cancelamento concorrente e ERP sem bloqueio nativo. Para cada efeito externo deste ticket, aplicar também os 17 casos da matriz em [arquitetura](../02-arquitetura.md): timeout, ACK perdido e 2xx inválido não comprovam ausência do efeito. Para fatia sem efeito externo, marcar os casos inaplicáveis com justificativa na evidência.

## Acceptance criteria

- [ ] Pedido remoto único e rastreável ou UNKNOWN; original intacto; recebimento de webhook converge sem duplicar estoque/título.
- [ ] Organização A/B, usuário sem capability e entrada inválida têm resultado comprovado, sem side effect indevido.
- [ ] Schema e aplicação foram verificados juntos em banco descartável, incluindo constraints e caminho de recuperação.
- [ ] Evidência anexada identifica SHA, ambiente, comandos, resultados e limitações; nenhum teste não executado é declarado aprovado.

## Testes obrigatórios

ACK perdido, busca zero/múltipla, perda do lock, approval expirada, webhook antes do ACK, cancelamento concorrente e ERP sem bloqueio nativo. Usar seam de domínio/adapter e contrato do comportamento; quando houver DB, executar testes reais de transação/concorrência em stack descartável. Gates de implementação: `npm test`, `npm run typecheck`, `npm run secrets:check`, `npm run lint:ratchet`, `npm run aislop`, `npm run build`. Somar `npm run test:db` para SQL, `npm run e2e -- <spec>` para jornada e gates de catálogo/boundaries disponíveis. Revisão final deve conferir evidências, não apenas mocks verdes.

## Sabotage / negative tests

Tentar contornar: Nenhum efeito ERP antes de guard válido; numeroLoja só após contrato comprovado; criação remota não equivale a envio; não cancelar original como compensação. Adulterar tenant, referência, versão ou payload relevante; duplicar requisição e interromper a operação no ponto crítico descrito nos testes. Resultado esperado: recusa/UNKNOWN/reconciliação conforme o contrato, nunca sucesso inventado ou repetição destrutiva.

## Observabilidade

Eventos de início, decisão, recusa e término com correlation_id, organização, recurso, versão e outcome; efeito/tentativa/lease quando aplicável. Demonstrar um evento de falha redigido e sua ligação à evidência de aceite. Métricas e auditoria seguem [plano](../02-arquitetura.md), sem conteúdo privado por padrão.

## Smoke

Executar a jornada descrita em “Objetivo e entrega vertical” com fixture sintética e verificar: Pedido remoto único e rastreável ou UNKNOWN; original intacto; recebimento de webhook converge sem duplicar estoque/título. Registrar referências locais/provider e fronteiras verificadas. Smoke real só no ambiente explicitamente autorizado; simulador deve ser identificado.

## Rollback

Pausar dispatch; reconciliar efeitos já em voo; cancelar somente substituto elegível por comando separado aprovado. Migration permanece forward-only; preservar histórico/tentativas e revalidar mensagens em voo. Nunca usar restauração ampla de grants, apagar ledger ou repetir POST desconhecido como recuperação.

## Documentação

Atualizar contrato/runbook da área e [baseline](../01-baseline-e-evidencias.md) quanto ao achado fechado. Anexar evidências sob pasta própria do ticket, sincronizar status/blockers no índice e registrar qualquer mudança de decisão arquitetural antes de codificar em torno dela.

## Bloqueia próxima fase?

Gate execução controlada; provar também fronteira de operador externo ERP. Consultar também os gates globais de piloto e execução em [índice](../03-tickets-e-dependencias.md). `BLOCKER` pode bloquear efeitos futuros sem impedir laboratório sintético isolado.
