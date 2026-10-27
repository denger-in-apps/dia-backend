#!/bin/sh
set -eu
umask 077

: "${POSTGRES_HOST:?POSTGRES_HOST is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is required}"

interval=${BACKUP_INTERVAL_SECONDS:-86400}
retry_interval=${BACKUP_RETRY_SECONDS:-300}
retention=${BACKUP_RETENTION_DAYS:-14}
case "$interval" in ''|*[!0-9]*|0) echo "BACKUP_INTERVAL_SECONDS must be a positive integer" >&2; exit 1 ;; esac
case "$retry_interval" in ''|*[!0-9]*|0) echo "BACKUP_RETRY_SECONDS must be a positive integer" >&2; exit 1 ;; esac
case "$retention" in ''|*[!0-9]*|0) echo "BACKUP_RETENTION_DAYS must be a positive integer" >&2; exit 1 ;; esac

mkdir -p /backups
dump=
encrypted_tmp=
cleanup_tmp() {
  [ -z "${dump:-}" ] || rm -f "$dump"
  [ -z "${encrypted_tmp:-}" ] || rm -f "$encrypted_tmp"
}
trap cleanup_tmp EXIT
trap 'exit 1' HUP INT TERM

create_backup() {
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  dump="/tmp/.denger-${stamp}.dump"
  encrypted_tmp="/backups/.denger-${stamp}.dump.age.tmp"
  encrypted="/backups/denger-${stamp}.dump.age"
  if ! pg_dump \
    --host="$POSTGRES_HOST" \
    --username="$POSTGRES_USER" \
    --dbname="$POSTGRES_DB" \
    --format=custom \
    --no-owner \
    --file="$dump"; then
    cleanup_tmp
    return 1
  fi
  if ! age --recipient "$BACKUP_AGE_RECIPIENT" --output "$encrypted_tmp" "$dump"; then
    cleanup_tmp
    return 1
  fi
  if ! chmod 0600 "$encrypted_tmp" || ! mv "$encrypted_tmp" "$encrypted"; then
    cleanup_tmp
    return 1
  fi
  cleanup_tmp

  if ! find /backups -maxdepth 1 -type f -name 'denger-*.dump.age' -mtime "+$retention" -delete; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Could not prune old backups" >&2
  fi
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Encrypted database backup created: $(basename "$encrypted")"
}

while true; do
  if ! create_backup; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Backup failed; retrying after ${retry_interval}s" >&2
    sleep "$retry_interval"
  else
    sleep "$interval"
  fi
done
