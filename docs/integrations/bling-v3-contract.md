# Contrato Bling API v3 — congelado para o Ticket 10

Este documento descreve o contrato Bling v3 realmente consumido pelo ORBITA:
endpoints, OAuth, paginação, schemas de payload usados, códigos/erros,
rate-limit/retry, timeout e idempotência. Consolidado a partir da
documentação oficial (`developer.bling.com.br`, consultada em 2026-08-27 via
WebFetch) e do código já existente em `src/services/bling.ts`,
`src/services/blingOAuth.ts`, `src/app/api/bling/*`.

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

## Limitação conhecida desta consulta

A consulta à documentação oficial foi feita via WebFetch (HTML convertido e
resumido por um modelo auxiliar) em vez de acesso direto ao portal
interativo de referência (`developer.bling.com.br/referencia`), que exige
sessão autenticada para exploração completa de schemas por endpoint. Os
schemas de payload específicos de cada recurso (produtos, contatos,
pedidos) já em uso no ORBITA foram conferidos contra o código existente
(comentários em `src/services/bling.ts`), não recolhidos novamente nesta
passagem — sem mudança de escopo de recursos neste ticket.
