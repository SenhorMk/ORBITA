# Ticket 25 — Risk Register Residual (Gate de Release do MVP)

**Commit candidato:** `cd12c4f7a651515b01b3a880a37998f3701d6d0d`
**Branch:** `fix/ticket-25-gate-final-release-mvp`
**Data:** 2026-08-28
**Fonte:** consolidação de todos os itens `needs-owner`/`blocked`/`done-with-caveats-com-pendência` catalogados em `docs/release/ticket-25-reconciliation-matrix.md` (34 itens contados formalmente na matriz) mais os achados agregados de `docs/release/ticket-25-independent-review.md` §9, cruzados linha a linha com os arquivos `.scratch/orbita-mvp-producao-v2/evidence/{07..24b}-final-evidence.md` para garantir que nenhum item `needs-owner` citado em qualquer evidência ficou de fora.

**Regra de classificação de probabilidade/impacto:** Probabilidade = chance de o risco se materializar **antes** de o item ser resolvido (não é probabilidade de o item nunca ser resolvido). Impacto = dano caso o risco se materialize em produção real, com dados reais de clientes. Ambos em escala Baixo/Médio/Alto.

Qualquer owner ausente ou blocker aberto nesta lista implica `NO-GO`, conforme o próprio ticket 25 exige.

---

## 1. Fundação e credenciais

| # | Item | Probabilidade | Impacto | Mitigação | Owner | Prazo | Gatilho de revisão |
|---|---|---|---|---|---|---|---|
| 1 | Credenciais de desenvolvimento (Supabase/Stripe/Bling/Chatwoot/hospedagem/domínio/e-mail) ainda não rotacionadas para produção | Alta (nenhuma rotação ocorreu) | Alto — vazamento de credencial de dev usada em prod compromete todos os tenants | Rotacionar todas antes de qualquer promoção; usar cofre de segredos dedicado (não `.env` em disco) | Proprietário | Antes do go-live | Qualquer tentativa de deploy em produção real |

---

## 2. Identidade / sessão / OAuth

| # | Item | Probabilidade | Impacto | Mitigação | Owner | Prazo | Gatilho |
|---|---|---|---|---|---|---|---|
| 2 | Validação end-to-end contra Bling real em staging (rejeição de segunda tentativa de callback) nunca executada | Média — lógica testada via pgTAP/TS, mas nunca contra o provedor real | Médio — replay de OAuth aceito indevidamente | Executar o passo a passo já registrado em `07-final-evidence.md` assim que staging + credenciais Bling reais existirem | Proprietário | Antes do go-live | Staging real disponível (ticket 21) |
| 3 | Rotas dedicadas de login/logout/recuperação de senha com rate limit server-side não existem no backend | Alta (rotas simplesmente não existem) | Médio — sem elas, risco de brute-force/enumeração se o app crescer além do MVP atual | Decidir se o fluxo de auth do Supabase Auth é suficiente para o MVP ou se rotas dedicadas são necessárias | Produto | Antes de expandir a base de usuários | Aumento de tráfego de autenticação ou primeiro incidente de abuso |

---

## 3. Catálogo / comercial / Bling

| # | Item | Probabilidade | Impacto | Mitigação | Owner | Prazo | Gatilho |
|---|---|---|---|---|---|---|---|
| 4 | Jornada catálogo→pedido→estoque→fiscal só provada por tipo+pgTAP, sem suíte HTTP/UI ao vivo com duas organizações reais | Baixa — lógica de RLS/FK coberta por pgTAP real | Médio — bug de integração entre camadas não capturado por teste unitário isolado | Escrever/rodar suíte de integração HTTP com duas orgs reais antes do go-live | Engenharia | Antes do go-live | Primeiro incidente de dado cruzado entre organizações |
| 5 | `BlingPort`/`BlingV3Adapter` formal + contract tests (ticket 10b) nunca iniciado — zero evidência | Média — a integração funcional (ticket 10) já existe e funciona, mas sem a camada formal fica mais difícil trocar de adapter/testar regressão isoladamente | Baixo — debt arquitetural, não falha de segurança/tenancy | Executar o ticket 10b como item de engenharia pós-MVP | Engenharia | Backlog pós-MVP | Próxima mudança relevante na API do Bling ou necessidade de segundo adapter |
| 6 | `src/app/page.tsx` (2218 linhas) e `src/services/bling.ts` (1183 linhas) acima do orçamento de tamanho de arquivo | Baixa — já mapeado e aceito com plano de split no allowlist | Baixo — manutenibilidade, não correção | Executar split conforme plano já registrado em `quality/aislop-allowlist.json` | Engenharia | Ticket de follow-up já especificado | Próxima mudança grande nesses arquivos |

