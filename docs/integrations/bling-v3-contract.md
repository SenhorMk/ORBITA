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
| Situações de módulo | `GET /situacoes/modulos` (os **módulos**) e `GET /situacoes/modulos/{idModuloSistema}` (as **situações** de um deles) |

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
- **Origem do segredo:** o `client_secret` da **conexão**, lido do cofre
  (`conexoes_integracao` + `credenciais_integracao`) por
  `src/app/api/bling/webhook/tenants.ts`. Não existe variável de ambiente de
  segredo de webhook: ele é por organização, não por deploy. Até o ticket 11 o
  webhook lia a aposentada `integracoes_bling`, vazia desde o ticket 10b — o
  que fazia **todo** evento legítimo receber `403`.
- **Exclusão de pedido:** um evento de exclusão (`order.deleted` e variantes)
  marca o pedido local como `Cancelado`; **nunca** o apaga (decisão do
  proprietário, 31/08). Se o pedido não existe localmente, o evento é
  registrado e concluído sem erro. Antes do ticket 11 não havia esse ramo:
  `order.deleted` caía no caminho de atualização, pedia ao Bling um pedido já
  apagado e retornava em silêncio.
- **Resposta esperada pelo Bling:** HTTP `2xx` dentro de **5 segundos**.
  Fora dessa janela ou com status não-2xx, o Bling tenta novamente.
- **Retry do Bling:** até **3 dias**, com intervalos crescentes. Depois de
  falhas repetidas, o Bling desabilita o webhook até reativação manual —
  motivo adicional para nunca responder um erro transitório antes de
  persistir o evento no inbox (para não perder o evento quando o Bling
  desistir de re-entregar).
- **Recuperação de evento que falhou (ticket 11b):** se qualquer evento do lote
  falhar, a rota responde **503** — nunca 2xx. O evento fica `failed` no inbox
  e a **nova tentativa do Bling é o replay**: `registrar_evento_inbox_bling`
  devolve o evento como duplicado com status `failed`, e só `processed` é
  curto-circuitado, então ele é reprocessado. Os eventos do mesmo lote que já
  tinham dado certo voltam como `processed` e não repetem efeito.
  `blingInboxService.prepareReplay` continua existindo para replay **manual**;
  não há (nem é preciso) consumidor automático.
- **Assinatura que não pôde ser conferida:** quando nenhuma conexão casa **e**
  o cofre falhou para pelo menos uma delas, a resposta é **503**, não 403 —
  não sabemos se a assinatura é válida. Uma conexão saudável continua
  autenticando normalmente mesmo com outra em falha.
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

## 8. Guarda de payload de escrita, e o que ela não alcança

`src/services/bling-payload-escrita.test.ts` confere o corpo **capturado do
fio** contra `docs/integrations/bling-v3-schemas.json`. Reprova campo
inexistente, `readOnly` enviado, tipo divergente, `null` não declarado, elemento
de lista inválido e obrigatório de envio ausente.

**Obrigatórios:** `readOnly` sai da lista de envio por leitura do OpenAPI — uma
propriedade `readOnly` marcada `required` obriga na resposta e não deve ser
enviada. É o caso de `id` em `POST /contatos`. O que sobra é cobrado, inclusive
em objeto aninhado, e as exceções são por operação e por campo, com evidência.

### Limitação conhecida: `valorLista`

O spec do Bling é internamente inconsistente em `VendasItemDTO`: lista
`valorLista` em `required` e **não o declara** em `properties`.

O campo é real — o contrato do ORBITA o envia (`pedidoVendaContract.ts`) e o
pedido `26735988980` foi criado com ele na conta real. Por isso a guarda **não**
o trata como campo inventado.

Mas há um buraco, e ele é conhecido: **o tipo de `valorLista` não é conferido**,
porque o spec não diz qual é. Um `valorLista: "dez"` passaria pela guarda.

Fechar isso exigiria o Bling corrigir o spec, ou declararmos o tipo por conta
própria — que seria adivinhação com cara de contrato. Enquanto isso, quem
protege esse campo é o Zod de `pedidoVendaContract.ts`, que o exige
`z.number().nonnegative()`.

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


## Situações: dois recursos, não um (corrigido no Ticket 31)

Conferido em 2026-09-02 contra o OpenAPI oficial
(`https://developer.bling.com.br/build/assets/openapi-BvBfsn8J.json`, o mesmo
documento que o portal `developer.bling.com.br/referencia` carrega).

