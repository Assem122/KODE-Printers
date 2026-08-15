#!/usr/bin/env bash
#
# Restore, and the quarterly restore *test* (§B19.4).
#
# Usage:
#   ./scripts/restore.sh ./backups/2026-08-14                        # test restore
#   ./scripts/restore.sh ./backups/2026-08-14 kode_printer --live    # real restore
#
# Without --live this restores into a scratch database and leaves production
# untouched. That is the default deliberately: the command someone runs at 3am
# should not be the destructive one by accident.

set -euo pipefail

SOURCE="${1:?usage: restore.sh <backup-dir> [database] [--live]}"
DATABASE="${2:-kode_printer_restore_test}"
MODE="${3:-}"

if [[ ! -f "${SOURCE}/database.sql.gz" ]]; then
  echo "No database.sql.gz in ${SOURCE}" >&2
  exit 1
fi

echo "Backup manifest:"
sed 's/^/  /' "${SOURCE}/manifest.txt" 2>/dev/null || echo "  (none)"
echo

if [[ "${MODE}" == "--live" ]]; then
  cat <<EOF
⚠  LIVE RESTORE into "${DATABASE}".

This replaces the production database. Everything printed, scanned or changed
since $(basename "${SOURCE}") will be gone.

Type the database name to confirm:
EOF
  read -r confirmation
  if [[ "${confirmation}" != "${DATABASE}" ]]; then
    echo "Aborted." >&2
    exit 1
  fi
  echo "→ stopping the application so nothing writes mid-restore"
  docker compose stop app
else
  echo "→ test restore into scratch database '${DATABASE}' (production untouched)"
  docker compose exec -T db psql -U "${POSTGRES_USER:-kode}" -d postgres \
    -c "DROP DATABASE IF EXISTS ${DATABASE}" \
    -c "CREATE DATABASE ${DATABASE}"
fi

echo "→ restoring"
gunzip -c "${SOURCE}/database.sql.gz" \
  | docker compose exec -T db psql -U "${POSTGRES_USER:-kode}" -d "${DATABASE}" --quiet

echo "→ verifying"
docker compose exec -T db psql -U "${POSTGRES_USER:-kode}" -d "${DATABASE}" <<'SQL'
\pset border 2
SELECT 'jobs'          AS table, count(*) FROM jobs
UNION ALL SELECT 'printers',      count(*) FROM printers
UNION ALL SELECT 'users',         count(*) FROM users
UNION ALL SELECT 'scans',         count(*) FROM scans
UNION ALL SELECT 'audit entries', count(*) FROM audit_log;

SELECT filename AS "last migration applied", applied_at
  FROM schema_migrations ORDER BY filename DESC LIMIT 1;
SQL

if [[ "${MODE}" == "--live" ]]; then
  echo "→ restoring file volumes"
  for volume in uploads scans templates; do
    [[ -f "${SOURCE}/${volume}.tar.gz" ]] || continue
    docker compose run --rm --no-deps -v "$(pwd)/${SOURCE}:/backup:ro" \
      -v "kode-printer_${volume}:/data" app \
      tar xzf "/backup/${volume}.tar.gz" -C /data
    echo "  ${volume} restored"
  done

  echo "→ starting the application"
  docker compose start app

  cat <<'EOF'

Now, before telling anyone it is back:
  1. GET /api/health/ready — every check must pass.
  2. Compare the job count above against the last known report.
  3. Rotate any secret that may have been exposed during the incident.
EOF
else
  cat <<EOF

Test restore succeeded. The scratch database "${DATABASE}" is left in place for
inspection; drop it when you are done:

  docker compose exec db psql -U ${POSTGRES_USER:-kode} -d postgres -c "DROP DATABASE ${DATABASE}"
EOF
fi