---

## 4. Financeiro

| # | Item | Probabilidade | Impacto | Mitigação | Owner | Prazo | Gatilho |
|---|---|---|---|---|---|---|---|
| 7 | Prova de sync idempotente contra conta Bling real de produção nunca executada | Média | Médio — duplicação de lançamentos financeiros em cenário real não coberto por mock | Executar sync real assim que credenciais Bling reais existirem, validar idempotência com reexecução deliberada | Proprietário | Antes do go-live | Credenciais Bling reais disponíveis |
| 8 | Tabela legada `financeiro` (distinta de `*_financeiro*`) sem decisão de descontinuar/remodelar | Baixa | Baixo — confusão de schema, não risco de segurança imediato | Decidir descontinuação ou migração formal | Produto | Backlog pós-MVP | Próxima mudança no módulo financeiro |

---

## 5. Integração Bling

| # | Item | Probabilidade | Impacto | Mitigação | Owner | Prazo | Gatilho |
|---|---|---|---|---|---|---|---|
| 9 | Refresh concorrente de token só provado por pgTAP (lock de banco), sem teste de integração TS concorrente ponta a ponta contra servidor fake | Baixa — lock de banco já é a garantia real | Baixo | Escrever teste de integração TS complementar | Engenharia | Backlog pós-MVP | Incidente de token corrompido em produção |
| 10 | Jornada real de teste contra conta/sandbox Bling (OAuth→recurso→sync→webhook) nunca executada | Alta — depende inteiramente de credenciais reais que não existem | Alto — é a integração central do produto | Executar passo a passo já registrado em `10-final-evidence.md` needs-owner item 1 | Proprietário | Antes do go-live | `BLING_CLIENT_ID`/`SECRET` reais disponíveis |
| 11 | Recifragem de credenciais legadas migradas (`integracoes_bling`→cofre organizacional) não executada | Média | Médio — credencial legada pode ficar cifrada com chave antiga além do necessário | Rodar script de recifragem com `ENCRYPTION_KEY` nova pós-rotação | Engenharia | Junto com a rotação de credenciais (item 1) | Rotação de `ENCRYPTION_KEY` |
| 12 | Auditoria de execução manual histórica de `migrar_bling_para_organizacoes()` em qualquer ambiente não confirmada | Baixa | Médio — se executada sem auditoria, pode haver estado inconsistente não detectado | Confirmar junto ao proprietário se a função foi rodada manualmente antes; auditar se sim | Proprietário | Antes do go-live | — |

---

## 6. Integração Chatwoot

