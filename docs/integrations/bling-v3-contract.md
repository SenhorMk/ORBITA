# Contrato Bling API v3 — congelado para o Ticket 10

Este documento descreve o contrato Bling v3 realmente consumido pelo ORBITA:
endpoints, OAuth, paginação, schemas de payload usados, códigos/erros,
rate-limit/retry, timeout e idempotência.

## Fonte de verdade: o OpenAPI oficial e público

```
https://developer.bling.com.br/build/assets/openapi-BvBfsn8J.json
```

OpenAPI 3.0.0, "Bling API" v3.0, 162 paths. Responde `200 application/json`
**sem autenticação**. O portal `developer.bling.com.br/referencia` é uma SPA
Swagger UI; o módulo `build/assets/reference-*.js` instancia o Swagger
apontando para essa URL. O nome do arquivo carrega um hash de build, então
confirme-o em `reference-*.js` antes de assumir que continua válido.

> **Correção (Ticket 30).** A versão anterior deste documento registrava como
> limitação conhecida que o portal "exige sessão autenticada para exploração
> completa de schemas por endpoint", e por isso conferia os payloads apenas
> contra os comentários do próprio `src/services/bling.ts`. Isso é falso, e a
> consequência foi concreta: o payload de `POST /pedidos/vendas` divergia do
> schema oficial em quatro campos obrigatórios e nunca poderia ter funcionado
> contra a API real. Conferir código contra código não é conferir contra a
> documentação.

## 1. OAuth 2.0

- **Authorize:** `GET https://www.bling.com.br/Api/v3/oauth/authorize`
  Parâmetros: `response_type=code`, `client_id`, `state` (usado pelo ORBITA
  como token opaco de correlação — o mecanismo one-time do Ticket 07 em
  `src/lib/oauth-transaction.ts` gera, hasheia e consome esse `state` de
  forma atômica). `scope` é opcional segundo a RFC; o Bling usa os escopos
  cadastrados previamente no aplicativo, não enviados na URL.
- **Token:** `POST https://api.bling.com.br/Api/v3/oauth/token`
  - Autenticação: `Authorization: Basic base64(client_id:client_secret)`.
  - `grant_type=authorization_code` + `code`: o código de autorização
    **expira em 1 minuto** — a troca deve ser imediata após o callback, sem
    filas ou retries assíncronos.
  - `grant_type=refresh_token` + `refresh_token`: o refresh token tem
    **validade de 30 dias**.
  - Resposta: `{ access_token, refresh_token, expires_in, token_type }`.
    `expires_in` é validado no ORBITA com `z.number().int().positive().max(2_592_000)`
    (30 dias) em `src/services/blingOAuth.ts`.
  - Erros: `invalid_grant` (code/refresh_token inválido, expirado ou já
    usado) — tratado como falha permanente que exige nova autorização, nunca
    retry automático.
  - Bloqueio de IP: mais de 20 requisições a `/oauth/token` em 60s causa
    bloqueio temporário de 60 minutos — reforça que o refresh nunca deve
    rodar em loop sem lock (ver §5).

## 2. Endpoints de recurso usados pelo ORBITA

Base: `https://api.bling.com.br/Api/v3`. Autenticação: `Authorization: Bearer <access_token>`, `Accept: application/json`, `enable-jwt: 1`.

| Recurso | Endpoints usados |
|---|---|
| Produtos | `GET/POST/PUT/DELETE /produtos`, `GET /produtos/{id}` |
| Categorias de produtos | `GET /categorias/produtos` |
| Contatos | `GET/POST/PUT/DELETE /contatos`, filtro `pesquisa` |
| Pedidos de venda | `GET/POST/PUT/DELETE /pedidos/vendas`, `PATCH /pedidos/vendas/{id}/situacoes/{id}` |
| Estoque | `GET /estoques/saldos`, `POST /estoques`, `GET /depositos` |
| Contas a pagar/receber | `GET/POST /contas/pagar`, `GET /contas/receber` |
| Contas financeiras | `GET /contas-financeiras` |
| NF-e | `POST /nfe` |
| Situações de módulo | `GET /situacoes/modulos` |

O Ticket 10 não expande esse conjunto de recursos (fora de escopo — apenas
OAuth/conexão/credenciais/webhook/sync); o inventário acima documenta o que o
adapter de produção precisa continuar suportando.

## 3. Paginação

