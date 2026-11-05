# 42 — EXE-010: Liberar execução controlada com gates objetivos e kill switch

**Status:** draft — proposta local, aguardando aprovação da decomposição; não iniciado.
**Classificação:** FUTURE
**Risco:** alto. **Esforço relativo:** 3/3 (1 pequeno, 2 moderado, 3 maior; limitado a uma fatia verificável, não estimativa de dias).
**Blocked by:** [PRE-001](01-pre-001-registrar-tentativa-financeira-antes-da-criacao-no-bling.md), [PRE-002](02-pre-002-reconciliar-criacao-e-baixa-financeiras-sem-duplicar.md), [PRE-003](03-pre-003-arquivar-produto-e-preservar-itens-historicos.md), [PRE-004](04-pre-004-aplicar-delete-de-produto-bling-como-tombstone.md), [PRE-005](05-pre-005-aplicar-delete-de-contato-sem-recriar-cadastro.md), [PRE-006](06-pre-006-fechar-escrita-direta-em-catalogo-clientes-pedidos-e-estoque.md), [PRE-007](07-pre-007-fechar-escrita-direta-financeira-e-fiscal.md), [PRE-008](08-pre-008-proteger-mapeamento-de-conexoes-e-escopo-de-integracao.md), [PRE-009](09-pre-009-unificar-cadastro-de-fornecedor-e-consulta-cnpj.md), [PRE-010](10-pre-010-remover-inferencia-de-icms-da-criacao-legada-de-contato.md), [PRE-011](11-pre-011-alinhar-entitlements-pro-4-e-enterprise-10.md), [MSG-019](29-msg-019-validar-evals-e-sabotagem-da-jornada-de-atendimento.md), [MSG-020](31-msg-020-operar-piloto-com-metricas-backup-e-reconciliacao.md), [MSG-021](32-msg-021-fechar-privacidade-pii-e-liberacao-de-dados-reais.md), [EXE-005](37-exe-005-publicar-pedido-substituto-no-bling-com-reconciliacao.md), [EXE-007](39-exe-007-inspecionar-retorno-e-lancar-disposicao-uma-unica-vez.md)
**Decisões externas:** D11: proprietária aprova rollout e alçada automatizável; não existe autonomia irrestrita implícita.

## Objetivo e entrega vertical

Piloto permite somente comandos determinísticos expressamente aprovados/politicamente autorizados; botão de suspensão bloqueia novos efeitos e preserva reconciliação.

## Por que existe

Entrega comportamento necessário ao marco indicado abaixo, reaproveitando fronteiras existentes em vez de criar infraestrutura paralela.

## Arquivos / áreas prováveis

Release runbook; policy gates; integrações; métricas/evals e revisão. Caminhos são pistas da main `e71354e`, não obrigação de mover pastas. Conferir fonte atual e AGENTS.md antes de implementar.

## Schema afetado

Nenhum schema extra obrigatório; ledger de release/flags/auditoria existente. Se houver mudança persistente, app, migration forward-only, constraints/índices/RLS, catálogo/ledger e testes SQL pertencem a esta mesma fatia. Não executar DDL remoto sem apresentação de alvo/SQL/validação/rollback/locks e autorização explícita.

## API afetada

Flags por org/capacidade e bloqueio central de dispatch. Validar request/response com Zod, falhas tipadas e contrato versionado. Não converter falha de provider em sucesso simulado.

## Env necessário

Allowlist de tenants/providers, orçamento e responsável de plantão. Somente nomes e exemplos sanitizados em documentação; secrets fora de Git e do bundle, separados por ambiente.

## Segurança

Escopo deriva de sessão verificada ou conexão autenticada, nunca de organização passada apenas pelo cliente/modelo. Autorizar ação/capability separadamente; queries privilegiadas filtram organização. Aplicar invariantes específicos abaixo, testes cross-tenant e negação sem efeitos.

## LGPD

Minimizar conteúdo e identificadores; fixtures sintéticas; não logar CPF, tokens, cookies, mensagens privadas ou URLs assinadas. Dados novos entram no inventário e nos fluxos de exportação/retencão/eliminação do plano. Se este ticket habilita foto/provider novo, estender evidência de MSG-021 antes de dados reais.

