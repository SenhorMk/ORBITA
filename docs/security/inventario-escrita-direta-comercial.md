# Inventário da escrita direta — catálogo, clientes, pedidos e estoque (PRE-006A)

Escopo: `produtos`, `categorias`, `movimentacao_estoque`, `clientes`,
`pedidos` e `itens_pedido`. Base: `main` em `091fd01` + este PR.

Fontes, todas executadas:
- código em `src/` (varredura de `.from(...)`/`.rpc(...)`, rotas e repositórios);
- catálogo de um laboratório descartável com a cadeia canônica;
- leitura somente leitura do projeto de desenvolvimento `etqjqeqqbjrzyyxodntv`: grants, policy de estoque e publicação Realtime iguais ao laboratório.

As regras deste inventário viram teste em dois lugares:
- `src/lib/escritaDiretaComercial.test.ts`: o que o navegador faz;
- `supabase/tests/final/escrita_direta_comercial.test.sql`: o que o banco concede.

## 1. Navegador (chave anônima + sessão do usuário)

O navegador **não grava** em nenhuma das seis tabelas e não chama RPC do banco.

| Caller | Tabela | Operação | Autorização | Boundary |
|---|---|---|---|---|
| `src/app/page.tsx` (itens do pedido selecionado) | `itens_pedido` (+ `produtos` embutido) | SELECT | RLS por membership | leitura direta |
| `src/components/ManualOrderModal.tsx` (opções do formulário) | `clientes`, `produtos` | SELECT | RLS por membership | leitura direta; o servidor relê tudo no envio |
| `src/components/produtos/ImagemDoProduto.tsx` | Storage `produto-imagens` | upload | URL assinada emitida por `POST /api/produtos/imagem/upload` (`organization:manage`) | boundary existente |

Todas as mutações saem por `fetchWithAuth` para as rotas da seção 2.

**Realtime:** nenhuma das seis tabelas está na publicação `supabase_realtime`, nem no laboratório nem no projeto de desenvolvimento. O único canal do navegador, `espelhoDaMensageria.ts`, é da mensageria e está fora do escopo.

## 2. Servidor (service role, escopo verificado)

| Rota / caller | Tabelas escritas | Sessão + organização | Capacidade | Zod | Auditoria |
|---|---|---|---|---|---|
| `POST /api/produtos/update` | `produtos` | contexto verificado | `organization:manage` | sim | — |
| `POST /api/produtos/arquivar` | `produtos` (RPC `arquivar_produto`) | `autorizarCorrecaoOperacional` | `organization:manage` | sim | eventos `produtos.arquivamento.*` |
| `POST /api/produtos/imagem/{upload,confirmar,remover,sincronizar}` | `produtos` | `autorizarCorrecaoOperacional` | `organization:manage` | sim | `auditarCorrecao` |
| `POST /api/categorias/sync` | `categorias` | escopo verificado | `organization:manage` | sim | — |
| `POST /api/clientes/update` | `clientes` | contexto verificado | `organization:manage` | sim | só log de falha |
| `POST /api/clientes/delete` | `clientes` | `autorizarCorrecaoOperacional` | `organization:manage` | sim | `auditarCorrecao` |
| `POST /api/pedidos/manual` (+ `/reconciliar`) | `pedidos`, `itens_pedido`, `clientes.bling_id`, `produtos`/`movimentacao_estoque` (RPCs da venda manual) | escopo verificado | `organization:manage` | sim | ledger de tentativas/intervenções |
| `PUT`/`DELETE /api/bling/pedidos/[id]` | `pedidos`, `itens_pedido` | escopo verificado | `organization:manage` | sim | — |
| `POST /api/pedidos/status` | `pedidos`, `produtos.estoque` | escopo verificado | **`organization:manage` (este PR)** | sim | só log de falha |
| `POST /api/sync` (job) | `produtos`, `clientes`, `pedidos`, `itens_pedido` | escopo verificado | `organization:manage` | — | job durável |
| `POST /api/bling/webhook` | `produtos`, `clientes`, `pedidos`, `itens_pedido` | HMAC + conexão autenticada | n/a (integração) | sim | inbox idempotente |
| `POST /api/chatwoot/sync` → `integrationService.linkSacToErp` | `clientes` (INSERT de auto-registro) | contexto verificado | **nenhuma** — ver achado 3 | — | — |
| `DbAdapter` (privacidade) | `clientes` | — | — | — | sem caller em produção (só testes) |

