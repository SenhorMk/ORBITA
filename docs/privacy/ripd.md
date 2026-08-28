# RIPD — Relatório de Impacto à Proteção de Dados Pessoais

**Ticket:** 15 — Mapear tratamento LGPD, papéis e RIPD (`orbita-mvp-producao-v2`).
**Commit analisado:** `36f1b231df1f50da2cd0a9e926e7a222dff81688` (branch `fix/ticket-15-lgpd-ripd-papeis`, a partir de `main` sincronizada com `origin/main`, tickets 01-14 mesclados).
**Data:** 2026-08-27.
**Autor**: levantamento técnico automatizado (codificador), sem competência jurídica. **Toda decisão de risco aceitável, prazo de retenção e base legal permanece `needs-owner`/`needs-legal-review` — este documento não declara conformidade nem conclusão jurídica**, conforme exigido pelo ticket.

## 1. Escopo

Este RIPD cobre os tratamentos de maior risco identificados em `data-inventory.md` e `ropa.md`: dados de identificação e documento (CPF/CNPJ) de clientes finais e fornecedores; credenciais de integração; payloads brutos de webhook com retenção indefinida; dados de auditoria com IP/user-agent; e a rotina de encerramento/anonimização de organização. Tratamentos de baixo risco (ex. `sync_jobs.progress`, metadados técnicos sem PII) não recebem RIPD dedicado — estão apenas no inventário.

## 2. Necessidade e proporcionalidade

- **Dados de identificação/documento de clientes e fornecedores** (`clientes.cpf_cnpj`, `fornecedores.cnpj_cpf` + endereço completo): necessários para a finalidade declarada (gestão comercial/fiscal integrada ao Bling, emissão de NF-e). Proporcionalidade não avaliada juridicamente — **needs-legal-review** quanto a minimizar quais campos realmente precisam trafegar do Bling para o ORBITA versus ficar só no ERP.
- **Payload bruto de webhook armazenado indefinidamente** (`inbox_eventos_bling`, `inbox_eventos_chatwoot`, `outbox_eventos`): a persistência do payload é necessária para idempotência/replay (finalidade técnica legítima), mas a **ausência de TTL/expurgo** não é proporcional a essa finalidade — idempotência exige guardar a chave e o resultado por um período limitado, não indefinidamente. **Gap confirmado por busca**: nenhuma das migrations 28, 29, 30, 31, 48, 49 define coluna de expiração de payload (só `lease_expires_at` para controle operacional de lock, que é distinto de retenção de dado).
- **`eventos_auditoria_sistema.ip_address`/`.user_agent`**: necessário para investigação de incidentes de segurança (finalidade legítima), mas retido indefinidamente sem rotina de expurgo — mesma lacuna de proporcionalidade.
- **Credenciais legadas em `integracoes_bling`** (sem confirmação de criptografia): necessidade de existir a credencial é clara (operar a integração), mas a forma de armazenamento pode não ser proporcional ao risco se de fato estiver em texto claro — precisa de confirmação técnica direta no ambiente real (este levantamento só confirma a ausência de evidência de cifra no schema, não confirma se há cifra em nível de aplicação não capturado pela busca).

## 3. Riscos por titular

| Titular | Risco | Cenário concreto |
|---|---|---|
| Cliente final do lojista | Reidentificação/exposição de CPF/CNPJ, telefone, e-mail em caso de vazamento de `clientes` ou de qualquer payload de webhook Bling não expurgado | Vazamento de credencial de `service_role` ou falha de RLS expõe toda a base de clientes de todos os lojistas simultaneamente (dado multi-tenant) |
| Fornecedor | Exposição de CNPJ/CPF e endereço completo, sem cobertura da rotina de anonimização no encerramento | Organização encerra a conta; `executar_encerramento_definitivo` anonimiza `clientes` mas **não** `fornecedores` — dado de fornecedor sobrevive indefinidamente após o encerramento formal da organização |
| Contato Chatwoot | Exposição de conteúdo de conversa (`chatwoot_messages.content`, texto livre, pode conter qualquer categoria de dado inclusive sensível) e de `avatar_url`/telefone, sem TTL | Mesma exposição multi-tenant do item acima; conteúdo de mensagem não é sanitizado antes de persistir (apenas o payload bruto do webhook passa por `redactSensitiveData`/remoção de avatar — a mensagem já persistida na tabela `chatwoot_messages` não é minimizada) |
| Lojista/funcionário | Exposição de IP/user-agent via `eventos_auditoria_sistema`, ou de credencial de sessão | Retenção indefinida de IP aumenta a superfície de um possível uso para perfilamento não autorizado, mesmo sendo coletado para finalidade de segurança |
| Lojista (titular da assinatura Stripe) | Exposição de `stripe_webhook_events.payload` bruto (pode conter e-mail/nome de cobrança) | Tabela sem TTL, acesso restrito a `service_role`, mas sem rotina de expurgo documentada |
| Todos os titulares acima | Credencial Bling legada em `integracoes_bling` potencialmente em texto claro, ainda referenciada por organizações migradas sem recifragem completa (nota da migration 46) | Comprometimento do banco expõe credenciais que dão acesso à conta Bling inteira do lojista (e, por consequência, a todos os clientes dele no ERP) |

