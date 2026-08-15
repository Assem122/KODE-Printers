#!/usr/bin/env bash
#
# Nightly backup (§B19.4, GAP-07).
#
# Three things are backed up and they have different homes: the database dump
# and the file volumes go here, and `.env` goes to the club's secret store —
# never into the same archive as the data it protects.

set -euo pipefail

STAMP="$(date +%Y-%m-%d)"
TARGET="${BACKUP_DIR:-./backups}/${STAMP}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

mkdir -p "${TARGET}"

echo "→ database"
# --clean --if-exists so the dump can be replayed into a database that already
# has objects, which is what a restore into a scratch database looks like.
docker compose exec -T db pg_dump \
  --username "${POSTGRES_USER:-kode}" \
  --dbname "${POSTGRES_DB:-kode_printer}" \
  --clean --if-exists --no-owner --no-privileges \
  | gzip -9 > "${TARGET}/database.sql.gz"

echo "→ uploads"
docker compose run --rm --no-deps -v "$(pwd)/${TARGET}:/backup" \
  -v kode-printer_uploads:/data:ro app \
  tar czf /backup/uploads.tar.gz -C /data . 2>/dev/null || echo "  (no uploads volume yet)"

echo "→ scans"
docker compose run --rm --no-deps -v "$(pwd)/${TARGET}:/backup" \
  -v kode-printer_scans:/data:ro app \
  tar czf /backup/scans.tar.gz -C /data . 2>/dev/null || echo "  (no scans volume yet)"

echo "→ templates"
docker compose run --rm --no-deps -v "$(pwd)/${TARGET}:/backup" \
  -v kode-printer_templates:/data:ro app \
  tar czf /backup/templates.tar.gz -C /data . 2>/dev/null || echo "  (no templates volume yet)"

# A manifest, so a restore six months from now does not have to guess what it
# is looking at or which schema version produced it.
cat > "${TARGET}/manifest.txt" <<EOF
KODE Printer backup
Taken:     $(date -Iseconds)
Host:      $(hostname)
Schema:    $(docker compose exec -T db psql -U "${POSTGRES_USER:-kode}" -d "${POSTGRES_DB:-kode_printer}" \
             -tAc "SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1" 2>/dev/null || echo unknown)
Jobs:      $(docker compose exec -T db psql -U "${POSTGRES_USER:-kode}" -d "${POSTGRES_DB:-kode_printer}" \
             -tAc "SELECT count(*) FROM jobs" 2>/dev/null || echo unknown)

NOTE: .env is deliberately NOT in this archive. It lives in the club's secret
store. A backup that contains both the data and the key to it is one theft away
from being useless as a control.
EOF

echo "→ pruning backups older than ${RETENTION_DAYS} days"
find "${BACKUP_DIR:-./backups}" -maxdepth 1 -type d -mtime "+${RETENTION_DAYS}" -exec rm -rf {} + 2>/dev/null || true

echo
echo "Backup complete: ${TARGET}"
du -sh "${TARGET}"
echo
echo "Reminder: an untested backup is not a backup. scripts/restore.sh, quarterly."