| Rota | Devolve | Schemas oficiais |
|---|---|---|
| `GET /situacoes/modulos` | os **módulos**: `{ id, nome, descricao, criarSituacoes }` | `SituacoesModuloBaseDTO` + `SituacoesModuloDTO` |
| `GET /situacoes/modulos/{idModuloSistema}` | as **situações** daquele módulo: `{ id, nome, idHerdado?, cor? }` | `SituacoesDTO` + `SituacoesDadosDTO` |

**A lista de módulos não carrega as situações dentro de si.** O adapter
procurava um campo `situacoes` na resposta da primeira rota, não achava, e
devolvia `[]` em **qualquer** conta — o que fazia a compensação da venda manual
e o botão de cancelar pedido concluírem que a conta não tinha a situação
"Cancelado". Divergência viva entre 30/08 e 02/09/2026.

**Os ids de módulo são por conta.** `idModuloSistema` é `integer` com exemplo
`12345678` no spec. O `9` que estava fixo no código era o exemplo de
`SituacoesDTO.id` — id de *situação*, de outro schema. O módulo de pedidos de
venda é descoberto pelo rótulo, que o spec exemplifica como `nome: "Vendas"`,
`descricao: "Pedidos de Venda"`.

**Resposta `201`:** apenas `data.id` (mais `alertas[]` e `rastreamento`
opcionais). **Não existe `data.numero`** na criação.

**Resposta de erro:** envelope estruturado
`{ error: { type, message, description, fields: [{ code, msg, element, namespace }] } }`,
com `type` enumerado (`VALIDATION_ERROR`, `MISSING_REQUIRED_FIELD_ERROR`,
`TOO_MANY_REQUESTS`, ...). `parseBlingFailure` o traduz em falha tipada; o
código `3` em `fields[]` é a recusa de venda idêntica à anterior.

## Achar um pedido pela referência local (`numeroLoja`) — Ticket 30, 5ª rodada

`GET /pedidos/vendas` aceita **`numerosLojas[]`** como filtro de query —
descrito no OpenAPI oficial como "Conjunto de números de pedidos nas lojas".
É o que torna possível reconciliar uma venda manual **sem ter o `bling_id`**:
quando a criação perde o ACK, o ORBITA não sabe o id do pedido, mas sabe a
`referenciaLocal`, porque ela é decidida antes do envio e viaja em
`numeroLoja`.

Parâmetros de query de `GET /pedidos/vendas`, conferidos no OpenAPI publicado
em 2026-09-03:

| Parâmetro | Tipo | Descrição no spec |
|---|---|---|
| `pagina`, `limite` | integer | paginação padrão |
| `idContato` | integer | ID do contato |
| `idsSituacoes[]` | array | Conjunto de situações |
| `dataInicial`, `dataFinal` | string | faixa de data |
| `dataAlteracaoInicial`, `dataAlteracaoFinal` | string | faixa de alteração |
| `dataPrevistaInicial`, `dataPrevistaFinal` | string | faixa prevista |
| `numero` | integer | Número do pedido de venda |
| `idLoja` | integer | ID da loja |
| `idVendedor` | integer | ID do vendedor |
| `idControleCaixa` | integer | ID do controle de caixa |
| **`numerosLojas[]`** | **array** | **Conjunto de números de pedidos nas lojas** |
| `idUnidadeNegocio` | integer | ID da unidade de negócio (filial) |

A resposta `200` devolve `data[]` de `VendasDadosBaseDTO`, que inclui `id`
(readOnly) e `numeroLoja` — os dois campos de que a reconciliação precisa.

**O filtro não é a prova.** `buscarPedidoVendaPorNumeroLoja`
(`src/services/bling.ts`) confere a igualdade de `numeroLoja` no resultado
antes de aceitar qualquer linha: um filtro que faça correspondência parcial,
ou que o provedor passe a ignorar numa versão futura, devolveria pedidos de
outras vendas — e concluir uma tentativa com o pedido errado é pior do que não
concluir nenhuma.

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
| Configuração | `/situacoes/modulos`, `/situacoes/modulos/{idModuloSistema}` |