Funções do banco que escrevem nas seis tabelas: todas executáveis **só** por
`service_role` ou rodam como gatilho:
- `arquivar_produto`, `registrar_exclusao_de_produto_no_bling`;
- `baixar_estoque_organizacao`, `registrar_venda_manual`;
- leases e divergência da foto;
- retenção e encerramento;
- backfills de tenancy;
- gatilhos de reserva.

`rpc_criar_pedido_manual` não tem grant para ninguém: é legado e não é chamável.

## 3. Banco (o que `authenticated` pode fazer direto pelo PostgREST)

| Tabela | Grant DML de `authenticated` | RLS | Policies |
|---|---|---|---|
| `produtos`, `categorias`, `clientes`, `pedidos`, `itens_pedido` | INSERT, UPDATE, DELETE | ligada | `*_org_{select,insert,update,delete}`, só membership |
| `movimentacao_estoque` | INSERT, UPDATE, DELETE | ligada | antes: legada `organização OR user_id = auth.uid()`; **agora** `movimentacao_estoque_org_*`, só membership (migration 78) |

Nenhuma RPC executável por `anon`/`authenticated` escreve nas seis tabelas.
Os grants ficam intactos nesta fatia; a revogação é do PRE-006D.

## Achados

1. **Corrigido — estoque cross-tenant** (migration 78). A policy legada aceitava `user_id = auth.uid()` em USING e WITH CHECK. Provado em laboratório:
   - quem não é membro de A (um ex-membro) lia, alterava e apagava as movimentações que gravou no livro de A;
   - forjava movimentação nova em A;
   - um membro de A gravava em B pelo mesmo ramo.

   Agora vale só membership, como nas outras cinco tabelas. Contraprova: recriar a policy legada derruba os casos 1-4, 7 e 8 do teste final.
2. **Corrigido — `POST /api/pedidos/status` sem capacidade.** Um `member` mudava a situação do pedido e o estoque, aqui e no Bling. A rota não tem tela que a chame; agora exige `organization:manage`, como as demais mutações comerciais.
3. **Para decisão (PRE-006C / mensageria) — auto-registro de cliente pelo SAC.** `POST /api/chatwoot/sync`, chamado pela tela de mensageria, cria cliente (nome `Cliente Chatwoot` quando o contato não tem nome, `bling_id` temporário) para qualquer membro.
   - Sem vazamento entre organizações.
   - Mas é escrita em `clientes` sem `organization:manage` e sem auditoria.
   - Exigir a capacidade aqui pararia a sincronização do SAC para membros, por isso não foi alterado.
4. **Fora do escopo:** policies com `auth.uid()` em `financeiro` e `integracoes_bling` (PRE-007A / PRE-008). As demais são checagens de admin.
5. **Auditoria das rotas existentes:** produtos/update, categorias/sync e bling/pedidos não registram evento de auditoria. clientes/update e pedidos/status registram só a falha. Fica para PRE-006B/C, que tocam esses fluxos; este PR não cria boundary novo que precise auditar.

## Comandos ausentes

Nenhum fluxo do navegador grava direto, então **não há comando novo a criar**:
toda mutação legítima do produto já tem rota com escopo verificado,
`organization:manage` e Zod. Consequência para os próximos tickets:
- **PRE-006B/C:** não há caller de DML no navegador a migrar. O que resta é o grant de DML de `authenticated`, que o PRE-006D revoga, e as leituras diretas da seção 1.
- **PRE-006D:** pode revogar INSERT/UPDATE/DELETE das seis tabelas para `authenticated` sem quebrar fluxo. Os testes deste PR mostram que nenhuma mutação do produto depende desse grant.

## Matriz de efeitos externos (17 casos)

Inaplicável: esta fatia não cria efeito externo novo. A rota de situação
apenas ganhou uma recusa **antes** de qualquer chamada ao Bling.
