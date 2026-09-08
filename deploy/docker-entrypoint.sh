#!/bin/sh
# Starts the log server. Generates the signing key on first run and prints the public key, which is what you hand
# to anyone who verifies receipts logged here. The token comes from AGENT_CUSTODY_LOG_TOKEN; without one the log
# accepts appends from anyone who can reach the port, which is only acceptable behind a private network.
set -eu

: "${AGENT_CUSTODY_LOG_FILE:=/data/log.jsonl}"
: "${AGENT_CUSTODY_LOG_KEY:=/data/keys/log.key}"
: "${AGENT_CUSTODY_LOG_PORT:=8787}"

key_dir=$(dirname "$AGENT_CUSTODY_LOG_KEY")
key_name=$(basename "$AGENT_CUSTODY_LOG_KEY" .key)
mkdir -p "$key_dir" "$(dirname "$AGENT_CUSTODY_LOG_FILE")"

if [ ! -f "$AGENT_CUSTODY_LOG_KEY" ]; then
  echo "agent-custody log: no signing key at $AGENT_CUSTODY_LOG_KEY; generating one" >&2
  agent-custody keygen --dir "$key_dir" --name "$key_name" >&2
fi

echo "agent-custody log: public key (give this to verifiers as --log-key):" >&2
cat "$key_dir/$key_name.pub" >&2

if [ -n "${AGENT_CUSTODY_LOG_TOKEN:-}" ]; then
  exec agent-custody log --file "$AGENT_CUSTODY_LOG_FILE" --key "$AGENT_CUSTODY_LOG_KEY" --host 0.0.0.0 --port "$AGENT_CUSTODY_LOG_PORT" --token-env AGENT_CUSTODY_LOG_TOKEN
else
  echo "agent-custody log: WARNING no AGENT_CUSTODY_LOG_TOKEN set; anyone who can reach port $AGENT_CUSTODY_LOG_PORT may append" >&2
  exec agent-custody log --file "$AGENT_CUSTODY_LOG_FILE" --key "$AGENT_CUSTODY_LOG_KEY" --host 0.0.0.0 --port "$AGENT_CUSTODY_LOG_PORT"
fi