O cadastro do aplicativo precisa declarar escopos que cubram essa lista, **e** o
usuário do Bling que autoriza precisa ter permissão sobre todos eles. Faltando
qualquer um dos dois lados, o authorize devolve
`error=forbidden` com "O usuário não possui autorização para acessar os recursos
requisitados" — recusa do Bling sobre permissão, não sobre as credenciais.

## Schema de `POST`/`PUT /produtos` (Ticket 31)

Codificado em `src/lib/config/produtoContract.ts` e no builder
`corpoProdutoBling` de `src/services/bling.ts`.

**Obrigatórios:** `nome`, `tipo`, `situacao`, `formato`.

| Campo | Valores | Observação |
|---|---|---|
| `tipo` | `S` Serviço, `P` Produto, `N` Serviço 06 21 22 | |
| `situacao` | `A` Ativo, `I` Inativo | |
| `formato` | `S` Simples, `V` Com variações, `E` Com composição | |
| `codigo` | string | **Opcional.** O ORBITA não envia quando o usuário não informa — nada de SKU inventado |
| `estoque` | **objeto** (`minimo`, `maximo`, `crossdocking`, `localizacao`) | `saldoVirtualTotal` é `readOnly`: **o saldo não entra no payload do produto**. Use `POST /estoques` |

### Filtro por SKU em `GET /produtos`

O parâmetro documentado é **`codigos[]`** (array). **Não existe `codigo`.**

Enviar `codigo` fazia o Bling ignorar o filtro e devolver a listagem normal.
O código tratava o primeiro item como "este produto já existe" e disparava um
`PUT` sobrescrevendo nome, código e preço de um **produto não relacionado**,
seguido de um lançamento de saldo absoluto nele. Corrigido no Ticket 31, com
`buscarProdutoPorCodigo` conferindo o `codigo` do resultado antes de confiar —
um filtro ignorado pelo provedor nunca mais pode virar escrita destrutiva.

## Schema de `POST`/`PUT /contatos` (Ticket 32)

Codificado em `src/lib/config/clienteContract.ts` e no builder
`corpoContatoBling` de `src/services/bling.ts`.

**Obrigatórios:** `nome`, `situacao`, `tipo`.

| Campo | Valores | Observação |
|---|---|---|
| `tipo` | `J` Jurídica, `F` Física, `E` Estrangeira | |
| `situacao` | `A` Ativo, `E` Excluído, `I` Inativo, `S` Sem movimentação | |
| `numeroDocumento` | string | CPF (11 dígitos) ou CNPJ (14) |
| `telefone` | string | **Não é `fone`** — ver abaixo |
| `indicadorIe` | `1` Contribuinte ICMS, `2` Isento, `9` Não contribuinte | **Não é `contribuinte`** — ver abaixo |
| `endereco` | `{ geral: { endereco, cep, bairro, municipio, uf, numero, complemento }, cobranca: {...} }` | aninhado sob `geral`; já estava correto |

### Dois campos que não existem no schema

O código anterior enviava:

- **`fone`** para o telefone. O campo é **`telefone`**. Um comentário no fonte
  chegava a afirmar "Campo correto: `fone`".
- **`contribuinte`** para o indicador de ICMS. O campo é **`indicadorIe`**.

Nenhum dos dois existe em `POST /contatos`. O Bling descartava os valores em
silêncio: o contato era criado sem telefone e sem indicador de inscrição
estadual, e nada no ORBITA acusava. Corrigido no Ticket 32.

## Schema de `POST /contas/pagar` (Ticket 33)

Codificado em `criarContaPagar` de `src/services/bling.ts`.

**Obrigatórios:** `contato.id`, `vencimento` (`format: date`), `valor` (`float`).

| Campo | Forma | Observação |
|---|---|---|
| `contato` | `{ id: integer }` | |
| `vencimento`, `dataEmissao`, `competencia` | `format: date` | `AAAA-MM-DD` |
| `valor` | `number/float` | |
| `categoria`, `portador`, `formaPagamento` | `{ id: integer }` | ids **por conta** |
| `situacao` | `1` Aberto … `7` Confirmado | **`readOnly`** — ver abaixo |

### `situacao` é readOnly: quitar exige endpoint próprio

O ORBITA enviava `situacao: 2` para marcar a despesa como paga na criação. O
campo é `readOnly` no schema oficial, então o Bling **descartava o valor**: a
conta era criada em aberto no ERP enquanto o ORBITA gravava `'pago'`.

Quitar é `POST /contas/pagar/{id}/baixar`, que exige `categoria.id`, `data`,
`historico`, `portador.id` e `usarDataVencimento`.