## 4. Severidade × probabilidade (avaliação técnica preliminar, não jurídica)

| Risco | Severidade | Probabilidade | Risco combinado (preliminar) |
|---|---|---|---|
| Credencial Bling legada sem criptografia confirmada | Alta (acesso total à conta ERP do lojista) | Baixa-média (depende de comprometimento do banco + organizações ainda não recifradas) | Alto — needs-owner prioritário |
| Anonimização incompleta no encerramento (`fornecedores`, `chatwoot_*`, `eventos_auditoria_sistema`, `inbox_*`/`outbox_*` não cobertos) | Média-alta (dado pessoal sobrevive além do fim declarado do tratamento) | Alta (ocorre em toda organização que se encerra, é o caminho padrão, não uma falha) | Alto — needs-owner prioritário |
| Retenção indefinida de payload de webhook (Bling/Chatwoot/Stripe) | Média (aumenta janela de exposição em caso de vazamento) | Alta (é o comportamento padrão, não uma exceção) | Médio-alto |
| Retenção indefinida de IP/user-agent em auditoria | Baixa-média | Alta (comportamento padrão) | Médio |
| Redação de log incompleta (`logger.ts` não cobre e-mail/nome/telefone/IP em `context` livre) | Baixa-média (depende de quem loga PII em `context`, não é automático) | Média (depende de disciplina de cada desenvolvedor futuro) | Médio |
| Host de produção e destino real de stdout não identificados no código | Indeterminada até confirmação | Indeterminada | Needs-owner para sequer avaliar |
| Ausência de confirmação de DPA/região para Supabase/Stripe/Bling/Chatwoot/GitHub | Depende do resultado da confirmação | — | Needs-owner (bloqueia avaliação de transferência internacional) |

## 5. Controles existentes (implementados nos tickets 07-14, confirmados no código)

- Isolamento multi-tenant por `organizacao_id` com FK composta e RLS canônica sem `OR user_id` (tickets 08/09, pgTAP dedicado).
- Credenciais de integração modernas cifradas com AES-256-GCM e RLS fail-closed (`credenciais_integracao`, ticket 07/10).
- Transação OAuth de uso único com CAS, cookie opaco, rate limit fail-closed (ticket 07).
- Webhooks Bling/Chatwoot/Stripe verificados por assinatura (HMAC ou SDK oficial) antes de qualquer efeito, idempotência via chave única (tickets 08/10/11/14).
- Minimização de payload de webhook Chatwoot (remoção de `avatar_url`/`thumbnail`, `redactSensitiveData`) antes de persistir (ticket 11).
- Redação de segredos em logs (`SENSITIVE_KEY_PATTERN`, ticket 07).
- Política de suspensão/retenção/encerramento com carência configurável e anonimização parcial automatizada (`executar_encerramento_definitivo`, ticket 09/13 preservam o mecanismo).
- Direito de acesso/exportação nunca bloqueado por suspensão/`pending_deletion` (`entitlementPolicy.ts`, testado explicitamente, ticket 13).
- Nenhum dado de cartão de crédito trafega pelo servidor ORBITA (checkout/portal Stripe hospedados, ticket 14).
- Lease com expiração previne perda silenciosa de eventos de outbox por worker morto (ticket 12).

## 6. Controles planejados / lacunas identificadas (needs-owner)

