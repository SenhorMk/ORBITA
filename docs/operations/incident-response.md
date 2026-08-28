# Playbook de resposta a incidentes de segurança

Ticket 19. Processo técnico operacional para detectar, investigar, conter e registrar
incidentes de segurança/privacidade na ORBITA sem vazar dados sensíveis durante a própria
resposta. Este documento é o processo; identidades reais de contato ficam marcadas
`needs-owner` — a definição do processo em si não depende delas.

## 1. Papéis

| Papel | Responsabilidade | Titular |
| --- | --- | --- |
| Incident Commander (IC) | Decide classificação, aciona/encerra o incidente, coordena comunicação | `needs-owner` |
| Responsável técnico (Tech Lead do incidente) | Investiga, contém, aplica correção técnica | `needs-owner` |
| DPO / responsável por privacidade | Avalia obrigação de notificação LGPD/ANPD e titulares | `needs-owner` |
| Comunicação | Redige e envia comunicação externa/interna quando aprovada pelo IC | `needs-owner` |

Até que os titulares acima sejam nomeados, qualquer pessoa com acesso de admin à
organização afetada e ao painel de auditoria pode assumir o papel de IC interino para
iniciar a contenção — a nomeação formal fica `needs-owner`.

## 2. Classificação de severidade

| Nível | Critério | Exemplos | SLA de resposta inicial |
| --- | --- | --- | --- |
| SEV-1 (crítico) | Confirmado acesso/gravação cross-tenant, vazamento de segredo/credencial, comprometimento de webhook com efeito colateral real | `security.cross_tenant_attempt` confirmado com dado exfiltrado; `webhook.signature_invalid` seguido de mutação inesperada | Reconhecer em até 15 min, IC acionado |
| SEV-2 (alto) | Falha de segurança sem confirmação de exfiltração, burst de auth failure sustentado, dead-letter em volume anômalo | `authFailureBurst` sustentado; `job.dead_letter` em massa | Reconhecer em até 1h |
| SEV-3 (moderado) | Anomalia operacional sem indício de violação de segurança | Erro técnico isolado, timeout de provider | Reconhecer em até 1 dia útil |
| Não incidente | Erro técnico esperado/transitório, sem indício de violação | Timeout pontual de rede, erro de validação de usuário | Tratado como bug normal |

**Regra explícita do "não fazer" (ticket 19): nenhum erro técnico é chamado de
"incidente comunicável" sem esta avaliação.** A classificação SEV-1/SEV-2 exige que o IC
(ou IC interino) confirme, a partir da trilha de auditoria e dos alertas disparados
(`src/lib/observability/alerting.ts`), que há indício real de violação — não basta um
erro 500 ou uma exceção isolada.

## 3. Detecção

Fontes de sinal, todas já implementadas neste ticket:

- Alertas automáticos (`src/lib/observability/alerting.ts`), avaliados contra a trilha de
  auditoria (`eventos_auditoria_sistema`, catálogo em
  `src/lib/observability/auditEventCatalog.ts`):
  - `authFailureBurst` — burst de falha de autenticação do mesmo ator/organização.
  - `crossTenantAttempt` — RPC `registrar_evento_auditoria` recusou uma tentativa de
    gravação cross-tenant (a própria RPC já é a barreira de anti-forjamento; o evento
    `security.cross_tenant_attempt` registra a tentativa para investigação).
  - `invalidWebhookSignature` — assinatura de webhook rejeitada antes de qualquer side
    effect.
  - `deadLetter` — job/evento de outbox esgotou tentativas.
  - `migrationReadiness` — checagem de readiness/migration falhou.
  - `ownerOrBillingChange` — troca de owner ou alteração de plano/pagamento.
- Relato manual (usuário ou operador percebe comportamento anômalo).
- Auditoria de rotina (`GET /api/auditoria`, restrito a `organization:manage`).

## 4. Triagem

1. Registrar timestamp de detecção.
2. Consultar a trilha de auditoria filtrando por `correlationId` do evento que disparou o
   alerta (`listAuditEvents` / `GET /api/auditoria?acao=...`) para reconstruir a cadeia
   completa request → webhook → job → outbox → provider (correlation_id propagado ponta a
   ponta, ver `src/lib/observability/correlation.ts` e as tabelas de durabilidade da
   migration `48_outbox_lease_correlacao.sql`).
3. Classificar severidade (seção 2) com base em evidência objetiva da trilha, não em
   suposição.
4. Se SEV-1/SEV-2: acionar IC interino, abrir registro de incidente (seção 8).

## 5. Contenção

Ações permitidas sem aprovação adicional (execução imediata pelo Tech Lead do incidente):

- Revogar sessão/token do ator envolvido.
- Suspender temporariamente a conexão de integração afetada (`health_status =
  'disconnected'`, já suportado pelo outbox/health do ticket 12).
- Bloquear IP/origem no nível de aplicação, se disponível.
- Rotacionar segredo/credencial comprometida (webhook secret, OAuth client secret, chave
  de API) — nunca registrar o valor antigo ou novo em log/auditoria (redaction cobre isso
  estruturalmente, mas a ação em si deve ser feita fora de qualquer campo de metadata
  livre).

Ações que exigem aprovação do IC:

- Suspender a organização inteira.
- Reverter dados (rollback de linha/tabela).
- Comunicação externa a clientes/titulares.