### Sem idempotência no Bling: a intenção nasce antes do POST (PRE-001)

O OpenAPI oficial (conferido em 08/10/2026, `openapi-Dw6cY8yQ.json`) não tem
cabeçalho nem campo de idempotência em `POST /contas/pagar`, e
`GET /contas/pagar` não filtra por `numeroDocumento`. Repetir o POST cria uma
segunda conta. Por isso:

- o navegador gera `chaveIdempotencia` (UUID) antes da rede e a guarda no
  `sessionStorage` (organização + SHA-256 do conteúdo → UUID, sem o conteúdo),
  para reenviar a MESMA chave depois de reload; só a esquece diante de um
  desfecho definitivo. No modo contábil a chave é obrigatória: sem ela a rota
  recusa (`400`) antes de qualquer efeito, e o servidor nunca gera uma. A rota a
  devolve como `operacao.ref`;
- antes do POST, `reivindicar_tentativa_conta_pagar` (migration 73) grava a
  intenção em `tentativas_conta_pagar`, por organização, com o SHA-256 do pedido;
- mesma chave + mesmo digest devolve o estado gravado sem reenviar; mesma chave
  + outro digest é `409`; outra chave para um lançamento idêntico ainda pendente
  aponta a pendência (`202`);
- `criarContaPagar` só devolve `NaoEnviado` quando a credencial falhou antes de
  qualquer requisição. Prazo, rede, `5xx`, `429`, `2xx` sem id e qualquer falha
  sem reconhecimento positivo de recusa viram `indeterminada` (`202`, "não
  confirmado"), que não reabre nem reenvia. Recusa definitiva exige `error.type`
  de recusa da requisição **e** status `4xx` (`classificarFalhaDeCriacaoNoBling`);
- a quitação só roda na requisição que confirmou a criação, nunca numa repetição.
- nenhuma resposta pública carrega `failure.message`: `parseBlingFailure` a monta
  com `description`, `fields` ou o corpo cru do provedor. As frases saem de
  `mensagemPublicaDaFalhaDoBling` (status + categoria do `type`, vocabulário
  fechado).

### Reconciliação: sair de `indeterminada` só com prova (PRE-002)

Contrato oficial usado (`openapi-Dw6cY8yQ.json`, conferido em 09/10/2026):

| Operação | O que o contrato oferece | Uso |
|---|---|---|
| `POST /contas/pagar` | `numeroDocumento` (string, "controle interno da empresa"), sem tamanho máximo declarado | recebe a referência opaca `ORB-` + 16 hex, derivada da chave da operação |
| `GET /contas/pagar` | filtros `dataEmissaoInicial/Final`, `dataVencimentoInicial/Final`, `idContato`, `situacao`, `pagina`, `limite`; item com `id`, `situacao`, `valor`, `vencimento`, `contato.id` | estreita os candidatos — **não filtra nem devolve `numeroDocumento`** |
| `GET /contas/pagar/{id}` | `numeroDocumento`, `dataEmissao`, `saldo`, `borderos`, `historico`, `categoria` | prova (ou não) cada candidato |
| `POST /contas/pagar/{id}/baixar` | `200 { bordero: { id } }`; sem idempotência; aceita `historico` | intenção de baixa antes do POST; o histórico leva `[ORBQ-` + 16 hex da intenção`]` |
| `GET /borderos/{id}` | `id`, `data`, `historico`, `portador`, `categoria`, `pagamentos` | prova de AUTORIA da baixa |

O que é prova:

- **criação**: exatamente uma conta, entre as listadas com o mesmo valor,
  vencimento, emissão e contato, traz a referência da tentativa em
  `numeroDocumento` e os campos batem na leitura por id. Tentativas anteriores à
  migration 74 não têm referência: para elas nada é prova, e o resultado é
  revisão manual;
- **baixa**, em duas metades: (1) a leitura por id da própria conta mostra
  `situacao = 2` (Pago), `saldo` INFORMADO e zero, e de 1 a 10 borderôs; (2)
  exatamente um desses borderôs traz no `historico` a referência `ORBQ-` da
  intenção de baixa e tem a `data` dela. Conta paga não basta: um pagamento
  lançado por terceiro na mesma conta deixa a conta paga sem que a baixa do
  ORBITA tenha acontecido (`quitada_sem_autoria`). Saldo ausente, borderô
  ausente, borderôs demais ou mais de um borderô com a referência também são
  revisão manual.

A referência da baixa só existe nas baixas enviadas a partir desta versão. Uma
baixa anterior sem desfecho não tem como ser provada: fica em revisão manual.

Uma operação confirmada no Bling com a projeção local incompleta (título não
gravado ou não vinculado; título não marcado pago depois da baixa confirmada) é
reparada pela própria conferência, que só LÊ a conta por id e grava o título por
upsert da conta remota — chamar de novo não cria outro título. A resposta diz
`projecaoLocal: 'pendente'` enquanto o reparo não fechar, e a operação continua
listada.

A quitação pedida no lançamento (`pago: true`) é gravada com a intenção
(`quitacao_solicitada`, imutável) antes do POST de criação. Se a criação só se
confirma depois (ACK perdido), a conferência NÃO quita sozinha: a operação fica
com a pendência `quitacao_solicitada`, e quitar é uma ação explícita do operador
(`POST /api/financeiro/operacoes/{ref}/quitacao`), que lê a conta antes (já paga
ou não aberta → nada é enviado) e passa pela intenção durável de baixa.

A confirmação manual (`POST .../{ref}/confirmacao-manual`, corpo
`{ blingContaId }`) é a saída auditável de uma criação em revisão manual: o
servidor lê a conta apontada por id e só aceita se valor, vencimento, emissão e
contato baterem e se ela não tiver a referência de outra operação. Com a
referência desta operação em `numeroDocumento`, é evidência (`confirmacao_manual`).
Sem ela, coincidência de campos não prova nada: só a declaração explícita do
operador (`declaracaoDoOperador: true`) vincula, e o recibo grava o ator e o
método `declaracao_do_operador`, distinto de prova. Uma conta remota já ligada a
outra operação da organização nunca é confirmada para uma segunda
(`conta_de_outra_operacao`, índice único `uq_tentativas_conta_pagar_conta_remota`
e trava consultiva por conta na função de registro).

Pagamento confirmado ≠ autoria: `Pago` com saldo INFORMADO e zero confirma que
a conta foi paga; só o borderô com a referência `ORBQ-` atribui a baixa ao
ORBITA. Sem saldo zerado, nenhum caminho marca o título como pago (nem a
quitação explícita, nem o reparo do título, nem a conferência de uma quitação
recusada).

Todo o resto é `revisao_manual`, com recibo: busca vazia, candidatos múltiplos,
candidato divergente, listagem incompleta (teto de 5 páginas de 100), timeout,
`429`, `5xx`, corpo inválido, conta que some entre leituras, conta aberta ou
parcial. Nenhum desfecho da reconciliação autoriza um novo POST: o serviço só
recebe a porta de leitura do Bling.

A migration 74 impõe isso no banco: `indeterminada → confirmada` (criação e
baixa) só com recibo `confirmada` da mesma conta remota na mesma transação; não
existe `indeterminada → nao_enviada`, `recusada` ou `em_voo`. Recibos são
append-only. Ver `docs/operations/reconciliacao-financeira.md`.

### O portador vem de `GET /contas-contabeis`

O endpoint que lista contas financeiras chama-se **`/contas-contabeis`** — seu
próprio título no OpenAPI é *"Obtém contas financeiras"*. **`/contas-financeiras`
não existe na API**; chamá-lo devolvia 404, que o código transformava em lista
vazia e fazia parecer que a conta do proprietário não tinha portador nenhum.

Cada item traz `{ id, descricao, tipo }`, e `tipo: 'caixa'` é o "portador caixa
sem integração" que toda conta Bling tem por padrão. O ORBITA prefere esse —
por isso a quitação funciona **sem o proprietário precisar configurar nada
dentro do Bling**.

### Guarda contra caminho inexistente

`docs/integrations/bling-v3-paths.json` guarda os 162 caminhos do OpenAPI
oficial, e `src/services/bling-endpoints.test.ts` recusa qualquer caminho que
`src/services/bling.ts` monte e que não esteja lá. O Bling responde sem
reclamar do que não conhece, então um caminho inventado só apareceria em
produção, sem mensagem.

Desde o Ticket 33 a situação gravada localmente é a **real do ERP**: se a
quitação não acontece, o título fica aberto nos dois lados e a UI recebe um
aviso dizendo por quê.