| # | Lacuna | Ticket de controle recomendado | Severidade |
|---|---|---|---|
| G1 | `executar_encerramento_definitivo` não anonimiza `fornecedores`, `chatwoot_contacts`, `chatwoot_messages`, `eventos_auditoria_sistema`, `inbox_eventos_bling`/`_chatwoot`, `outbox_eventos`, nem a tabela legada `integracoes_bling` | Ticket dedicado de expansão da rotina de encerramento (fora do escopo do ticket 15, que é só análise) | Alta |
| G2 | Recifragem pendente das credenciais legadas em `integracoes_bling` para o cofre `credenciais_integracao` (nota da migration 46, `10-final-evidence.md` needs-owner item 2) | Já identificado como needs-owner no ticket 10 — reforçado aqui como risco de proteção de dados, não só técnico | Alta |
| G3 | Nenhuma coluna/rotina de TTL/expurgo para `inbox_eventos_bling`, `inbox_eventos_chatwoot`, `outbox_eventos`, `stripe_webhook_events`, `eventos_auditoria_sistema`, `historico_entitlements`, `historico_ciclo_vida_organizacao` | Ticket dedicado de política de retenção/expurgo automatizado por tabela | Média-alta |
| G4 | `logger.ts`/`SENSITIVE_KEY_PATTERN` não redige e-mail/nome/telefone/IP em `context` livre de chamadas de log de aplicação (distinto da tabela de auditoria, que grava IP deliberadamente) | Ticket de observabilidade para ampliar o padrão de redação ou documentar por que esses campos ficam de fora | Média |
| G5 | Host de produção não identificado em código — destino real de stdout/logs de aplicação desconhecido | needs-owner administrativo — confirmar host e política de retenção de log de plataforma | Indeterminada |
| G6 | Região/residência de dados do projeto Supabase, conta Stripe e instância Bling não confirmadas em código | needs-owner administrativo — coletar essas confirmações e atualizar `vendor-role-matrix.md` | Indeterminada |
| G7 | DPA/termo de subprocessamento com Supabase, Stripe, Bling, Chatwoot (quando Cloud) e GitHub não confirmado no repositório | needs-owner administrativo/jurídico | Indeterminada |
| G8 | Mecanismo de entrega do e-mail de convite de organização (`convites_organizacao.email`) não confirmado — nenhum provedor de e-mail dedicado encontrado | needs-owner — confirmar se o convite é enviado automaticamente e por qual meio | Baixa-média |
| G9 | Tabela legada `financeiro` órfã (zero *callers* confirmados no ticket 09) segue existindo com dados financeiros vinculados a pedidos | Ticket de descontinuação/remodelagem formal (mencionado como needs-owner no ticket 09) | Baixa |

## 7. Risco residual

Com os controles do item 5 aplicados, o risco residual dos tratamentos cobertos é avaliado tecnicamente como **médio**, dominado pelas lacunas G1-G3 (anonimização incompleta e retenção indefinida). Sem uma decisão de proprietário sobre prazos de retenção e sem a recifragem pendente (G2), o risco residual não pode ser declarado "baixo" nem "aceito" — permanece **`needs-owner`** para as lacunas de alta severidade (G1, G2) e **`needs-legal-review`** para toda base legal e prazo de retenção mencionados em `ropa.md`.

## 8. Decisão

**Status deste RIPD: `needs-owner`.**

Conforme o próprio ticket determina ("Sem essa revisão, status final é `needs-owner`, não `done`"), este RIPD não pode ser aprovado apenas pela conclusão técnica do inventário. É necessária revisão humana do proprietário do produto e de um assessor jurídico qualificado sobre: bases legais candidatas (todas marcadas `needs-legal-review` em `ropa.md`), prazos de retenção propostos em `data-inventory.md`, papéis de controlador/operador/suboperador por fluxo, e as lacunas G1-G9 desta seção. Essa revisão está agendada para o final da leva (ticket 25), conforme a política de timing de credenciais/decisões externas já registrada na memória do projeto — não deve ser cobrada antes disso.

---

## 9. Tabela de cobertura — jornada → dados → ROPA → fornecedor → risco → ticket de controle

