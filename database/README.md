# ORBITA Database Migrations Ledger

Este diretório contém a história de migrations forward-only do banco de dados PostgreSQL do ORBITA (Supabase).

## 📜 Ordem Canônica de Execução

As migrations devem ser executadas na seguinte ordem estrita:

1. `schema_master.sql` — Definição estrutural inicial do schema do ORBITA (auth, catálogo, pedidos, estoque, sync e RLS base).
2. `03_update_pedidos_status.sql` — Atualização da constraint de verificação dos status de pedidos.
3. `04_fix_linter_errors.sql` — Ajuste de search_path de funções e otimização de RLS com `(select auth.uid())`.
4. `05_add_pedidos_details.sql` — Colunas opcionais de detalhes (`desconto`, `frete`, `observacao`) na tabela `pedidos`.
5. `06_financeiro.sql` — Módulo financeiro Bling v3 (`categorias_financeiras`, `titulos_financeiros`).
6. `07_bling_auth_lock.sql` — Lock atômico `acquire_bling_token_lock` para rotação de tokens OAuth.
7. `07_estoque_rpc.sql` — RPC atômica `decrement_estoque` para baixa concorrente de estoque.
8. `08_add_user_id.sql` — Adição de coluna de tenant `user_id` nas tabelas financeiras.
9. `08_contas_financeiras_fornecedores.sql` — Tabelas de bancos/caixas (`contas_financeiras`) e fornecedores.
10. `09_harden_grants_and_rpcs.sql` — Revogação de privilégios de roles públicas (`anon`, `public`) e default privileges.
11. `10_contain_financeiro_domain.sql` — Contenção e RLS estrita por tenant em todas as tabelas financeiras.
12. `11_contain_chatwoot_domain.sql` — Contenção e RLS estrita por tenant em todas as tabelas Chatwoot.

## 🛡️ Regras de Engenharia do Banco

- **Forward-only**: Nunca reescrever nem apagar migrations já publicadas.
- **Rerunnable/Idempotente**: Usar `IF NOT EXISTS`, `OR REPLACE` e tratamento seguro de exceções.
- **Segurança ASVS L2**: Nenhuma tabela nova pode ser criada sem chave de tenant (`user_id` / `organization_id`) e RLS estrita.
- **Testes Obrigatórios**: Qualquer alteração de DDL deve vir acompanhada de suíte pgTAP em `supabase/tests/database/` e passar em `npm run test:db`.
