# Ticket 10b — Inventário de métodos e chamadores do Bling

Gerado a partir do código em 2026-08-29, não de memória: a lista sai de um
varredor que casa cada método público de `src/services/bling.ts` com todas as
linhas do `src/` que o chamam.

## Resultado da fatia 2

| Antes | Depois |
|---|---|
| 43 métodos públicos | 35 |
| 33 com chamador de produção | 33 |
| **7 sem chamador nenhum** | 0 |
| `lancamentoEstoque` público, com chamador só interno | privado |

Removidos por não ter chamador algum, nem interno: `updateProduto`,
`updateContato`, `createProduto`, `getContatosByPesquisa`,
`createContaPagar`, `getResumoFinanceiro`, `getContasFinanceiras`. Os quatro
primeiros eram as versões pré-Tickets 31/32/33, substituídas por
`atualizarProduto`, `atualizarContato`, `criarProduto` e `criarContaPagar`;
os três últimos nunca tiveram chamador. Ao todo, **220 linhas** a menos.

`getContasFinanceiras` merece nota: além de morto, apontava para
`/contas-financeiras`, caminho que **não existe** na API (Ticket 33).

## Métodos com chamador de produção

| Método | Chamadores |
|---|---|
| `ping` | src/app/api/startup/route.ts:38 |
| `getPedidos` | src/services/sync.ts:355 |
| `getPedido` | src/app/api/bling/pedidos/[id]/route.ts:48<br>src/app/api/bling/webhook/route.ts:217 |
| `getClientes` | src/app/api/financeiro/fornecedores/route.ts:45<br>src/services/sync.ts:240 |
| `getContatosByNome` | src/app/api/financeiro/route.ts:77 |
| `getProdutos` | src/services/sync.ts:282 |
| `buscarProdutoPorCodigo` | src/app/api/produtos/update/route.ts:64 |
| `getCategoriasProdutos` | src/app/api/categorias/sync/route.ts:25 |
| `getProduto` | src/app/api/bling/webhook/route.ts:270 |
| `deleteProduto` | src/app/api/produtos/delete/route.ts:20 |
| `getEstoquesSaldos` | src/app/api/pedidos/status/route.ts:61<br>src/services/sync.ts:289 |
| `createNfe` | src/app/api/nfe/route.ts:52 |
| `createContato` | src/app/api/financeiro/fornecedores/route.ts:89<br>src/app/api/pedidos/manual/handler.ts:98 |
| `criarContato` | src/app/api/clientes/update/route.ts:59<br>src/app/api/financeiro/route.ts:94 |
| `atualizarContato` | src/app/api/clientes/update/route.ts:60 |
| `deleteContato` | src/app/api/clientes/delete/route.ts:38 |
| `updatePedido` | src/app/api/bling/pedidos/[id]/route.ts:55 |
| `criarPedidoVenda` | src/app/api/pedidos/manual/route.ts:156 |
| `lancarEstoquePedidoVenda` | src/app/api/pedidos/manual/route.ts:157 |
| `obterFormaPagamentoPadraoId` | src/app/api/pedidos/manual/route.ts:154 |
| `criarContatoParaVenda` | src/app/api/pedidos/manual/route.ts:155 |
| `criarProduto` | src/app/api/produtos/update/route.ts:84 |
| `atualizarProduto` | src/app/api/produtos/update/route.ts:85 |
| `definirSaldoProduto` | src/app/api/produtos/update/route.ts:86 |
| `deletePedido` | src/app/api/bling/pedidos/[id]/route.ts:59 |
| `updateSituacaoPedido` | src/app/api/pedidos/status/route.ts:123 |
| `getSituacoesModulo` | src/app/api/bling/situacoes/route.ts:19 |
| `criarContaPagar` | src/app/api/financeiro/despesaHandler.ts:103<br>src/app/api/financeiro/route.ts:119 |
| `baixarContaPagar` | src/app/api/financeiro/despesaHandler.ts:141<br>src/app/api/financeiro/route.ts:121 |
| `obterContaFinanceiraPadraoId` | src/app/api/financeiro/route.ts:120 |
| `getContasReceber` | src/app/api/financeiro/sync/route.ts:146 |
| `getContasPagar` | src/app/api/financeiro/sync/route.ts:140 |
| `getCategorias` | src/app/api/financeiro/route.ts:46 |

## Sem chamador externo (uso interno)

- forceRefreshToken
- emitirNfe

Ambos são chamados de dentro do próprio adapter — `forceRefreshToken` por
`fetchWithAuth` e `getAccessToken`, `emitirNfe` por `createNfe` — então
continuam públicos apenas por conveniência de leitura; não fazem parte da
`BlingPort`.

## Prova de que ninguém depende da classe concreta

```bash
grep -rn "BlingClient" --include=*.ts --include=*.tsx src | grep -v "src/services/bling.ts" | grep -v ".test."
```

As únicas ocorrências são `findBlingClientId` (o *client id* do OAuth, outro
conceito) e o tipo `BlingCliente`. Nenhum consumidor referencia a classe: todos
tipam por `BlingPort`, e `bling.forVerifiedOrganization` declara `BlingPort`
como retorno.