Parâmetros de query: `pagina` (1-based) e `limite` (100 é o valor usado pelo
ORBITA; o Bling aceita até um máximo documentado por endpoint — não
excedido pelo código atual). Resposta: `{ data: [...] }`; página vazia
(`data.length === 0`) é o sinal de término. O sync do ORBITA deve avançar
`pagina` e persistir checkpoint somente após a página corrente ser
persistida com sucesso (nunca antes), para que uma falha no meio de uma
página não avance o cursor.

## 4. Rate limit e retry

- Limite documentado: **3 requisições/segundo** e **120.000/dia** por conta.
- Estouro do limite: `HTTP 429`. O Bling não documenta um header
  `Retry-After`; o ORBITA trata sua ausência com um backoff padrão
  (`retryAfterSeconds: 60` em `blingOAuth.ts` quando o header não vem, mais
  backoff exponencial com jitter no cliente de recursos).
- Bloqueio de IP adicional (fora do 429 "normal"): 300 erros em 10s ou 600
  requisições em 10s → bloqueio de 10 minutos. Isso reforça que retries
  devem ser limitados (poucas tentativas, backoff crescente), nunca em loop
  apertado.
- Filtros de período (`dataInicial`/`dataFinal` etc.) maiores que 1 ano
  retornam `400` — erro de contrato permanente, não retryable.
- Erros 4xx (exceto 429) são tratados como permanentes e tipados: erro de
  schema/contrato, não retryable. Erros 429/5xx/falha de rede são
  elegíveis a retry com backoff limitado e jitter.

## 5. Timeout

Chamadas de token (`blingOAuth.ts`) usam `AbortSignal.timeout(10_000)` (10s).
O adapter de recursos deve usar o mesmo padrão (`AbortSignal` com timeout
explícito) em vez de depender do timeout implícito do runtime, retornando um
erro tipado `timeout` distinto de `network`.

## 6. Webhook

- **Header de assinatura:** `X-Bling-Signature-256`, formato
  `sha256=<hex>` — HMAC-SHA256 do corpo bruto (raw body) usando o
  **client secret** da aplicação/conexão. A verificação deve ocorrer sobre o
  raw body (antes de qualquer parse) e usar comparação de tempo constante
  (`timingSafeEqual`) — implementado em `authorizeSignedServiceTenant`
  (`src/lib/auth.ts`).
- **Payload:** `{ eventId, date (ISO 8601), version, event ("recurso.acao",
  ex.: "product.created"), companyId, data }`. O ORBITA **não confia** no
  `companyId` do payload nem em qualquer hint de query string como
  autoridade de tenant — apenas a assinatura HMAC válida contra o segredo
  de uma conexão real determina o tenant candidato; a organização é então
  resolvida a partir de vínculos persistidos e verificados (nunca do
  payload). Ver `src/app/api/bling/webhook/route.ts`.
- **Resposta esperada pelo Bling:** HTTP `2xx` dentro de **5 segundos**.
  Fora dessa janela ou com status não-2xx, o Bling tenta novamente.
- **Retry do Bling:** até **3 dias**, com intervalos crescentes. Depois de
  falhas repetidas, o Bling desabilita o webhook até reativação manual —
  motivo adicional para nunca responder um erro transitório antes de
  persistir o evento no inbox (para não perder o evento quando o Bling
  desistir de re-entregar).
- **Idempotência:** o Bling não garante ordem nem exactly-once — o inbox
  (`inbox_eventos_bling`, `blingInboxService`) registra o evento com uma
  chave de idempotência **antes** de qualquer efeito colateral e cacheia a
  resposta processada, de forma que uma redelivery retorna sucesso/no-op
  sem repetir efeitos.

## 7. Idempotência de sync

Cada execução de sync deve ser seguramente reexecutável: checkpoint por
conexão avança apenas após persistir a página corrente; recursos são
upsertados por `bling_id` escopado à organização/conexão (nunca por
"primeiro usuário" ou tenant global).

## Schema de `POST /pedidos/vendas` (Ticket 30)

Transcrito do OpenAPI oficial e codificado em
`src/lib/integrations/bling/pedidoVendaContract.ts`, que é o único lugar onde
o payload é montado e validado antes do envio.

**Obrigatórios:** `contato`, `data`, `dataPrevista`, `dataSaida`, `itens`,
`parcelas`.

