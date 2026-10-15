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
: "${TRIPWIRE_ATTACH_ADMIN_URL:?set TRIPWIRE_ATTACH_ADMIN_URL}"
root=$(cd "$(dirname "$0")/.." && pwd)
umask 077 # the engine's config holds the database password
work=$(mktemp -d)
# Random, so runs sharing one PostgreSQL (CI containers all have PID 1)
# never meet; dropped only once this run has created it.
name="tripwire_attach_$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
created=0
pids=()

stop() {
  local pid=$1
  kill "$pid" 2>/dev/null || return 0
  for _ in $(seq 50); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -9 "$pid" 2>/dev/null || true
}

cleanup() {
  for pid in "${pids[@]}"; do stop "$pid"; done
  [ -z "${TRIPWIRE_ATTACH_LOG:-}" ] || cp "$work/engine.log" "$TRIPWIRE_ATTACH_LOG" 2>/dev/null || true
  if [ "$created" -eq 1 ]; then
    timeout 30 bash -c "$(declare -f sql); root='$root'; sql 'drop database if exists $name with (force)'" ||
      echo "attach suite: could not drop $name" >&2
  fi
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# SQL against the admin URL, passed through the environment so the
# password never shows in the process list.
sql() {
  (cd "$root/packages/server" && TRIPWIRE_ATTACH_SQL="$1" node -e '
    const pg = require("pg");
    const c = new pg.Client({ connectionString: process.env.TRIPWIRE_ATTACH_ADMIN_URL });
    c.connect().then(() => c.query(process.env.TRIPWIRE_ATTACH_SQL)).then(() => c.end(),
      (e) => { console.error(e.message); process.exit(1); });
  ')
}

port() { node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})'; }

sql "create database $name"
created=1
# The admin URL with its database swapped, query (sslmode) kept.
database=$(TRIPWIRE_ATTACH_NAME="$name" node -e '
  const u = new URL(process.env.TRIPWIRE_ATTACH_ADMIN_URL);
  u.pathname = "/" + process.env.TRIPWIRE_ATTACH_NAME;
  console.log(u.toString());
')

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
  # Exported, never on a command line, so no URL shows in the process list.
  export TRIPWIRE_ENGINE_URL="http://127.0.0.1:$bind_port"
  export TRIPWIRE_ENGINE_SECRET_FILE="$work/data/interface-secret"
  export TRIPWIRE_DATABASE_URL="$database"
  export TRIPWIRE_ATTACH_RPC="$rpc"
  export TRIPWIRE_CHAIN_ID=31337
  export TRIPWIRE_RESPONSE_MODE=prepare
  TRIPWIRE_ATTACH_ENGINE_VERSION="$("$engine" --version)"
  export TRIPWIRE_ATTACH_ENGINE_VERSION
  if [ -n "$checkout" ]; then export TRIPWIRE_ENGINE_CONTRACT="$checkout"; fi
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
