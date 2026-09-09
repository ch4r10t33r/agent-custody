#!/bin/sh
# Copies the nightly backups off the machine. The backup job writes the key tarball and the database dump to
# /var/backups/agent-custody on the same disk as the data, which protects against nothing that takes the disk.
# This job mirrors that directory to BACKUP_REMOTE with rclone, so a lost VM is a restore, not a lost key.
#
# Install on the host, after `rclone config` has created the remote:
#   cp backup-offsite.sh /etc/cron.daily/agent-custody-backup-offsite && chmod +x /etc/cron.daily/agent-custody-backup-offsite
# BACKUP_REMOTE comes from deploy/.env, for example:
#   BACKUP_REMOTE=hetzner:agent-custody-backups        (Hetzner Object Storage, an S3 remote in rclone)
#   BACKUP_REMOTE=storagebox:backups/agent-custody      (a Hetzner Storage Box, an sftp remote)
#   BACKUP_REMOTE=s3:my-bucket/agent-custody            (any S3)
# The remote keeps everything the local directory keeps (thirty days) plus whatever `--backup-dir` retains; nothing
# is deleted remotely that is younger than ninety days.
set -eu
ENV_FILE="${ENV_FILE:-/opt/agent-custody/deploy/.env}"
SRC="${BACKUP_DIR:-/var/backups/agent-custody}"
if [ -f "$ENV_FILE" ]; then
  BACKUP_REMOTE="${BACKUP_REMOTE:-$(sed -n 's/^BACKUP_REMOTE=//p' "$ENV_FILE" | tail -1)}"
fi
if [ -z "${BACKUP_REMOTE:-}" ]; then
  echo "agent-custody backup-offsite: BACKUP_REMOTE is not set in $ENV_FILE; backups stay on this disk only" >&2
  exit 1
fi
command -v rclone >/dev/null 2>&1 || { echo "agent-custody backup-offsite: rclone is not installed (apt install rclone)" >&2; exit 1; }
# yesterday's two files must exist, or the backup job itself is broken and copying an old directory would hide it
today=$(date +%F)
[ -f "$SRC/log-$today.tgz" ] && [ -f "$SRC/db-$today.sql.gz" ] || { echo "agent-custody backup-offsite: no backup for $today in $SRC; run the backup job first" >&2; exit 1; }
rclone sync "$SRC" "$BACKUP_REMOTE/current" --backup-dir "$BACKUP_REMOTE/replaced/$today" --min-age 0 --transfers 4 -q
rclone delete "$BACKUP_REMOTE/replaced" --min-age 90d -q 2>/dev/null || true
echo "agent-custody backup-offsite: $today copied to $BACKUP_REMOTE ($(rclone size "$BACKUP_REMOTE/current" --json 2>/dev/null | sed 's/.*"bytes":\([0-9]*\).*/\1/') bytes)"
