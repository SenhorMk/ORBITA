# 26 — MSG-015: Propor, editar e decidir resolução sem executar troca

**Status:** draft — proposta local, aguardando aprovação da decomposição; não iniciado.
**Classificação:** MVP
**Risco:** alto. **Esforço relativo:** 3/3 (1 pequeno, 2 moderado, 3 maior; limitado a uma fatia verificável, não estimativa de dias).
**Blocked by:** [MSG-009](20-msg-009-assumir-e-devolver-atendimento-com-versao-e-nota-privada.md), [MSG-012](23-msg-012-recomendar-ate-tres-alternativas-validas-de-produto.md), [MSG-014](25-msg-014-responder-com-fatos-validados-e-encaminhar-resumo-humano.md)
**Decisões externas:** Nenhuma decisão comercial adicional específica; herda decisões aprovadas dos blockers e limites de ambiente do plano.

## Objetivo e entrega vertical

Atendente vê proposta com três alternativas quando disponíveis e delta; aprovar/rejeitar/editar registra decisão auditada, sem efeitos de ERP.

## Por que existe

Entrega comportamento necessário ao marco indicado abaixo, reaproveitando fronteiras existentes em vez de criar infraestrutura paralela.

## Arquivos / áreas prováveis

Domínio SAC/proposals; UI ORBITA de revisão; notas Chatwoot. Caminhos são pistas da main `e71354e`, não obrigação de mover pastas. Conferir fonte atual e AGENTS.md antes de implementar.

## Schema afetado

resolution_proposals e sac_approvals versionadas, política/digest/validade. Se houver mudança persistente, app, migration forward-only, constraints/índices/RLS, catálogo/ledger e testes SQL pertencem a esta mesma fatia. Não executar DDL remoto sem apresentação de alvo/SQL/validação/rollback/locks e autorização explícita.

## API afetada

Criar proposta, editar nova versão, decidir por capability e CAS. Validar request/response com Zod, falhas tipadas e contrato versionado. Não converter falha de provider em sucesso simulado.

## Env necessário

Nenhum env novo. Somente nomes e exemplos sanitizados em documentação; secrets fora de Git e do bundle, separados por ambiente.

## Segurança

Escopo deriva de sessão verificada ou conexão autenticada, nunca de organização passada apenas pelo cliente/modelo. Autorizar ação/capability separadamente; queries privilegiadas filtram organização. Aplicar invariantes específicos abaixo, testes cross-tenant e negação sem efeitos.

## LGPD

Minimizar conteúdo e identificadores; fixtures sintéticas; não logar CPF, tokens, cookies, mensagens privadas ou URLs assinadas. Dados novos entram no inventário e nos fluxos de exportação/retencão/eliminação do plano. Se este ticket habilita foto/provider novo, estender evidência de MSG-021 antes de dados reais.

## Invariantes

Edição invalida aprovação; cliente não aprova em nome do funcionário; aprovação desta fase não aciona execução.

## Failure modes

Duas aprovações, versão antiga, expirado, preço alterado, usuário removido, link copiado por outra org. Para cada efeito externo deste ticket, aplicar também os 17 casos da matriz em [arquitetura](../02-arquitetura.md): timeout, ACK perdido e 2xx inválido não comprovam ausência do efeito. Para fatia sem efeito externo, marcar os casos inaplicáveis com justificativa na evidência.

## Acceptance criteria

- [ ] Aprovação exige versão/digest atuais e aparece na auditoria; nenhum adapter Bling/payment/stock é chamado.
- [ ] Organização A/B, usuário sem capability e entrada inválida têm resultado comprovado, sem side effect indevido.
- [ ] Schema e aplicação foram verificados juntos em banco descartável, incluindo constraints e caminho de recuperação.
- [ ] Evidência anexada identifica SHA, ambiente, comandos, resultados e limitações; nenhum teste não executado é declarado aprovado.

## Testes obrigatórios

Duas aprovações, versão antiga, expirado, preço alterado, usuário removido, link copiado por outra org. Usar seam de domínio/adapter e contrato do comportamento; quando houver DB, executar testes reais de transação/concorrência em stack descartável. Gates de implementação: `npm test`, `npm run typecheck`, `npm run secrets:check`, `npm run lint:ratchet`, `npm run aislop`, `npm run build`. Somar `npm run test:db` para SQL, `npm run e2e -- <spec>` para jornada e gates de catálogo/boundaries disponíveis. Revisão final deve conferir evidências, não apenas mocks verdes.

## Sabotage / negative tests

Tentar contornar: Edição invalida aprovação; cliente não aprova em nome do funcionário; aprovação desta fase não aciona execução. Adulterar tenant, referência, versão ou payload relevante; duplicar requisição e interromper a operação no ponto crítico descrito nos testes. Resultado esperado: recusa/UNKNOWN/reconciliação conforme o contrato, nunca sucesso inventado ou repetição destrutiva.

## Observabilidade

Eventos de início, decisão, recusa e término com correlation_id, organização, recurso, versão e outcome; efeito/tentativa/lease quando aplicável. Demonstrar um evento de falha redigido e sua ligação à evidência de aceite. Métricas e auditoria seguem [plano](../02-arquitetura.md), sem conteúdo privado por padrão.

## Smoke

Executar a jornada descrita em “Objetivo e entrega vertical” com fixture sintética e verificar: Aprovação exige versão/digest atuais e aparece na auditoria; nenhum adapter Bling/payment/stock é chamado. Registrar referências locais/provider e fronteiras verificadas. Smoke real só no ambiente explicitamente autorizado; simulador deve ser identificado.

## Rollback

Desabilitar decisões novas; manter histórico e assumir humano. Migration permanece forward-only; preservar histórico/tentativas e revalidar mensagens em voo. Nunca usar restauração ampla de grants, apagar ledger ou repetir POST desconhecido como recuperação.

## Documentação

Atualizar contrato/runbook da área e [baseline](../01-baseline-e-evidencias.md) quanto ao achado fechado. Anexar evidências sob pasta própria do ticket, sincronizar status/blockers no índice e registrar qualquer mudança de decisão arquitetural antes de codificar em torno dela.

## Bloqueia próxima fase?

Gate para execução futura, independente de foto/visão. Consultar também os gates globais de piloto e execução em [índice](../03-tickets-e-dependencias.md). `BLOCKER` pode bloquear efeitos futuros sem impedir laboratório sintético isolado.
