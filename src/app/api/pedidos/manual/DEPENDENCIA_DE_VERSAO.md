# A fronteira `Definitiva` × `Ambigua` depende do `@supabase/postgrest-js` instalado

`classificarErroDePersistencia` (`classificacaoDeFalha.ts`) decide se uma
falha de `persistVenda` pode disparar compensação **destrutiva** (cancelar
um pedido no Bling). A premissa por trás dela:

> Um erro de transporte (timeout, conexão perdida, abort) nunca vem com um
> `code` que bate a allowlist de SQLSTATE conhecidos (`23505`, `22023`,
> `P0002`, `23514`, `23503`) ou `/^PGRST\d+$/` — só um erro que o servidor
> processou até o fim e respondeu de verdade vem assim.
>
> **4ª rodada de revisão:** a versão original reconhecia qualquer `code` que
> tivesse o FORMATO de um SQLSTATE (`/^[0-9A-Z]{5}$/`), não um código
> específico. A revisão apontou que isso não é prova de proveniência — um
> valor como `'ERROR'` bate o formato sem ser um SQLSTATE de verdade. A
> allowlist fecha isso: só os códigos que as migrations 53/56/57/59
> realmente levantam (mais `23503`, da mesma família de integridade) contam
> como definitivos.

Essa premissa foi **lida do código-fonte instalado**, não deduzida:
`node_modules/@supabase/postgrest-js/dist/index.mjs`, versão travada em
`package-lock.json` na data abaixo.

- Falha de `fetch` (linhas ~396-433): o objeto de erro sintético começa com
  `let code = ""` e nenhum ramo (`AbortError`, `HeadersOverflowError`, o
  `else` genérico) o preenche com outra coisa.
- Resposta HTTP não-2xx (linha ~489): `error = JSON.parse(body)`, onde
  `body` só existe porque o servidor respondeu — e o corpo de um erro
  PostgREST/PostgreSQL real sempre carrega `code` no formato SQLSTATE ou
  `PGRSTxxxx`.

**Isso pode mudar numa atualização de `@supabase/supabase-js` ou
`@supabase/postgrest-js`, sem aviso nenhum no changelog delas sobre este
detalhe.** A política em `classificacaoDeFalha.ts` já é defensiva quanto a
isso — reconhece por PADRÃO POSITIVO, não por exclusão, então um `code` de
rede genérico (`ECONNRESET`, `ETIMEDOUT`) continua caindo em `Ambigua` mesmo
que a biblioteca passe a preenchê-lo. Mas a defesa não é infinita: se uma
versão nova passar a devolver um `code` que **bate** o padrão SQLSTATE para
uma falha que na verdade é de transporte, a classificação erraria.

## Checklist ao atualizar `@supabase/supabase-js` ou `@supabase/postgrest-js`

1. Reler o trecho de tratamento de erro do `PostgrestBuilder` na versão nova
   (`node_modules/@supabase/postgrest-js/dist/index.mjs`, procurar por
   `res.catch` e `JSON.parse(body)`).
2. Confirmar que falha de `fetch` continua sem preencher `code` com um dos
   valores da allowlist (`23505`, `22023`, `P0002`, `23514`, `23503`) ou com
   algo que bata `/^PGRST\d+$/`.
3. Rodar `src/app/api/pedidos/manual/classificacaoDeFalha.test.ts` — ele
   fixa o comportamento esperado com exemplos concretos, não com a leitura do
   código-fonte. Se ele continuar verde, a fronteira continua válida.
4. Se a premissa quebrou, ajustar `classificacaoDeFalha.ts` antes de
   atualizar a dependência — nunca depois.

## Versão conferida

- `@supabase/supabase-js`: `2.112.3`.
- `@supabase/postgrest-js`: `2.112.3`.
- Conferido em: 2026-09-03, lendo `node_modules/@supabase/postgrest-js/dist/index.mjs` diretamente.
