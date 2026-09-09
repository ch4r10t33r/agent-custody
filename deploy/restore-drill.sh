#!/bin/sh
# The restore drill: proves that last night's backups bring up a working log with the same signing key. Runs on the
# log's host as a second compose project beside the live one, on its own volumes and network, publishing no ports;
# nothing it does touches the live service. It takes the newest key tarball and database dump from BACKUP_DIR,
# restores both into fresh volumes, starts postgres, signer, and log, checks the log's head against its own key
# document, compares that key id with the live log's, and tears everything down. Exit 0 means the drill passed.
#
#   ./restore-drill.sh                 # newest backup
#   ./restore-drill.sh 2026-09-08      # a particular night
#
# Record the date and the result in the runbook's log of drills.
set -eu
cd "$(dirname "$0")"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/agent-custody}"
DAY="${1:-$(ls "$BACKUP_DIR"/db-*.sql.gz | sed 's/.*db-\(.*\)\.sql\.gz/\1/' | sort | tail -1)}"
DUMP="$BACKUP_DIR/db-$DAY.sql.gz"
KEYS="$BACKUP_DIR/log-$DAY.tgz"
[ -f "$DUMP" ] && [ -f "$KEYS" ] || { echo "restore-drill: no backup pair for $DAY in $BACKUP_DIR" >&2; exit 1; }
P=agent-custody-drill
C="docker compose -p $P -f docker-compose.yaml -f restore-drill.yaml"
LIVE="docker compose -f docker-compose.yaml"
cleanup() { $C down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
cleanup

echo "restore-drill: restoring backups of $DAY into project $P"
$C up -d --wait postgres >/dev/null
# the dump was taken with pg_dump against the live database; it recreates every table and row
gunzip -c "$DUMP" | $C exec -T postgres sh -c 'psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null
docker run --rm -v "${P}_logdata:/data" -v "$BACKUP_DIR:/backup:ro" alpine tar xzf "/backup/log-$DAY.tgz" -C / >/dev/null
$C up -d --wait signer log >/dev/null

# the restored log must serve a head that verifies against its own key document, and its key must be the live one
KEY_RESTORED=$($C exec -T log node -e 'fetch("http://127.0.0.1:8787/.well-known/agent-custody-log.json").then(r=>r.json()).then(d=>console.log(d.keys[0].keyid))' --input-type=module)
KEY_LIVE=$($LIVE exec -T log node -e 'fetch("http://127.0.0.1:8787/.well-known/agent-custody-log.json").then(r=>r.json()).then(d=>console.log(d.keys[0].keyid))' --input-type=module)
LEAVES=$($C exec -T postgres sh -c 'psql -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select count(*) from log_leaves"')
TENANTS=$($C exec -T postgres sh -c 'psql -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select count(*) from log_tenants"')
$C exec -T log agent-custody log-check --log-url http://127.0.0.1:8787/ --tenant default | sed 's/^/  /'
echo "restore-drill: restored $LEAVES leaf(es) across $TENANTS tenant(s); key $KEY_RESTORED"
if [ "$KEY_RESTORED" != "$KEY_LIVE" ]; then echo "restore-drill: FAIL: restored key $KEY_RESTORED is not the live key $KEY_LIVE" >&2; exit 1; fi
echo "restore-drill: PASS for backups of $DAY ($(date -u +%FT%TZ))"
