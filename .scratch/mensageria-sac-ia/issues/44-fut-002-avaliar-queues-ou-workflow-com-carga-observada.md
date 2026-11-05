# 44 — FUT-002: Avaliar Queues ou Workflow com carga observada

**Status:** draft — proposta local, aguardando aprovação da decomposição; não iniciado.
**Classificação:** FUTURE
**Risco:** baixo. **Esforço relativo:** 2/3 (1 pequeno, 2 moderado, 3 maior; limitado a uma fatia verificável, não estimativa de dias).
**Blocked by:** [MSG-020](31-msg-020-operar-piloto-com-metricas-backup-e-reconciliacao.md)
**Decisões externas:** Nenhuma decisão comercial adicional específica; herda decisões aprovadas dos blockers e limites de ambiente do plano.

## Objetivo e entrega vertical

Usar métricas reais redigidas para decidir se worker PostgreSQL exige transporte gerenciado ou orquestração longa.

## Por que existe

Entrega comportamento necessário ao marco indicado abaixo, reaproveitando fronteiras existentes em vez de criar infraestrutura paralela.

## Arquivos / áreas prováveis

ADR/runtime observability; teste de carga isolado. Caminhos são pistas da main `e71354e`, não obrigação de mover pastas. Conferir fonte atual e AGENTS.md antes de implementar.

## Schema afetado

Nenhum schema de produção; protótipo descartável se aprovado. Se houver mudança persistente, app, migration forward-only, constraints/índices/RLS, catálogo/ledger e testes SQL pertencem a esta mesma fatia. Não executar DDL remoto sem apresentação de alvo/SQL/validação/rollback/locks e autorização explícita.

## API afetada

Nenhuma API pública nova. Validar request/response com Zod, falhas tipadas e contrato versionado. Não converter falha de provider em sucesso simulado.

## Env necessário

Conta de experimento e teto de custo se necessário. Somente nomes e exemplos sanitizados em documentação; secrets fora de Git e do bundle, separados por ambiente.

## Segurança

Escopo deriva de sessão verificada ou conexão autenticada, nunca de organização passada apenas pelo cliente/modelo. Autorizar ação/capability separadamente; queries privilegiadas filtram organização. Aplicar invariantes específicos abaixo, testes cross-tenant e negação sem efeitos.

## LGPD

Minimizar conteúdo e identificadores; fixtures sintéticas; não logar CPF, tokens, cookies, mensagens privadas ou URLs assinadas. Dados novos entram no inventário e nos fluxos de exportação/retencão/eliminação do plano. Se este ticket habilita foto/provider novo, estender evidência de MSG-021 antes de dados reais.

## Invariantes

Não adicionar ambos automaticamente; domínio e outbox continuam fonte durável; não prometer exactly-once.

## Failure modes

Comparar crash, backlog, ordering, custo e recuperação do mesmo cenário nos candidatos necessários. Para cada efeito externo deste ticket, aplicar também os 17 casos da matriz em [arquitetura](../02-arquitetura.md): timeout, ACK perdido e 2xx inválido não comprovam ausência do efeito. Para fatia sem efeito externo, marcar os casos inaplicáveis com justificativa na evidência.

## Acceptance criteria

- [ ] ADR escolhe manter A ou migrar uma capacidade com plano de corte; métrica justifica decisão.
- [ ] Organização A/B, usuário sem capability e entrada inválida têm resultado comprovado, sem side effect indevido.
- [ ] A ausência de alteração persistente foi confirmada, ou o escopo foi atualizado antes de implementar.
- [ ] Evidência anexada identifica SHA, ambiente, comandos, resultados e limitações; nenhum teste não executado é declarado aprovado.

## Testes obrigatórios

Comparar crash, backlog, ordering, custo e recuperação do mesmo cenário nos candidatos necessários. Usar seam de domínio/adapter e contrato do comportamento; quando houver DB, executar testes reais de transação/concorrência em stack descartável. Gates de implementação: `npm test`, `npm run typecheck`, `npm run secrets:check`, `npm run lint:ratchet`, `npm run aislop`, `npm run build`. Somar `npm run test:db` para SQL, `npm run e2e -- <spec>` para jornada e gates de catálogo/boundaries disponíveis. Revisão final deve conferir evidências, não apenas mocks verdes.

## Sabotage / negative tests

Tentar contornar: Não adicionar ambos automaticamente; domínio e outbox continuam fonte durável; não prometer exactly-once. Adulterar tenant, referência, versão ou payload relevante; duplicar requisição e interromper a operação no ponto crítico descrito nos testes. Resultado esperado: recusa/UNKNOWN/reconciliação conforme o contrato, nunca sucesso inventado ou repetição destrutiva.

## Observabilidade

Eventos de início, decisão, recusa e término com correlation_id, organização, recurso, versão e outcome; efeito/tentativa/lease quando aplicável. Demonstrar um evento de falha redigido e sua ligação à evidência de aceite. Métricas e auditoria seguem [plano](../02-arquitetura.md), sem conteúdo privado por padrão.

## Smoke

Executar a jornada descrita em “Objetivo e entrega vertical” com fixture sintética e verificar: ADR escolhe manter A ou migrar uma capacidade com plano de corte; métrica justifica decisão. Registrar referências locais/provider e fronteiras verificadas. Smoke real só no ambiente explicitamente autorizado; simulador deve ser identificado.

## Rollback

Manter runtime PostgreSQL e descartar protótipo. Migration permanece forward-only; preservar histórico/tentativas e revalidar mensagens em voo. Nunca usar restauração ampla de grants, apagar ledger ou repetir POST desconhecido como recuperação.

## Documentação

Atualizar contrato/runbook da área e [baseline](../01-baseline-e-evidencias.md) quanto ao achado fechado. Anexar evidências sob pasta própria do ticket, sincronizar status/blockers no índice e registrar qualquer mudança de decisão arquitetural antes de codificar em torno dela.

## Bloqueia próxima fase?

Não bloqueia MVP; acionado por evidência de carga/complexidade. Consultar também os gates globais de piloto e execução em [índice](../03-tickets-e-dependencias.md). `BLOCKER` pode bloquear efeitos futuros sem impedir laboratório sintético isolado.