## Invariantes

LLM continua sem tools arbitrárias; pagamento/estoque/identidade/histórico provados; nenhuma compensação automática destrutiva.

## Failure modes

Jornada completa sandbox; matriz 17 falhas por efeito habilitado; kill switch em voo; backup/restore; bypass API/DB/ERP; aprovação independente. Para cada efeito externo deste ticket, aplicar também os 17 casos da matriz em [arquitetura](../02-arquitetura.md): timeout, ACK perdido e 2xx inválido não comprovam ausência do efeito. Para fatia sem efeito externo, marcar os casos inaplicáveis com justificativa na evidência.

## Acceptance criteria

- [ ] Evidências de todos os P0 e gates anexadas; rollout por tenant; operação ambígua vai a revisão; zero efeito destrutivo sem policy/approval válido.
- [ ] Organização A/B, usuário sem capability e entrada inválida têm resultado comprovado, sem side effect indevido.
- [ ] A ausência de alteração persistente foi confirmada, ou o escopo foi atualizado antes de implementar.
- [ ] Evidência anexada identifica SHA, ambiente, comandos, resultados e limitações; nenhum teste não executado é declarado aprovado.

## Testes obrigatórios

Jornada completa sandbox; matriz 17 falhas por efeito habilitado; kill switch em voo; backup/restore; bypass API/DB/ERP; aprovação independente. Usar seam de domínio/adapter e contrato do comportamento; quando houver DB, executar testes reais de transação/concorrência em stack descartável. Gates de implementação: `npm test`, `npm run typecheck`, `npm run secrets:check`, `npm run lint:ratchet`, `npm run aislop`, `npm run build`. Somar `npm run test:db` para SQL, `npm run e2e -- <spec>` para jornada e gates de catálogo/boundaries disponíveis. Revisão final deve conferir evidências, não apenas mocks verdes.

## Sabotage / negative tests

Tentar contornar: LLM continua sem tools arbitrárias; pagamento/estoque/identidade/histórico provados; nenhuma compensação automática destrutiva. Adulterar tenant, referência, versão ou payload relevante; duplicar requisição e interromper a operação no ponto crítico descrito nos testes. Resultado esperado: recusa/UNKNOWN/reconciliação conforme o contrato, nunca sucesso inventado ou repetição destrutiva.

## Observabilidade

Eventos de início, decisão, recusa e término com correlation_id, organização, recurso, versão e outcome; efeito/tentativa/lease quando aplicável. Demonstrar um evento de falha redigido e sua ligação à evidência de aceite. Métricas e auditoria seguem [plano](../02-arquitetura.md), sem conteúdo privado por padrão.

## Smoke

Executar a jornada descrita em “Objetivo e entrega vertical” com fixture sintética e verificar: Evidências de todos os P0 e gates anexadas; rollout por tenant; operação ambígua vai a revisão; zero efeito destrutivo sem policy/approval válido. Registrar referências locais/provider e fronteiras verificadas. Smoke real só no ambiente explicitamente autorizado; simulador deve ser identificado.

## Rollback

Kill switch, assumir humano e reconciliar em voo; rollback de app compatível com SQL forward-only. Migration permanece forward-only; preservar histórico/tentativas e revalidar mensagens em voo. Nunca usar restauração ampla de grants, apagar ledger ou repetir POST desconhecido como recuperação.

## Documentação

Atualizar contrato/runbook da área e [baseline](../01-baseline-e-evidencias.md) quanto ao achado fechado. Anexar evidências sob pasta própria do ticket, sincronizar status/blockers no índice e registrar qualquer mudança de decisão arquitetural antes de codificar em torno dela.

## Bloqueia próxima fase?

Marco de execução controlada; não autoriza autonomia irrestrita. Consultar também os gates globais de piloto e execução em [índice](../03-tickets-e-dependencias.md). `BLOCKER` pode bloquear efeitos futuros sem impedir laboratório sintético isolado.