| Campo | Forma | Observação |
|---|---|---|
| `contato` | `{ id: integer }` | `nome` é `readOnly` |
| `data`, `dataPrevista`, `dataSaida` | `format: date` | `AAAA-MM-DD`, não ISO com hora |
| `itens[]` | obrigatórios `quantidade`, `valor`, `valorLista`, `descricao` | `id` é ignorado no POST |
| `itens[].produto` | `{ id: integer }` obrigatório quando presente | a v3 valida o produto por ID; só `codigo` não basta |
| `parcelas[]` | obrigatórios `dataVencimento`, `valor`, `formaPagamento.id` | `formaPagamento.id` vem de `GET /formas-pagamentos`, é **por conta** |
| `desconto` | `{ valor, unidade: REAL \| PERCENTUAL }` | |
| `transporte.fretePorConta` | `0,1,2,3,4,9` | |
| `total`, `totalProdutos` | `readOnly` | o Bling calcula; o valor do cliente não é aceito |
| `situacao` | `{ id, valor }` | ids são **por conta** (`GET /situacoes/modulos/{id}`). O ORBITA **não envia** `situacao`, para não fixar um número que pode não existir na conta |

**Resposta `201`:** apenas `data.id` (mais `alertas[]` e `rastreamento`
opcionais). **Não existe `data.numero`** na criação.

**Resposta de erro:** envelope estruturado
`{ error: { type, message, description, fields: [{ code, msg, element, namespace }] } }`,
com `type` enumerado (`VALIDATION_ERROR`, `MISSING_REQUIRED_FIELD_ERROR`,
`TOO_MANY_REQUESTS`, ...). `parseBlingFailure` o traduz em falha tipada; o
código `3` em `fields[]` é a recusa de venda idêntica à anterior.

## Baixa de estoque de um pedido de venda

Use `POST /pedidos/vendas/{id}/lancar-estoque` — "lança o estoque de um
pedido de venda no depósito padrão", vinculado ao pedido.

`POST /estoques` com `operacao: 'S'` cria um **ajuste manual desvinculado**
do pedido. A venda manual usava esse endpoint *além* de marcar o pedido como
atendido, o que deduz o estoque duas vezes em qualquer conta cuja situação
dispare a baixa. Corrigido no Ticket 30.

## Verificação pendente do proprietário

Se a situação padrão da conta Bling do proprietário já dispara baixa de
estoque automática, a chamada a `lancar-estoque` passa a ser redundante. Isso
só é verificável com acesso à conta real — ver `OWNER_CHECKLIST.md`.

## Escopos exigidos no cadastro do aplicativo (Ticket 30d)

O ORBITA **não envia** `scope` no authorize — a documentação oficial diz que
`redirect_uri` e `scope` "não serão exigidos na requisição" e que "sempre serão
usados os valores inseridos previamente no cadastro de aplicativos". Portanto os
escopos vêm inteiramente do cadastro do aplicativo dentro do Bling.

A documentação define escopo como "a representação da permissão para operar
sobre os recursos do usuário", e avisa que "o aplicativo só terá acesso aos
dados referentes aos escopos selecionados". Trocar escopos **revoga todos os
usuários do aplicativo**, exigindo nova autorização.

Endpoints que o ORBITA realmente chama, extraídos de `src/services/bling.ts`:

| Módulo | Endpoints |
|---|---|
| Produtos | `/produtos`, `/produtos/{id}`, `/categorias/produtos` |
| Contatos | `/contatos`, `/contatos/{id}` |
| Pedidos de venda | `/pedidos/vendas`, `/pedidos/vendas/{id}`, `/pedidos/vendas/{id}/situacoes/{id}`, `/pedidos/vendas/{id}/lancar-estoque` |
| Estoque | `/estoques`, `/estoques/saldos`, `/depositos` |
| Financeiro | `/contas/pagar`, `/contas/receber`, `/contas-financeiras`, `/formas-pagamentos` |
| Fiscal | `/nfe` |
| Configuração | `/situacoes/modulos` |

O cadastro do aplicativo precisa declarar escopos que cubram essa lista, **e** o
usuário do Bling que autoriza precisa ter permissão sobre todos eles. Faltando
qualquer um dos dois lados, o authorize devolve
`error=forbidden` com "O usuário não possui autorização para acessar os recursos
requisitados" — recusa do Bling sobre permissão, não sobre as credenciais.
