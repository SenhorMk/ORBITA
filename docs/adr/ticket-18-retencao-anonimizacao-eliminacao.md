# ADR — Ticket 18: retenção, anonimização e eliminação

## Contexto

O Ticket 15 (`docs/privacy/data-inventory.md`, `ropa.md`) mapeou o tratamento de dados pessoais da
ORBITA e marcou **todos** os prazos de retenção como `needs-legal-review`/`needs-owner`/"Indefinida —
sem TTL". Nenhum prazo real foi aprovado pelo dono do produto — a aprovação está agendada para o fim
do Ticket 25. O Ticket 18 constrói o **mecanismo** completo de retenção/anonimização/eliminação, mas
não decide nenhuma política real: o registry é populado apenas com placeholders `pending_approval`.

## Decisões

1. **Registry versionado, nunca mutado in-place.** `retention_policy_registry` só recebe `INSERT`;
   uma mudança de prazo/ação é sempre uma nova versão (nova linha), nunca um `UPDATE`. Só pode existir
   uma versão `approved` por categoria por vez (`uq_retention_policy_categoria_aprovada`, índice
   parcial). As duas categorias reais seedadas (`cliente_final_pii` → `clientes`,
   `chatwoot_contato_inativo` → `chatwoot_contacts`) ficam `pending_approval` com `prazo_dias = 999999`
   — um valor deliberadamente absurdo para nunca ser confundido com uma decisão real de produto.

2. **`clientes` nunca é elegível a `delete`.** O trigger `tg_prevenir_exclusao_cliente`
   (`schema_master.sql`) já bloqueia `DELETE FROM clientes` quando existem `pedidos` vinculados —
   retenção fiscal/contábil implícita. A única RPC de exclusão (`retencao_aplicar_exclusao`) só aceita
   `tabela_alvo = 'chatwoot_contacts'`; `clientes` só é alcançável por
   `retencao_aplicar_anonimizacao`, que preserva a linha (e a integridade referencial de `pedidos`) e
   apenas anula os campos de PII.

3. **Anonimização é irreversível por construção — nunca hash.** `retencao_aplicar_anonimizacao` faz
   `UPDATE ... SET email = null, telefone = null, cpf_cnpj = null, nome = 'Titular anonimizado'`. Um
   hash simples de e-mail/telefone sem salt é reversível por dicionário/rainbow table (permitiria
   reidentificação por força bruta de um espaço pequeno de e-mails/telefones plausíveis) — o ticket
   proíbe isso explicitamente, e o projeto já usa essa mesma convenção em
   `executar_encerramento_definitivo` (`database/35_suspensao_retencao_encerramento.sql`).

4. **Seletor único compartilhado entre dry-run e execução.** `retencao_selecionar_e_reivindicar_lote`
   é a única fonte de candidatos; `runRetention` (`src/services/privacy/retentionRunService.ts`) e a
   decisão de elegibilidade (`evaluateRetentionEligibility`,
   `src/domain/privacy/retentionPolicy.ts`) são exatamente as mesmas para os dois modos — a única
   diferença é se `adapter.apply` é chamado (`execute`) ou só `adapter.preview` (`dry_run`).

5. **Claim idempotente sem lock explícito de aplicação.** A seleção já reivindica o item
   (`INSERT ... ON CONFLICT (run_id, entidade_id) DO NOTHING RETURNING`) dentro da mesma função que
   faz `SELECT ... FOR UPDATE SKIP LOCKED` na tabela de origem. Duas chamadas concorrentes com a MESMA
   run (mesma chave de idempotência de `retention_runs`) nunca processam o mesmo item duas vezes —
   provado em `supabase/tests/database/retencao.test.sql` (assertions 8-10) e em
   `retentionRunService.test.ts` ("duas execuções concorrentes").

6. **Relógio sempre injetado.** Nenhuma função de decisão (`computeCutoff`,
   `evaluateRetentionEligibility`) chama `Date.now()`/`new Date()` internamente. No nível de banco, o
   cutoff também é sempre um parâmetro explícito (`p_cutoff`), nunca `now()` computado dentro da lógica
   de seleção — os testes de banco controlam o cutoff diretamente via `interval`.

7. **Tombstone é um ledger append-only protegido por trigger — mesmo `service_role` não apaga.**
   `fn_retention_tombstone_bloquear_mutacao` bloqueia `UPDATE`/`DELETE` incondicionalmente. Isso é o
   que permite `retencao_reaplicar_tombstones_restore` detectar, após um restore de backup, que uma
   linha "ressuscitada" já havia sido eliminada antes do backup e reaplicar a supressão.