| Jornada (`ropa.md`) | Principais dados (`data-inventory.md`) | Seção ROPA | Fornecedor(es) envolvido(s) | Risco (`ripd.md` §3-6) | Ticket de controle |
|---|---|---|---|---|---|
| 1. Cadastro/autenticação | Itens 1-2 | ROPA §1 | Supabase | Baixo (região não confirmada — G6) | needs-owner (região) |
| 2. Convite/membership | Itens 6-9 | ROPA §2 | Nenhum externo confirmado | Baixo (G8: entrega do convite) | needs-owner (G8) |
| 3. Conexão OAuth Bling/cofre | Itens 3, 21, 22 | ROPA §3 | Bling | Alto (G2: recifragem pendente) | Ticket 10 needs-owner item 2 (reforçado por G2) |
| 4. Sync catálogo/clientes/pedidos/fiscal | Itens 11, 12, 14, 15, 28 | ROPA §4 | Bling | Médio-alto (G1, G3) | Ticket dedicado de expansão de encerramento + retenção (G1, G3) |
| 5. Gestão comercial interna | Itens 11, 14, 15 | ROPA §5 | Bling | Médio (herda G1/G3 da jornada 4) | Mesmo ticket de G1/G3 |
| 6. Gestão financeira | Itens 13, 16, 17 | ROPA §6 | Bling | Alto (G1: fornecedores não anonimizados) + Baixo (G9: tabela órfã) | Ticket de G1 + ticket de descontinuação (G9) |
| 7. Atendimento via Chatwoot | Itens 18-20 | ROPA §7 | Chatwoot | Alto (G1: contatos/mensagens não anonimizados) + Médio (G3) | Ticket de G1 + G3 |
| 8. Billing Stripe | Itens 23-24 | ROPA §8 | Stripe | Médio (G3: payload sem TTL) + Indeterminado (G6/G7) | Ticket de G3; needs-owner G6/G7 |
| 9. Entitlements | Item 25 | ROPA §9 | Nenhum externo | Baixo (G3) | Ticket de G3 |
| 10. Ciclo de vida/encerramento | Itens 6, 9 + anonimização | ROPA §10 | Nenhum externo | Alto (G1, núcleo desta lacuna) | Ticket dedicado de expansão de `executar_encerramento_definitivo` (G1) |
| 11. Auditoria/observabilidade | Itens 26-27 | ROPA §11 | Host não identificado | Médio (G3, G4, G5) | Ticket de retenção de auditoria (G3) + ticket de observabilidade (G4) + needs-owner (G5) |
| 12. Jobs duráveis | Item 28 | ROPA §12 | Bling, Chatwoot | Médio-alto (G3) | Ticket de retenção de payload (G3) |
| 13. Rate limiting | Item 5 | ROPA §13 | Nenhum externo | Baixo | Nenhum — controle já implementado (ticket 07) |

## 10. Lista explícita de decisões jurídicas pendentes

1. Confirmar/ajustar todas as bases legais candidatas listadas em `ropa.md` §1-13 (13 jornadas, todas marcadas `needs-legal-review`).
2. Definir prazos de retenção definitivos para: conta de usuário pós-encerramento, dados de `clientes`/`fornecedores` durante e após a carência de 30 dias, payloads de webhook (`inbox_*`/`outbox_*`/`stripe_webhook_events`), `eventos_auditoria_sistema`, `historico_entitlements`, `historico_ciclo_vida_organizacao`.
3. Confirmar se o ORBITA precisa formalizar DPA/termo de subprocessamento com Supabase, Stripe, Bling (quando aplicável), Chatwoot (modalidade Cloud) e GitHub (G7).
4. Confirmar região/residência de dados de cada fornecedor acima e se há necessidade de salvaguarda de transferência internacional (cláusulas contratuais padrão ou equivalente) (G6).
5. Decidir se `fornecedores`, `chatwoot_contacts`, `chatwoot_messages`, `eventos_auditoria_sistema`, `inbox_*`/`outbox_*` e `integracoes_bling` legado devem ser incluídos na rotina de anonimização/exclusão de `executar_encerramento_definitivo`, e em que ordem de prioridade (G1).
6. Aprovar ou ajustar a proposta de "lojista controlador / ORBITA operador" para as jornadas 4-7, e "ORBITA controlador" para as jornadas 1/8/9/11-13 (`ropa.md`, seção final).
7. Decidir o destino da tabela legada `financeiro` (descontinuar ou remodelar) (G9).
8. Confirmar o mecanismo real de entrega de convite de organização e se precisa de um provedor de e-mail dedicado (G8).

Nenhuma das oito decisões acima foi tomada por este ticket — todas seguem `needs-legal-review`/`needs-owner`, a serem endereçadas na revisão humana agendada para o final da leva (ticket 25), conforme instrução do escopo desta tarefa.
