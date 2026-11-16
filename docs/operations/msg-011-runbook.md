# Retrato do pedido no atendimento (MSG-011) — migration 93_retrato_do_pedido_sac.sql

O atendente vê os itens, o estoque, o pagamento e o rastreio de um pedido do
cliente confirmado na conversa, e se esses dados são recentes. Só leitura. Fica
na ordem 96 do ledger, logo depois da migration 92 do MSG-010 (PR #147).

A mesma função servirá às ferramentas da automação (MSG-014). Hoje nenhuma
automação a chama.

## 1. Caminho

```text
cockpit: GET /api/sac/pedidos/retrato?conversaId=…&pedidoId=…
             retrato_do_pedido_verificado_sac (stable, só service_role)
             → fatos crus: pedido, até 50 itens com o estoque do produto,
               título a receber, sync_state e último sync_job
             montarRetrato (domínio): estoque, pagamento, rastreio, frescor
             → { retrato: { pedido, itens, totalDeItens, itensOmitidos,
                            pagamento, rastreio, frescor } }
```

| Peça | Onde |
|---|---|
| Função | `retrato_do_pedido_verificado_sac(organizacao, conversa, pedido)`, `stable`, `security definer`, só `service_role` |
| Domínio e adaptador | `src/services/sac/retratoDoPedido.ts` (`montarRetrato`, `lerRetratoDoPedido`) |
| Rota | `src/app/api/sac/pedidos/retrato/route.ts` (handler em `src/app/api/sac/verificacao/handlers.ts`) |
| Contrato | `src/lib/integrations/contratoDoRetrato.ts` (v1, objetos estritos) |
| Tela | `src/components/mensageria/RetratoDoPedido.tsx`, aberto pelo botão "Detalhes" do `PainelDoCliente` |

## 2. Regras

- **Escopo.** O cliente vem da prova vigente do MSG-010, nunca de parâmetro.
  Sem prova: `sem_prova` (409). Pedido de outro cliente, de outra organização ou
  inexistente: a mesma resposta, `nao_encontrado` (404).
- **Não escreve nem sincroniza.** A função é `stable`, e o Postgres recusa
  INSERT, UPDATE e DELETE dentro dela. A autoverificação da migration aborta se
  ela deixar de ser `stable`. Se o espelho estiver velho, o retrato diz isso;
  buscar no Bling é outra operação.
- **Estoque.** Disponível = `estoque - estoque_reservado` do produto da mesma
  organização, só para produto ativo, nunca negativo (`indisponivel` com 0).
  Produto inativo ou arquivado: sem quantidade. Item sem produto da organização:
  `desconhecido` (as FKs compostas da migration 40 tornam esse caso improvável,
  mas ele não vira zero).
- **Pagamento.** Só o título **a receber** ligado ao pedido conta. Conta a pagar
  ligada ao pedido e assinatura do ORBITA não são pagamento do cliente. Sem
  título: `desconhecido`; a forma de pagamento do pedido só aparece como
  "informada". Quando o título tem o código do Bling, ele decide: 1 em aberto,
  2 pago, 3 parcial, 4 e 6 devolvido, 5 cancelado, 7 `desconhecido` (não prova
  pagamento). Sem código, vale a situação local. Em aberto com vencimento
  passado: `vencido`.
- **Rastreio.** O ORBITA não guarda rastreio. Sempre `desconhecido`, motivo
  `sem_fonte`, até existir uma fonte.
- **Frescor, por parte.** Pedido e estoque usam `sync_state` (`pedidos`,
  `produtos`) e o último `sync_jobs` terminado; pagamento usa
  `financeiro_contas_receber`. `atual` exige sincronização boa há menos de 24
  horas e nenhuma falha depois dela. Senão `desatualizado` (`antiga` ou
  `ultima_sincronizacao_falhou`), ou `desconhecido` (`sem_sincronizacao`). É
  conservador: um webhook recente não deixa o dado `atual` se a última
  sincronização completa falhou.
- **Cardinalidade.** Até 50 itens; `itensOmitidos` diz quantos ficaram de fora.
- **Dados do cliente.** Documento, telefone, endereço e ids do Bling não saem
  da função. O contrato é estrito: campo a mais na resposta do banco vira 503,
  não vaza.

| Resultado | HTTP |
|---|---|
| retrato | 200 |
| `sem_prova` | 409 |
| `nao_encontrado`, `conversa_nao_encontrada` | 404 |
| parâmetros que não são UUID | 400, nada consultado |
| sem sessão / sem vínculo ou capacidade | 401 / 403 |
| banco fora ou resposta fora do contrato | 503, nunca retrato vazio |

**Trilha.** A rota registra `sac.retrato_do_pedido` com `correlationId`,
organização, ator, conversa, desfecho e, no retrato, a situação de frescor de
cada parte. Sem item, valor, número do pedido ou dado do cliente. Leitura não
grava auditoria no banco.

## 3. Decisões para a proprietária

1. O limite de 24 horas para considerar o espelho atual é um padrão
   conservador escolhido na implementação. Confirmar ou ajustar.
2. Rastreio: existe uma fonte desejada (campo do Bling, transportadora)? Até lá,
   a resposta honesta é "desconhecido".
3. No Staging de hoje, a última sincronização de pedidos e produtos terminou em
   14/10/2026 e há jobs falhando desde então (o último em 10/11/2026). Todo
   retrato vai aparecer como desatualizado até uma sincronização completar.

## 4. Implantação da migration 93

Depende da 92 (MSG-010), já aplicada no Staging.

| Banco \ App | App anterior | App deste PR |
|---|---|---|
| **Sem a 93** | funciona | O botão "Detalhes" mostra erro (a RPC não existe; 503). O resto da Mensageria e o painel do cliente funcionam |
| **Com a 93** | funciona (a 93 só cria uma função) | funciona |

Ordem, cada passo com autorização explícita:

1. **Conferir o alvo, só leitura:** `npm run db:remoto:status` contra o Staging
   mostra só a 93 (ordem 96) pendente.
2. **Aplicar a 93** (`npm run db:remoto:aplicar`). Impacto: cria uma função e
   ajusta os grants dela. Não cria tabela, não altera linha, não varre dados e
   não pede trava de tabela (`lock_timeout = 5s` por garantia).
3. **Validar, só leitura:**

   ```sql
   select has_function_privilege('authenticated',
     'public.retrato_do_pedido_verificado_sac(uuid,uuid,uuid)', 'execute');   -- false
   select provolatile from pg_proc
    where oid = 'public.retrato_do_pedido_verificado_sac(uuid,uuid,uuid)'::regprocedure;  -- s
   ```

4. **Merge** (autorização separada).

### Rollback

- **App:** reimplantar o deployment anterior. Banco com a 93 e app antigo é compatível.
- **Banco:** forward-only. Para desligar a leitura sem migration:
  `revoke execute on function public.retrato_do_pedido_verificado_sac(uuid,uuid,uuid) from service_role;`
  A rota passa a responder 503 e o atendente segue sem os detalhes. Um defeito
  na 93 é corrigido por uma migration nova.

## 5. Verificação

```bash
npx vitest run src/services/sac src/app/api/sac src/components/mensageria
```

```bash
npm run test:db
```
