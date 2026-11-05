# 09 — PRE-009: Unificar cadastro de fornecedor e consulta CNPJ

**Status:** draft — proposta local, aguardando aprovação da decomposição; não iniciado.
**Classificação:** BLOCKER
**Risco:** médio. **Esforço relativo:** 3/3 (1 pequeno, 2 moderado, 3 maior; limitado a uma fatia verificável, não estimativa de dias).
**Blocked by:** Nenhum ticket — pode ser planejado independentemente; execução depende da aprovação deste pacote.
**Decisões externas:** Nenhuma decisão comercial adicional específica; herda decisões aprovadas dos blockers e limites de ambiente do plano.

## Objetivo e entrega vertical

Cadastro devolve fornecedor selecionável na despesa; consulta usa serviço CNPJ existente e dados fiscais explícitos, sem inferir ICMS.

## Por que existe

Fecha achado revalidado na main, descrito no baseline; não substituir evidência por suposição de que já foi corrigido.

## Arquivos / áreas prováveis

src/components/financeiro/LancamentoDeDespesa.tsx; NovoFornecedorModal.tsx; src/app/api/financeiro/fornecedores/route.ts; consultaPorCnpj. Caminhos são pistas da main `e71354e`, não obrigação de mover pastas. Conferir fonte atual e AGENTS.md antes de implementar.

## Schema afetado

Fornecedor local se consumido; apenas migration justificada pela identidade durável de criação. Se houver mudança persistente, app, migration forward-only, constraints/índices/RLS, catálogo/ledger e testes SQL pertencem a esta mesma fatia. Não executar DDL remoto sem apresentação de alvo/SQL/validação/rollback/locks e autorização explícita.

## API afetada

DTO request/response Zod; GET CNPJ interno; POST fornecedor. Validar request/response com Zod, falhas tipadas e contrato versionado. Não converter falha de provider em sucesso simulado.

## Env necessário

Config CNPJ server-side existente; Bling. Somente nomes e exemplos sanitizados em documentação; secrets fora de Git e do bundle, separados por ambiente.

## Segurança

Escopo deriva de sessão verificada ou conexão autenticada, nunca de organização passada apenas pelo cliente/modelo. Autorizar ação/capability separadamente; queries privilegiadas filtram organização. Aplicar invariantes específicos abaixo, testes cross-tenant e negação sem efeitos.

## LGPD

Minimizar conteúdo e identificadores; fixtures sintéticas; não logar CPF, tokens, cookies, mensagens privadas ou URLs assinadas. Dados novos entram no inventário e nos fluxos de exportação/retencão/eliminação do plano. Se este ticket habilita foto/provider novo, estender evidência de MSG-021 antes de dados reais.

## Invariantes

cpf_cnpj/cnpj e endereço traduzidos uma vez; indicadorIe 1/2/9 não inferido do documento; criação ambígua não repetida.

## Failure modes

Contract request/response; lookup indisponível; CNPJ não contribuinte; resposta Bling aninhada/2xx inválido; clique duplo/ACK perdido. Para cada efeito externo deste ticket, aplicar também os 17 casos da matriz em [arquitetura](../02-arquitetura.md): timeout, ACK perdido e 2xx inválido não comprovam ausência do efeito. Para fatia sem efeito externo, marcar os casos inaplicáveis com justificativa na evidência.

## Acceptance criteria

- [ ] Criar fornecedor por jornada de despesa devolve id/nome corretos; UF/município preservados; teste comprova CNPJ com indicador 9.
- [ ] Organização A/B, usuário sem capability e entrada inválida têm resultado comprovado, sem side effect indevido.
- [ ] Schema e aplicação foram verificados juntos em banco descartável, incluindo constraints e caminho de recuperação.
- [ ] Evidência anexada identifica SHA, ambiente, comandos, resultados e limitações; nenhum teste não executado é declarado aprovado.

## Testes obrigatórios

Contract request/response; lookup indisponível; CNPJ não contribuinte; resposta Bling aninhada/2xx inválido; clique duplo/ACK perdido. Usar seam de domínio/adapter e contrato do comportamento; quando houver DB, executar testes reais de transação/concorrência em stack descartável. Gates de implementação: `npm test`, `npm run typecheck`, `npm run secrets:check`, `npm run lint:ratchet`, `npm run aislop`, `npm run build`. Somar `npm run test:db` para SQL, `npm run e2e -- <spec>` para jornada e gates de catálogo/boundaries disponíveis. Revisão final deve conferir evidências, não apenas mocks verdes.

## Sabotage / negative tests

Tentar contornar: cpf_cnpj/cnpj e endereço traduzidos uma vez; indicadorIe 1/2/9 não inferido do documento; criação ambígua não repetida. Adulterar tenant, referência, versão ou payload relevante; duplicar requisição e interromper a operação no ponto crítico descrito nos testes. Resultado esperado: recusa/UNKNOWN/reconciliação conforme o contrato, nunca sucesso inventado ou repetição destrutiva.

## Observabilidade

Eventos de início, decisão, recusa e término com correlation_id, organização, recurso, versão e outcome; efeito/tentativa/lease quando aplicável. Demonstrar um evento de falha redigido e sua ligação à evidência de aceite. Métricas e auditoria seguem [plano](../02-arquitetura.md), sem conteúdo privado por padrão.

## Smoke

Executar a jornada descrita em “Objetivo e entrega vertical” com fixture sintética e verificar: Criar fornecedor por jornada de despesa devolve id/nome corretos; UF/município preservados; teste comprova CNPJ com indicador 9. Registrar referências locais/provider e fronteiras verificadas. Smoke real só no ambiente explicitamente autorizado; simulador deve ser identificado.

## Rollback

Desativar novo cadastro e manter seleção dos existentes; preservar tentativa ambígua. Migration permanece forward-only; preservar histórico/tentativas e revalidar mensagens em voo. Nunca usar restauração ampla de grants, apagar ledger ou repetir POST desconhecido como recuperação.

## Documentação

Atualizar contrato/runbook da área e [baseline](../01-baseline-e-evidencias.md) quanto ao achado fechado. Anexar evidências sob pasta própria do ticket, sincronizar status/blockers no índice e registrar qualquer mudança de decisão arquitetural antes de codificar em torno dela.

## Bloqueia próxima fase?

Bloqueia criação de fornecedor correta antes de autonomia; independente da demo read-only. Consultar também os gates globais de piloto e execução em [índice](../03-tickets-e-dependencias.md). `BLOCKER` pode bloquear efeitos futuros sem impedir laboratório sintético isolado.
