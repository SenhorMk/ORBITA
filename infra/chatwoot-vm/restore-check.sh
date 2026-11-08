#!/usr/bin/env bash
# Prova de restore (MSG-020B): restaura o dump num Postgres descartável, sem tocar na instância,
# e conta contas, conversas e mensagens. Uso: ./restore-check.sh [arquivo.dump]
set -euo pipefail
cd "$(dirname "$0")"
# CHATWOOT_ENV_FILE: .env fora do repositório (MSG-020C, notebook).
env_file="${CHATWOOT_ENV_FILE:-./.env}"
set -a; . "$env_file"; set +a
compose() { docker compose --env-file "$env_file" "$@"; }

dump="${1:-$(ls -1t "${BACKUP_DIR:-/var/backups/chatwoot}"/chatwoot-*.dump | head -n 1)}"
# RESTORE_CHECK_IMAGE: só para o teste negativo (um Postgres que nunca fica pronto).
imagem="${RESTORE_CHECK_IMAGE:-$(compose config --images | grep pgvector)}"
nome="chatwoot-restore-check-$$"
senha="$(openssl rand -hex 16)"

limite="${RESTORE_CHECK_TIMEOUT_SECONDS:-120}"

# Limpeza registrada antes de criar: sai com sucesso, erro, timeout ou Ctrl+C.
trap 'docker rm -f "$nome" > /dev/null 2>&1 || true' EXIT
trap 'exit 130' INT TERM
docker run -d --rm --name "$nome" -e POSTGRES_PASSWORD="$senha" -e POSTGRES_DB=chatwoot "$imagem" > /dev/null

esperar_postgres() {
  local fim=$((SECONDS + limite))
  until docker exec "$nome" pg_isready -U postgres -d chatwoot > /dev/null 2>&1; do
    if [ "$SECONDS" -ge "$fim" ]; then
      echo "restore-check: o Postgres descartável não ficou pronto em ${limite}s" >&2
      exit 1
    fi
    sleep 1
  done
}

esperar_postgres
# O entrypoint reinicia o Postgres depois da inicialização: esperar a segunda subida.
sleep 3
esperar_postgres

docker exec -i "$nome" pg_restore -U postgres -d chatwoot --no-owner --exit-on-error < "$dump"
docker exec "$nome" psql -U postgres -d chatwoot -At -c \
  "select 'contas=' || (select count(*) from accounts) || ' conversas=' || (select count(*) from conversations) || ' mensagens=' || (select count(*) from messages)"
echo "restore ok: $dump"