8. **Falha parcial nunca vira `completed`.** Tanto a camada de aplicação (`runRetention`) quanto a RPC
   `retencao_concluir_run` (defesa em profundidade) recusam marcar uma run como `completed` se
   `contagem_falhos > 0` — força `completed_with_errors`.

9. **Providers reusam o outbox do ticket 12, não um HTTP client novo.**
   `src/services/privacy/adapters/retentionOutboxAdapter.ts` é estruturalmente idêntico a
   `OutboxProviderAdapter` (ticket 17) — mesmo `ensureEnqueued`, mesma idempotência por
   `organizacao_id + idempotency_key`, mesmo retry/dead-letter existente
   (`database/31_outbox_retries_saude_integracoes.sql`). Nenhuma lógica de retry foi duplicada.

## Backup e restore — o que este ticket documenta, não implementa

A infraestrutura de backup do Supabase é gerenciada pelo painel do projeto e está fora do repositório
(`docs/privacy/data-inventory.md` #30, já marcado `needs-owner`). Este ticket **não implementa** rotação
de backup nem uma pipeline de restore real. O que existe:

- `retention_tombstones` como ledger que sobrevive a qualquer restore de tabela de dado (não é uma
  tabela de dado do domínio, é o próprio mecanismo de proteção).
- `retencao_reaplicar_tombstones_restore(organizacao_id)`: deve ser chamada **antes de servir
  tráfego** depois de qualquer restore de backup que possa ter reintroduzido `clientes`/
  `chatwoot_contacts` anteriores à eliminação. Testado sinteticamente em
  `supabase/tests/database/retencao.test.sql` (assertions 22-23): um `UPDATE` direto simula a
  reintrodução de dado por restore, e a reconciliação detecta e reaplica a supressão.
- **Janela de expiração do backup**: não confirmada no repositório — o painel do Supabase controla
  quanto tempo um backup fica disponível para restore. Enquanto essa janela não for confirmada, o
  ledger de tombstones deve ser tratado como retenção **indefinida** (nunca expurgado), porque não há
  garantia de que todos os backups anteriores a um tombstone já expiraram.

## needs-owner (lista completa)

1. **Prazos reais de retenção por categoria.** Pendentes de aprovação jurídica/produto (fim do
   Ticket 25). Enquanto `status != 'approved'`, `evaluateRetentionEligibility` recusa qualquer
   elegibilidade (`reason: 'policy_not_approved'`) — o mecanismo fica travado por construção, não por
   convenção de operação.
2. **Ativação em produção / scheduler.** Este ticket não liga nenhum cron/job periódico. `execute` só
   deve rodar manualmente em laboratório local descartável até uma decisão explícita de ativação, com
   pacote de autorização, contagem esperada, backup validado e rollback lógico (conforme
   `AGENTS.md`/contrato 00).
3. **Canal real de purge em Bling/Chatwoot.** O outbox enfileira o evento de forma durável e
   idempotente, mas nenhuma rota de produção registra os adapters reais em `runOutboxWorkerOnce`
   (mesmo gap já documentado no ADR do ticket 17). Enquanto isso, uma tarefa endereçada a
   `bling`/`chatwoot` fica honestamente `retryable`.
4. **Política de backup/retenção do Supabase.** Confirmar no painel do projeto a janela de expiração
   de backup e registrar aqui — necessário para decidir quando (se algum dia) o ledger de tombstones
   pode ser considerado seguro para expurgo.
5. **Categorias adicionais do inventário do Ticket 15** (ex.: `fornecedores`, `chatwoot_messages`,
   `eventos_auditoria_sistema`, `inbox_eventos_*`/`outbox_eventos`) não têm registry ainda — o
   mecanismo é genérico o suficiente para receber novas linhas de `retention_policy_registry` mais
   `tabela_alvo` novas no `check` constraint via migration futura, mas isso é trabalho de escopo de
   política (quais categorias, qual ação), não deste ticket.
6. **Validação real de "obrigação" para exclusão.** `retention_policy_registry.requer_validacao_obrigacao`
   é um marcador estrutural; hoje nenhuma verificação automática consulta um sistema fiscal externo
   antes de eliminar — a única obrigação hoje verificada é a constraint de FK já existente
   (`tg_prevenir_exclusao_cliente`). Se uma categoria futura precisar de uma checagem externa real
   (ex.: nota fiscal emitida), isso é uma decisão de produto/jurídico a especificar.