**O que nunca fazer durante a contenção** (regra explícita do ticket): nunca apagar ou
desligar eventos de auditoria existentes ou trilha já coletada — mesmo em rollback de uma
regra de alerta ruidosa, a trilha já persistida é imutável. Rollback de uma alteração
técnica reduz destino/ruído futuro, nunca apaga histórico.

## 6. Preservação de evidências

- A trilha de auditoria (`eventos_auditoria_sistema`) já é imutável por design (RPC
  `security definer`, sem `update`/`delete` expostos). Nenhuma ação adicional é necessária
  para preservá-la.
- Exportar (via `listAuditEvents`/`GET /api/auditoria`, correlacionando por
  `correlationId`) os eventos relevantes para um artefato de incidente separado, mantendo
  o mesmo nível de redaction já aplicado — nunca reexportar em formato menos protegido.
- Preservar logs estruturados do período (já vêm com `redactSensitiveData`/
  `redactSensitiveText` aplicados na origem).
- Registrar hashes/contagens do conjunto de evidências no registro do incidente (seção 8)
  para permitir auditoria posterior da própria investigação.

## 7. Avaliação de risco LGPD

Acionar o DPO (`needs-owner`) sempre que o incidente envolver dado pessoal de titular.
Usar o mapeamento de dados já existente (`docs/privacy/data-inventory.md`,
`docs/privacy/ropa.md`) para determinar:

- Quais categorias de dado pessoal podem ter sido expostas.
- Se há indício de acesso indevido (não apenas tentativa recusada — tentativa recusada
  pela RPC de anti-forjamento, por si só, não configura violação consumada).
- Prazo de comunicação à ANPD/titulares conforme Art. 48 da LGPD, se aplicável — decisão
  final do DPO, não deste playbook.

## 8. Registro do incidente

Cada incidente SEV-1/SEV-2 gera um registro contendo:

- ID do incidente, severidade, IC, timestamps de detecção/contenção/encerramento.
- `correlationId`(s) envolvidos e lista de eventos de auditoria referenciados (por `id`,
  nunca reproduzindo payload bruto no registro).
- Ações de contenção tomadas e por quem.
- Avaliação LGPD (se aplicável) e decisão do DPO.
- Comunicação enviada (interna/externa) e a quem.
- Ações corretivas e prazo.

Retenção do registro de incidente: mesma política de retenção do evento de auditoria mais
sensível envolvido (ver `retentionDias` em `auditEventCatalog.ts`, mínimo 1825 dias para
eventos críticos de segurança/billing). Acesso ao registro restrito a IC, DPO e
administradores da organização afetada — mesma capacidade `organization:manage` já
aplicada à leitura da trilha de auditoria.

## 9. Comunicação

- Interna: IC informa stakeholders técnicos assim que a severidade é confirmada.
- Externa (clientes/titulares): apenas após avaliação do DPO (seção 7) e aprovação do IC;
  nunca antes da contenção inicial ter reduzido o risco ativo.
- Nunca incluir em qualquer comunicação: token, cookie, segredo, payload bruto, ou dado
  pessoal de terceiros não relacionado ao destinatário.

## 10. Recuperação

- Confirmar que a causa raiz foi corrigida (patch de código, migration, rotação de
  segredo) antes de encerrar a contenção.
- Restaurar capacidade/organização suspensa apenas após validação técnica.
- Encerrar o incidente formalmente com timestamp e responsável.

## 11. Postmortem

Todo incidente SEV-1 e todo SEV-2 que exigiu contenção ativa recebe postmortem sem culpa
(blameless) em até 5 dias úteis do encerramento, cobrindo: linha do tempo, causa raiz,
o que funcionou na detecção/contenção, o que não funcionou, e ações corretivas com dono e
prazo. O tabletop sintético (seção 12) é o modelo de referência para o formato esperado.

## 12. Tabletop obrigatório

Nenhum runbook é considerado pronto sem ter sido ensaiado. O tabletop sintético executado
para este ticket está documentado em
`.scratch/orbita-mvp-producao-v2/evidence/19-tabletop-report.md` — cenário cross-tenant +
webhook comprometido, 100% com dados sintéticos, cobrindo detecção, triagem, decisão,
contenção, preservação de evidências, comunicação simulada e ações corretivas.

## 13. Relógio de decisões (referência rápida)

```
T+0     Alerta dispara (sink local/estruturado) ou relato manual chega
T+15min IC interino confirma severidade a partir da trilha de auditoria (SEV-1)
T+30min Contenção inicial aplicada (revogar sessão/token, suspender conexão)
T+1h    DPO acionado se dado pessoal envolvido; registro de incidente aberto
T+24h   Avaliação LGPD concluída (decisão de notificar ANPD/titulares ou não)
T+5d    Postmortem publicado (SEV-1/SEV-2 contido)
```

## 14. Dependências `needs-owner`

- Nomeação real de IC, Tech Lead, DPO e Comunicação (nomes, contatos, canal de plantão).
- Ferramenta de plantão (PagerDuty/Opsgenie ou equivalente) e integração real do
  `AlertSink` (`src/lib/observability/alerting.ts`) com esse canal em staging/produção —
  não existe staging implantado neste projeto ainda.
- Aprovação formal deste playbook pelos responsáveis de segurança/DPO.
- Prova de entrega real de alerta em ambiente de staging (este ticket prova apenas contra
  sink local/controlado, conforme restrição estrutural do projeto).
