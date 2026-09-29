#!/bin/sh
# The founder's note to new registrations, once each, about an hour after they sign up. Runs inside the portal
# container against the same database and mail settings the portal uses; install it as /etc/cron.hourly/agent-custody-followup
# (a copy, executable, no extension). Prints one line per run; a provider failure leaves the person pending for the next hour.
set -eu
cd "$(dirname "$0")"
MAIL_FROM=$(sed -n 's/^MAIL_FROM=//p' .env | tail -1); MAIL_NOTIFY=$(sed -n 's/^MAIL_NOTIFY=//p' .env | tail -1); PORTAL_HOST=$(sed -n 's/^PORTAL_HOST=//p' .env | tail -1)
[ -n "$MAIL_FROM" ] || { echo "MAIL_FROM is not in .env; nothing sent"; exit 0; }
exec docker compose --profile public exec -T portal agent-custody portal-followup --db-env DATABASE_URL --mail-key-env MAIL_API_KEY --mail-from "$MAIL_FROM" ${MAIL_NOTIFY:+--mail-notify "$MAIL_NOTIFY"} --portal-url "https://${PORTAL_HOST:-app.agent-custody.dev}/" "$@"