| # | Item | Probabilidade | Impacto | Mitigação | Owner | Prazo | Gatilho |
|---|---|---|---|---|---|---|---|
| 13 | Jornada real em instância Chatwoot controlada nunca executada | Alta — depende de credenciais/instância real | Alto — segunda integração central do produto | Executar passo a passo de `11-final-evidence.md` needs-owner item 1 | Proprietário | Antes do go-live | Credenciais/instância Chatwoot reais disponíveis |
| 14 | `GET /api/config` expõe bloco Chatwoot legado via env vars globais em vez de `conexoes_integracao` | Baixa | Baixo — expõe apenas status de configuração, não segredo | Migrar endpoint para ler de `conexoes_integracao` | Engenharia | Ticket dedicado pós-MVP | — |
| 15 | Bug conhecido do provedor Chatwoot (chatwoot/chatwoot#13809 — `secret` divergente de `hmac_token`) pode afetar a instância real usada | Média — depende da versão da instância real, ainda não verificada | Médio — validação de assinatura de webhook pode falhar silenciosamente | Verificar versão da instância real antes de conectar; aplicar workaround se necessário | Proprietário | Antes de conectar instância real | Escolha da instância Chatwoot de produção |

---

## 7. Inbox / outbox / jobs duráveis

| # | Item | Probabilidade | Impacto | Mitigação | Owner | Prazo | Gatilho |
|---|---|---|---|---|---|---|---|
| 16 | Rota/RPC de replay explícita e auditada para outbox não existe (só existe para inbox) | Baixa | Médio — sem ela, recuperação manual de evento outbox travado é mais difícil | Implementar RPC `preparar_replay_evento_outbox` análoga à de inbox | Engenharia | Ticket dedicado pós-MVP | Primeiro evento outbox travado em produção |
| 17 | `correlation_id` (coluna existe desde a migration 48) não é preenchido pelos handlers HTTP existentes | Alta — gap estrutural presente em todos os handlers | Médio — reduz rastreabilidade de incidentes cross-serviço | Fazer wiring do `correlation_id` nos handlers de webhook/sync | Engenharia | Antes do go-live (recomendado) ou logo após | Primeiro incidente que exija correlação entre serviços |

---

## 8. Planos, entitlements e Stripe

| # | Item | Probabilidade | Impacto | Mitigação | Owner | Prazo | Gatilho |
|---|---|---|---|---|---|---|---|
| 18 | Jornada completa de Test Mode Stripe (checkout→webhook→entitlement→portal→cancelamento→replay) nunca executada contra conta Stripe real | Alta — depende de credenciais reais | Alto — é o caminho de cobrança do produto | Executar os 11 passos já registrados em `14-final-evidence.md` §6 | Proprietário | Antes do go-live | `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/Price IDs reais disponíveis |
| 19 | `enforceIntegrationLimit` (limite de conexões Bling/Chatwoot) sem nenhum caller de rota real hoje | Baixa — nenhuma rota de "conectar" o usa ainda | Baixo — não é possível estourar o limite hoje porque a trava não é chamada, mas também não é aplicada | Decidir se alguma rota de "conectar" precisa consumir este entitlement | Produto | Backlog pós-MVP | Adição de nova rota de conexão de integração |

---

## 9. LGPD / privacidade

| # | Item | Probabilidade | Impacto | Mitigação | Owner | Prazo | Gatilho |
|---|---|---|---|---|---|---|---|
| 20 | Aprovação jurídica das bases legais e decisões do RIPD ainda pendente | Alta — nenhuma decisão jurídica foi tomada até esta data | Alto — operar sem base legal definida é risco regulatório direto (LGPD) | Revisão jurídica agendada para o final do ticket 25 pelo responsável qualificado | Proprietário/assessor jurídico | Antes do go-live — bloqueante | Data da revisão jurídica agendada |
| 21 | Conteúdo jurídico do aviso de privacidade não publicado | Alta | Alto — obrigação legal de transparência não cumprida | Publicar aviso após aprovação do RIPD (item 20) | Proprietário/jurídico | Antes do go-live — bloqueante | Conclusão do item 20 |
| 22 | Canal de privacidade/DPO real não existe | Alta | Alto — titulares não têm como exercer direitos | Criar canal (e-mail/formulário) e nomear DPO ou responsável | Proprietário | Antes do go-live — bloqueante | — |
| 23 | DPA/status de fornecedores (Supabase, Stripe, Bling, Chatwoot) todos marcados `missing` | Alta | Alto — sem DPA, o repasse de dados pessoais a esses fornecedores não tem base contratual documentada | Confirmar/assinar DPA com cada fornecedor | Proprietário | Antes do go-live — bloqueante | — |
| 24 | Wiring de produção do outbox para adapters reais (Bling/Chatwoot) em solicitações de titular incompleto | Média — mecanismo existe, falta ligação ponta a ponta | Alto — direito do titular (portabilidade/eliminação) pode não propagar a todos os sistemas | Completar wiring herdado do gap do ticket 12 | Engenharia | Antes do go-live | Primeira solicitação real de titular |
| 25 | Prazos reais de retenção por categoria não aprovados (política travada em `pending_approval` por construção) | Alta | Alto — retenção indevida de dados pessoais é violação direta da LGPD | Aprovação de prazos pelo responsável, prevista para o fim do ticket 25 | Proprietário/jurídico | Antes do go-live — bloqueante | — |
| 26 | Ativação do scheduler de retenção em produção pendente | Alta (depende do item 25) | Alto | Ativar com pacote de autorização próprio após aprovação de prazos | Proprietário | Antes do go-live — bloqueante | Conclusão do item 25 |
| 27 | Entrega real de alerta em staging, nomeação de Incident Commander/DPO e ferramenta de plantão inexistentes | Alta | Alto — resposta a incidente de dados pessoais não é operacional hoje | Definir staging, canal de alerta e responsáveis nomeados | Proprietário | Antes do go-live — bloqueante | — |
| 28 | Retrofit de auditoria nas rotas de auth/billing/membership pré-existentes ao ticket 19 é parcial | Média | Médio — lacuna de rastreabilidade em rotas mais antigas | Completar retrofit incrementalmente | Engenharia | Backlog próximo, não bloqueante | Auditoria de conformidade ou incidente envolvendo essas rotas |

---

## 10. CI / qualidade / ferramental

| # | Item | Probabilidade | Impacto | Mitigação | Owner | Prazo | Gatilho |
|---|---|---|---|---|---|---|---|
| 29 | Strix (scanner de segurança CI) nunca configurado/aprovado neste ambiente | Média | Médio — camada adicional de detecção de vulnerabilidade ausente | Configurar com autorização escrita e escopo confirmado, conforme protocolo do próprio ticket 25 | Proprietário | Antes do go-live (recomendado) | Autorização escrita de escopo de segurança |
| 30 | Graphify (grafo de dependências) não configurado neste ambiente — `graphify-out/graph.json` não existe | Alta — ferramenta externa nunca rodou aqui | Baixo — `boundaries:check` já cobre a garantia funcional equivalente (0 violações) | Configurar a skill Graphify externamente e regenerar o grafo no commit candidato final antes do go-live | Proprietário (ferramenta externa) | Antes do go-live (recomendado, não bloqueia o código) | Configuração da ferramenta disponível |

---

## 11. Deploy readiness, backup e staging

| # | Item | Probabilidade | Impacto | Mitigação | Owner | Prazo | Gatilho |
|---|---|---|---|---|---|---|---|
| 31 | Staging real isolado e reproduzível (host, domínio/TLS, Supabase separado) não existe | Alta — nenhum ambiente provisionado até esta data | Alto — bloqueia toda a cadeia de validação real (E2E, rollback, Bling/Chatwoot/Stripe reais) | Provisionar host/domínio/Supabase staging | Proprietário | Antes do go-live — bloqueante | — |
| 32 | Ensaio de rollback fim-a-fim em staging real nunca executado | Alta (depende do item 31) | Alto — sem ensaio real, rollback em produção é primeira execução em ambiente real | Executar ensaio assim que staging existir | Proprietário/Engenharia | Antes do go-live — bloqueante | Conclusão do item 31 |
| 33 | Alertas críticos nunca entregues a um canal real | Alta (depende do canal do ticket 19, item 27) | Alto — incidente em produção pode não gerar alerta a tempo | Configurar canal real e testar entrega | Proprietário | Antes do go-live — bloqueante | Conclusão do item 27 |

---

## 12. Sincronização Supabase real

| # | Item | Probabilidade | Impacto | Mitigação | Owner | Prazo | Gatilho |
|---|---|---|---|---|---|---|---|
| 34 | Nenhum project ref Supabase remoto real confirmado pelo proprietário nesta data | Alta | Alto — bloqueia toda a cadeia de aplicação real do schema | Proprietário confirma/cria o projeto remoto | Proprietário | Antes do go-live — bloqueante | — |
| 35 | Inspeção read-only real de um projeto Supabase remoto não executável sem project ref | Alta (depende do item 34) | Médio — validação de drift contra ambiente real pendente | Executar assim que o project ref existir | Engenharia | Antes do go-live | Conclusão do item 34 |
| 36 | Aplicação supervisionada do bundle de migrations no Supabase real nunca iniciada | Alta (depende dos itens 34/35) | Alto — schema de produção real nunca recebeu as 56 migrations | Aplicar com autorização explícita imediatamente antes da escrita, mecanismo já ensaiado no ticket 22 | Proprietário | Antes do go-live — bloqueante | Conclusão dos itens 34/35 e janela de aplicação agendada |

---

## 13. E2E real em staging e UI

| # | Item | Probabilidade | Impacto | Mitigação | Owner | Prazo | Gatilho |
|---|---|---|---|---|---|---|---|
| 37 | Specs Playwright de financeiro, Bling, Chatwoot, Stripe, LGPD e durabilidade nunca escritas (não é só "não executado") | Alta | Médio — 6 das 11 áreas da matriz mínima de E2E ficam sem nenhuma rede de segurança automatizada | Escrever specs quando staging/contas sandbox existirem | Engenharia | Antes do go-live (recomendado) | Staging + contas sandbox disponíveis |
| 38 | Execução real da suíte Playwright completa (21 testes estruturalmente válidos) contra staging publicado nunca rodada | Alta (depende de staging real) | Alto — nenhuma jornada crítica foi validada ponta a ponta contra ambiente real | Executar assim que staging (item 31) e sync Supabase (item 36) existirem | Proprietário/Engenharia | Antes do go-live — bloqueante | Conclusão dos itens 31 e 36 |
| 39 | Seletores das specs de identidade/organização/catálogo/cross-tenant/acessibilidade não validados contra staging real | Média (depende do item 38) | Baixo — risco de teste falso-verde por seletor incorreto, não risco de produto | Validar na primeira execução real (item 38) | Engenharia | Junto com item 38 | Conclusão do item 38 |
| 40 | `HealthMonitor` no topo do dashboard mostra `blingConnected`/`chatwootConnected` fixos, não reflete `/api/integracoes/saude` real | Alta — comportamento atual confirmado no código | Médio — usuário pode ser enganado sobre o status real de uma integração | Trocar valores fixos por fetch real do endpoint existente | Engenharia | Ticket dedicado pequeno, antes do go-live recomendado | — |
| 41 | `MembersList` exibe `user_id` bruto sem e-mail/nome (sem tabela de perfil) | Alta | Baixo — usabilidade, não segurança (não vaza dado de outra organização) | Decidir entre Admin API server-side ou tabela `perfis` | Produto | Backlog pós-MVP | — |
| 42 | Spec Playwright `organization.spec.ts` dirige via `page.request` em vez da UI real | Média | Baixo — cobertura de API existe, mas não prova que a UI está corretamente ligada a ela | Migrar spec para dirigir a UI real | Engenharia | Backlog pós-MVP | — |

---

## Resumo quantitativo

- **Total de itens no risk register:** 42.
- **Itens marcados como bloqueantes explícitos para o go-live** (impacto Alto + sem mitigação concluída, majoritariamente LGPD/staging/credenciais/Supabase real): itens 1, 18, 20, 21, 22, 23, 25, 26, 27, 31, 32, 33, 34, 36, 38 — **15 itens bloqueantes**.
- **Owner = Proprietário (ou proprietário + jurídico) isoladamente:** 19 itens.
- **Owner = Engenharia (não bloqueante ou follow-up técnico):** 14 itens.
- **Owner = Produto (decisão de escopo/UX):** 5 itens.
- **Owner = ferramenta externa (Strix/Graphify):** 2 itens.
- **Ticket não iniciado (`blocked`):** 1 (10b — BlingPort/Adapter formal).

Todos os 15 itens bloqueantes acima, isoladamente, já são suficientes para exigir `NO-GO` conforme a regra do próprio ticket 25 ("qualquer owner ausente ou blocker aberto implica NO-GO").
