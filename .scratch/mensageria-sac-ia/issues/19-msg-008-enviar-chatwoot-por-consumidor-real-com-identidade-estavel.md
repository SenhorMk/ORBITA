# 19 — MSG-008: Enviar Chatwoot por consumidor real com identidade estável

**Status:** draft — proposta local, aguardando aprovação da decomposição; não iniciado.
**Classificação:** FOUNDATION
**Risco:** alto. **Esforço relativo:** 3/3 (1 pequeno, 2 moderado, 3 maior; limitado a uma fatia verificável, não estimativa de dias).
**Blocked by:** [MSG-004](15-msg-004-contrair-chaves-globais-e-liberar-multi-instancia.md), [MSG-007](18-msg-007-representar-efeito-ambiguo-e-impedir-retry-inseguro-na-outbox.md), [MSG-001](12-msg-001-levantar-chatwoot-ce-dev-com-webhook-real-assinado.md)
**Decisões externas:** Nenhuma decisão comercial adicional específica; herda decisões aprovadas dos blockers e limites de ambiente do plano.

## Objetivo e entrega vertical

Enviar no cockpit ORBITA registra intenção transacional e worker entrega ao Chatwoot; status sent exige recibo, ambiguidade aparece ao operador.

## Por que existe

Entrega comportamento necessário ao marco indicado abaixo, reaproveitando fronteiras existentes em vez de criar infraestrutura paralela.

## Arquivos / áreas prováveis

src/app/api/chatwoot/send/route.ts; ChatwootAdapter; outbox composition; UI mensageria. Caminhos são pistas da main `e71354e`, não obrigação de mover pastas. Conferir fonte atual e AGENTS.md antes de implementar.

## Schema afetado

Mensagem pretendida+outbox atômicos; command_id e provenance; backlog inline reconciliado antes do corte. Se houver mudança persistente, app, migration forward-only, constraints/índices/RLS, catálogo/ledger e testes SQL pertencem a esta mesma fatia. Não executar DDL remoto sem apresentação de alvo/SQL/validação/rollback/locks e autorização explícita.

## API afetada

POST send com command_id/digest; consulta de status; adapter sendMessage/privateNote. Validar request/response com Zod, falhas tipadas e contrato versionado. Não converter falha de provider em sucesso simulado.

## Env necessário

Token Chatwoot por conexão; worker habilitado por tenant. Somente nomes e exemplos sanitizados em documentação; secrets fora de Git e do bundle, separados por ambiente.

## Segurança

Escopo deriva de sessão verificada ou conexão autenticada, nunca de organização passada apenas pelo cliente/modelo. Autorizar ação/capability separadamente; queries privilegiadas filtram organização. Aplicar invariantes específicos abaixo, testes cross-tenant e negação sem efeitos.

## LGPD

Minimizar conteúdo e identificadores; fixtures sintéticas; não logar CPF, tokens, cookies, mensagens privadas ou URLs assinadas. Dados novos entram no inventário e nos fluxos de exportação/retencão/eliminação do plano. Se este ticket habilita foto/provider novo, estender evidência de MSG-021 antes de dados reais.

## Invariantes

Um modo de envio por tenant; não coexistir inline e worker; pending antigo não é reenviado sem análise; resposta própria não dispara IA.

## Failure modes

Clique duplo/reload, request repetida, sucesso remoto+crash, timeout, 2xx inválido; webhook do próprio send; smoke Chatwoot real. Para cada efeito externo deste ticket, aplicar também os 17 casos da matriz em [arquitetura](../02-arquitetura.md): timeout, ACK perdido e 2xx inválido não comprovam ausência do efeito. Para fatia sem efeito externo, marcar os casos inaplicáveis com justificativa na evidência.

## Acceptance criteria

- [ ] Resposta sintética enviada aparece uma vez no caso e tem provider id; UNKNOWN não reenvia automaticamente; histórico inline classificado.
- [ ] Organização A/B, usuário sem capability e entrada inválida têm resultado comprovado, sem side effect indevido.
- [ ] Schema e aplicação foram verificados juntos em banco descartável, incluindo constraints e caminho de recuperação.
- [ ] Evidência anexada identifica SHA, ambiente, comandos, resultados e limitações; nenhum teste não executado é declarado aprovado.

## Testes obrigatórios

Clique duplo/reload, request repetida, sucesso remoto+crash, timeout, 2xx inválido; webhook do próprio send; smoke Chatwoot real. Usar seam de domínio/adapter e contrato do comportamento; quando houver DB, executar testes reais de transação/concorrência em stack descartável. Gates de implementação: `npm test`, `npm run typecheck`, `npm run secrets:check`, `npm run lint:ratchet`, `npm run aislop`, `npm run build`. Somar `npm run test:db` para SQL, `npm run e2e -- <spec>` para jornada e gates de catálogo/boundaries disponíveis. Revisão final deve conferir evidências, não apenas mocks verdes.

## Sabotage / negative tests

Tentar contornar: Um modo de envio por tenant; não coexistir inline e worker; pending antigo não é reenviado sem análise; resposta própria não dispara IA. Adulterar tenant, referência, versão ou payload relevante; duplicar requisição e interromper a operação no ponto crítico descrito nos testes. Resultado esperado: recusa/UNKNOWN/reconciliação conforme o contrato, nunca sucesso inventado ou repetição destrutiva.

## Observabilidade

Eventos de início, decisão, recusa e término com correlation_id, organização, recurso, versão e outcome; efeito/tentativa/lease quando aplicável. Demonstrar um evento de falha redigido e sua ligação à evidência de aceite. Métricas e auditoria seguem [plano](../02-arquitetura.md), sem conteúdo privado por padrão.

## Smoke

Executar a jornada descrita em “Objetivo e entrega vertical” com fixture sintética e verificar: Resposta sintética enviada aparece uma vez no caso e tem provider id; UNKNOWN não reenvia automaticamente; histórico inline classificado. Registrar referências locais/provider e fronteiras verificadas. Smoke real só no ambiente explicitamente autorizado; simulador deve ser identificado.

## Rollback

Pausar dispatcher; não retornar a inline em paralelo; manter intenções e resolver desconhecidos. Migration permanece forward-only; preservar histórico/tentativas e revalidar mensagens em voo. Nunca usar restauração ampla de grants, apagar ledger ou repetir POST desconhecido como recuperação.

## Documentação

Atualizar contrato/runbook da área e [baseline](../01-baseline-e-evidencias.md) quanto ao achado fechado. Anexar evidências sob pasta própria do ticket, sincronizar status/blockers no índice e registrar qualquer mudança de decisão arquitetural antes de codificar em torno dela.

## Bloqueia próxima fase?

Gate resposta/handoff; resolve lacuna de consumidor real. Consultar também os gates globais de piloto e execução em [índice](../03-tickets-e-dependencias.md). `BLOCKER` pode bloquear efeitos futuros sem impedir laboratório sintético isolado.
