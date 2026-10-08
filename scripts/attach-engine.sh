#!/usr/bin/env bash
# The attach-mode suite:
# runs packages/server/src/engine/attach.test.ts against a real engine.
#
#   scripts/attach-engine.sh <engine-binary> [engine-checkout]
#
# Needs anvil on PATH and TRIPWIRE_ATTACH_ADMIN_URL, a PostgreSQL URL whose
# user may create databases. Starts a local chain, a scratch database the
# engine and the application share, and the engine in `prepare` mode, then
# runs the suite attached to it and tears everything down. Give an engine
# checkout to also check the rule language it publishes (`watch`).
# TRIPWIRE_ATTACH_LOG names a file to keep the engine's log in.
set -euo pipefail

engine=${1:?usage: attach-engine.sh <engine-binary> [engine-checkout]}
checkout=${2:-}
admin=${TRIPWIRE_ATTACH_ADMIN_URL:?set TRIPWIRE_ATTACH_ADMIN_URL}
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
name="tripwire_attach_$$"
pids=()

cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  [ -z "${TRIPWIRE_ATTACH_LOG:-}" ] || cp "$work/engine.log" "$TRIPWIRE_ATTACH_LOG" 2>/dev/null || true
  wait 2>/dev/null || true
  sql "drop database if exists $name with (force)" || true
  rm -rf "$work"
}
trap cleanup EXIT

sql() {
  (cd "$root/packages/server" && node -e '
    const pg = require("pg");
    const c = new pg.Client({ connectionString: process.argv[1] });
    c.connect().then(() => c.query(process.argv[2])).then(() => c.end(),
      (e) => { console.error(e.message); process.exit(1); });
  ' "$admin" "$1")
}

port() { node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})'; }

sql "create database $name"
database="${admin%/*}/$name"

rpc_port=$(port)
anvil --port "$rpc_port" --silent &
pids+=($!)
rpc="http://127.0.0.1:$rpc_port"
for _ in $(seq 50); do
  curl -sf -o /dev/null -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$rpc" && break
  sleep 0.2
done

bind_port=$(port)
cat > "$work/engine.toml" <<EOF
[chain]
chain_id = 31337
rpc_http = "$rpc"
poll_interval_ms = 150

[response]
mode = "prepare"

[database]
url = "$database"
max_connections = 3

[data]
dir = "$work/data"

[engine]
bind = "127.0.0.1:$bind_port"
EOF
"$engine" run --config "$work/engine.toml" > "$work/engine.log" 2>&1 &
pids+=($!)
for _ in $(seq 150); do
  [ -s "$work/data/interface-secret" ] && break
  sleep 0.2
done
[ -s "$work/data/interface-secret" ] || { cat "$work/engine.log"; exit 1; }

status=0
(
  cd "$root/packages/server"
  env TRIPWIRE_ENGINE_URL="http://127.0.0.1:$bind_port" \
  TRIPWIRE_ENGINE_SECRET_FILE="$work/data/interface-secret" \
  TRIPWIRE_DATABASE_URL="$database" \
  TRIPWIRE_ATTACH_RPC="$rpc" \
  TRIPWIRE_CHAIN_ID=31337 \
  TRIPWIRE_RESPONSE_MODE=prepare \
  TRIPWIRE_ATTACH_ENGINE_VERSION="$("$engine" --version)" \
  ${checkout:+TRIPWIRE_ENGINE_CONTRACT="$checkout"} \
  npx vitest run src/engine/attach.test.ts 2>&1 | tee "$work/suite.log"
  exit "${PIPESTATUS[0]}"
) || status=$?
# Every check runs; a skipped one fails the suite.
if [ "$status" -eq 0 ] && grep -qiE '[0-9]+ (skipped|todo)' "$work/suite.log"; then
  echo "attach suite: a check was skipped" >&2
  status=1
fi
[ "$status" -eq 0 ] || { echo "--- engine log (tail)"; tail -40 "$work/engine.log"; }
exit "$status"
