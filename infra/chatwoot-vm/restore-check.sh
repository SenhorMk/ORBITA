#!/usr/bin/env bash
# Prova de restore (MSG-020B): restaura o dump num Postgres descartável, sem tocar na instância,
# e conta contas, conversas e mensagens. Uso: ./restore-check.sh [arquivo.dump]
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a

dump="${1:-$(ls -1t "${BACKUP_DIR:-/var/backups/chatwoot}"/chatwoot-*.dump | head -n 1)}"
imagem="$(docker compose config --images | grep pgvector)"
nome="chatwoot-restore-check-$$"
senha="$(openssl rand -hex 16)"

docker run -d --rm --name "$nome" -e POSTGRES_PASSWORD="$senha" -e POSTGRES_DB=chatwoot "$imagem" > /dev/null
trap 'docker rm -f "$nome" > /dev/null 2>&1 || true' EXIT
until docker exec "$nome" pg_isready -U postgres -d chatwoot > /dev/null 2>&1; do sleep 1; done
# O entrypoint reinicia o Postgres depois da inicialização: esperar a segunda subida.
sleep 3
until docker exec "$nome" pg_isready -U postgres -d chatwoot > /dev/null 2>&1; do sleep 1; done

docker exec -i "$nome" pg_restore -U postgres -d chatwoot --no-owner --exit-on-error < "$dump"
docker exec "$nome" psql -U postgres -d chatwoot -At -c \
  "select 'contas=' || (select count(*) from accounts) || ' conversas=' || (select count(*) from conversations) || ' mensagens=' || (select count(*) from messages)"
echo "restore ok: $dump"
