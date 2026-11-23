# Runtime do atendimento Haux: como reconstruir o que roda no notebook

Este documento registra a origem exata de cada container da mensageria do Portal do Haux, para que o ambiente possa ser reconstruído a partir do repositório. Nenhum segredo aparece aqui: os arquivos de ambiente ficam em `C:\Users\<usuário>\orbita-infra\protegido\` (fora do Git e do OneDrive) e só os **nomes** das variáveis estão nos `*.env.example`.

## Banco (staging `etqjqeqqbjrzyyxodntv`)
O ledger `public.migracoes_aplicadas` vai até a ordem **104**:

| Ordem | Arquivo | sha256 |
|---|---|---|
| 100 | `database/97_bootstrap_ai_first.sql` | `855799dc…` |
| 101 | `database/98_ai_first_worker.sql` | `cc46b969…` |
| 102 | `database/99_haux_bot_limits.sql` | `a74752d8…` |
| 103 | `database/100_runtime_ai_por_inbox.sql` | `f55719dd…` |
| 104 | `database/101_lista_conversas_teste.sql` | `ec9d4361…` |

As ordens 103 e 104 já estão aplicadas: **não reaplicar**. `database/migrations.lock.json` e o ledger têm os mesmos hashes, e `scripts/check-database-drift.test.ts` confere 105 arquivos e 104 migrations registradas.

## Workers de inbox e de envio
- **Imagem:** `orbita-haux-bot:2b069b995d32c1c1e4b7f1a0d9267f60c24c2a31`, construída do commit `2b069b9` (já na `main`) com `infra/worker/Dockerfile`.
- **Compose:** `infra/worker/docker-compose.yml` mais o overlay `infra/worker/workers.haux-runtime.yml`, com projeto `orbita-workers-g8`.
- **Arquivos de ambiente:**
  - `WORKER_ENV_FILE` = `protegido/workers.haux-runtime.env`;
  - `WORKER_ENVIO_ENV_FILE` = o arquivo do envio, que contém a `ENCRYPTION_KEY` do staging.

```bash
docker build -f infra/worker/Dockerfile -t orbita-haux-bot:2b069b995d32c1c1e4b7f1a0d9267f60c24c2a31 .   # no checkout de 2b069b9
docker compose -p orbita-workers-g8 -f infra/worker/docker-compose.yml -f infra/worker/workers.haux-runtime.yml up -d inbox envio
```

## Bot (IA)
- **Compose:** `infra/worker/haux-bot.compose.yml`, com projeto `orbita-haux-bot` e `HAUX_BOT_IMAGE_TAG` e `HAUX_BOT_ENV_FILE` definidos em `protegido/evolution/bot.compose.env`.
- **Arquivo de ambiente:** `protegido/evolution/haux-bot.whatsapp.runtime.env`, com `HAUX_BOT_INBOXES=1,2` e `HAUX_BOT_LIMITE_TRIAGENS_DIA=50` desde 23/11/2026.
- **Imagem até 22/11:** `orbita-haux-bot:wa-inboxes-f55719dd`, construída deste estado do repositório (`main` mais esta regularização).
- **Ao trocar a imagem:** o SIGTERM do container antigo chama `desligar_runtime_ai_first`, que põe `ativo=false` nas inboxes, e a IA para de responder. Reativar exige o DML autorizado no runbook (`UPDATE chatwoot_ai_runtime SET ativo=true … inbox_id IN (1,2)`). É uma trava de segurança: não é falha.

```bash
HAUX_BOT_IMAGE_TAG=<tag> docker compose -p orbita-haux-bot -f infra/worker/haux-bot.compose.yml \
  --env-file <protegido>/evolution/bot.compose.env up -d --no-deps bot
```

## Evolution API (WhatsApp)
`infra/evolution/compose.yml` com `compose.env.example`. O README da pasta tem os detalhes.
