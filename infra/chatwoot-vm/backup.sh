#!/usr/bin/env bash
# Backup do Chatwoot da VM (MSG-020B): dump do Postgres e arquivo dos anexos.
# Roda na pasta infra/chatwoot-vm do host. Agendar pelo cron do host, ver o runbook.
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a

destino="${BACKUP_DIR:-/var/backups/chatwoot}"
reter="${BACKUP_RETENTION_DAYS:-7}"
carimbo="$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
mkdir -p "$destino"

# Escreve em .partial e só renomeia no fim: um backup interrompido nunca parece completo.
docker compose exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U postgres -Fc chatwoot' \
  > "$destino/chatwoot-$carimbo.dump.partial"
mv "$destino/chatwoot-$carimbo.dump.partial" "$destino/chatwoot-$carimbo.dump"

docker compose exec -T rails tar czf - -C /app/storage . > "$destino/storage-$carimbo.tar.gz.partial"
mv "$destino/storage-$carimbo.tar.gz.partial" "$destino/storage-$carimbo.tar.gz"

find "$destino" -maxdepth 1 -type f \( -name 'chatwoot-*.dump' -o -name 'storage-*.tar.gz' \) -mtime "+$reter" -delete

if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  rclone copy "$destino" "$BACKUP_RCLONE_REMOTE" --include "*-$carimbo.*"
  echo "backup $carimbo copiado para fora da VM"
else
  echo "backup $carimbo só local: BACKUP_RCLONE_REMOTE vazio, não vale como backup externo" >&2
fi
echo "backup $carimbo ok"
