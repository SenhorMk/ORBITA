# Chatwoot CE de desenvolvimento (MSG-001)

Ambiente local e descartável para provar o contrato com o Chatwoot real. Só dados
sintéticos. Nenhum segredo, token ou dado de produção entra aqui, e ele não é uma
implantação: nada disto vale como autorização para tráfego real (MSG-021).

## 1. O que está fixado

| Componente | Versão | Digest |
|---|---|---|
| `chatwoot/chatwoot` | v4.19.1 | `sha256:a0d571a3a2f78f4fa4b1d7c21a53309c0184068d6021b3664ab37788faef04c1` |
| `pgvector/pgvector` | pg16 | `sha256:0dd3149a06e4579a0d70d8fef9945636cd514005e7237deb27f9b67886f8dc4f` |
| `redis` | 7-alpine | `sha256:8da19c7399dca900c6822a1cf30f9d2285585e2c4b457ff4095b0f4500054d3f` |

Subir de versão: trocar a tag e o digest em `infra/chatwoot-dev/docker-compose.yml`
e `VERSAO_FIXADA` em `scripts/chatwoot-dev.mjs`, rodar `npm run test:chatwoot` e
recapturar `src/services/chatwoot/__fixtures__/chatwoot-v4.19.1-webhooks.json`. Outra
versão só vale depois disso, porque o formato do payload não é versionado pelo
provedor.

## 2. Provar

```bash
npm run test:chatwoot
```

Exige Docker. Fica fora do `npm test` e do CI, e leva cerca de 5 minutos. Sobe o
Chatwoot do zero num projeto próprio (`orbita-chatwoot-prova`), com segredos gerados
na hora e só em memória, e apaga tudo ao terminar. Não toca os volumes do ambiente
de desenvolvimento.

A jornada: Chatwoot real → webhook por rede → rota real → PostgREST e Postgres reais →
worker → leitura do operador. Dublê só da sessão do operador, porque o laboratório não
tem GoTrue.

## 3. Usar no dia a dia

```bash
cp infra/chatwoot-dev/.env.example infra/chatwoot-dev/.env
```

Preencha o `.env` com valores próprios (`openssl rand -hex 32`). Ele fica fora do Git.

```bash
docker compose -f infra/chatwoot-dev/docker-compose.yml --env-file infra/chatwoot-dev/.env run --rm --no-deps rails bundle exec rails db:chatwoot_prepare
```

```bash
docker compose -f infra/chatwoot-dev/docker-compose.yml --env-file infra/chatwoot-dev/.env up -d
```

A interface fica em `http://127.0.0.1:3100`. Postgres e Redis não publicam porta.

**Webhook para a própria máquina:** use o IPv4 do host visto de dentro do container
(`docker compose ... exec sidekiq getent ahostsv4 host.docker.internal`), não o nome.
O Docker Desktop anuncia também um IPv6 sem rota, e a entrega falha de forma
intermitente com `Network unreachable`. `SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true` existe
só neste compose; sem ele, o Chatwoot recusa destino de rede privada.

**Túnel:** um Quick Tunnel expõe só o webhook e tem URL efêmera. Ao trocar a URL, atualize
o webhook pela API (`PATCH /webhooks/{id}`); o segredo não muda. A prova cobre a troca
de URL por porta local. Túnel de verdade não foi exercitado.

## 4. Backup e restore

```bash
docker compose -f infra/chatwoot-dev/docker-compose.yml --env-file infra/chatwoot-dev/.env exec -T postgres pg_dump -U postgres -Fc chatwoot > chatwoot-dev.dump
```

Para restaurar: pare `rails` e `sidekiq`, remova o container e o volume do Postgres,
suba só o `postgres` e rode:

```bash
docker compose -f infra/chatwoot-dev/docker-compose.yml --env-file infra/chatwoot-dev/.env exec -T postgres pg_restore -U postgres -d chatwoot --no-owner --exit-on-error < chatwoot-dev.dump
```

Depois suba `rails` e `sidekiq`. A prova executa exatamente esta sequência. O dump não
leva anexos (volume `storage`) nem a fila do Redis: o que estava na fila se perde. O
`SECRET_KEY_BASE` precisa ser o mesmo de antes.

## 5. Parar

```bash
docker compose -f infra/chatwoot-dev/docker-compose.yml --env-file infra/chatwoot-dev/.env stop
```

`stop` preserva os volumes. `down -v` os apaga. Ao encerrar um laboratório, revogue o
token do agente e o túnel.

## 6. Issue #13809

Na v4.19.1 self-hosted, **o segredo devolvido por `POST /webhooks` é o que assina as
entregas**: a prova confere o HMAC real com ele. A issue segue aberta no provedor e
foi relatada em `app.chatwoot.com`, então isto não vale para o Chatwoot Cloud nem para
outra versão. Se o segredo divergir, a entrega é recusada com 401 e nada é gravado. A
ORBITA não tem caminho sem assinatura.

## 7. Não verificado aqui

- Canal real (WhatsApp/Meta): a entrada usa a API pública de um inbox do tipo API.
- Mensagem com anexo: `content: null` está coberto por teste de schema, não por entrega real.
- Túnel real, Chatwoot Cloud e carga.
