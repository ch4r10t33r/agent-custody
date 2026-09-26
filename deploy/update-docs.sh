#!/bin/sh
# Rebuilds and restarts the docs site from the current checkout. Run after `git pull` on the log's host.
set -eu
cd "$(dirname "$0")"
docker compose --profile public build docs
docker compose --profile public up -d docs
echo "docs: $(docker compose --profile public ps --format '{{.Status}}' docs)"
