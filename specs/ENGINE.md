# Engine

How the application installs, configures, runs and supervises the
engine. The engine is a native binary with a local control interface
and a set of read views; this document covers everything the
application does to have one running, and what it tells people about
it. `HIGH-LEVEL-SPEC.md` places it; `DATABASE.md` provides the database
the engine is given and the start and stop order this document extends;
`NOTIFICATIONS.md` raises the alerts about the engine's health;
`RESPONSES.md` owns what the response settings mean; `SETTINGS.md` and
`FIRST-RUN.md` are the screens that change the configuration defined
here.

## Summary

- The application package pins one exact engine release. On first
  start it downloads that release for the platform, verifies its
  signature and checksum, and installs it under `TRIPWIRE_HOME`.
- The application owns the engine's configuration. It keeps it in its
  own `config.json`, generates `engine.toml` from it on every start,
  and hands every secret to the engine through its environment, never
  through a file.
- The application is the engine's supervisor: it spawns it, watches
  its health, restarts it when it exits or hangs, stops it in order,
  and is the one party able to report on it while it is down.
- Configuration changes are applied by restarting the engine, with an
  automatic return to the previous configuration if the engine refuses
  the new one.

## Installing

### The pin

The CLI package ships `engine.json` beside the executable:

```json
{
  "version": "0.1.0",
  "publicKey": "RWSoM+vf95ORaF6HNTzIuR3dLJTdGRkZtNA+Knh6VeqT57s6rMkL25db",
  "releases": "https://github.com/sigint-zero/tripwire/releases/download/engine-v{version}/{asset}"
}
```

| Field | Meaning |
|-|-|
| `version` | the exact engine release this application is built against: its control interface, views and rule schema are the ones in that release's contract files |
| `publicKey` | the minisign public key the engine's releases are signed with (key id `689193F7DFEB33A8`) |
| `releases` | a URL template for release assets; `{version}` and `{asset}` are substituted |

Engine releases are published on this repository's releases, tagged
`engine-v<version>` so they never collide with the application's own
tags, and never marked "latest": the application always fetches its
pinned version by name, never whatever is newest. A published release
is never replaced; a bad one is superseded by the next version. The
assets are fetched anonymously, so the repository's releases must be
publicly readable. Besides
the executables, each release's `SHA256SUMS` covers the contract files
(`openapi.json`, `views.json`, `rule.schema.json`) and
`rule-examples.tar.gz`, a set of valid example rule documents; the
installer needs only the executable's line.

`TRIPWIRE_ENGINE_RELEASES` in the environment replaces `releases`, for
a mirror or a network that cannot reach the release location. The key
cannot be overridden: a mirror serves the same signed files, and
verification never depends on where they came from.

### Platforms

Each release carries one executable per target, named
`tripwire-engine-<version>-<target>`:

| Platform | Target |
|-|-|
| Linux, x86-64 | `x86_64-unknown-linux-musl` |
| Linux, ARM64 | `aarch64-unknown-linux-musl` |

The engine is built for Linux only for now. Any other platform,
macOS included, puts the engine in the `failed` state with: "The
engine is not built for <platform>/<arch>. Run Tripwire on Linux (a
container or WSL works)." The server still
starts and serves the dashboard, which says the same. On such a
platform the application runs only with the stand-in or an attached
engine (Development, below); this includes Windows, where
`DATABASE.md` defines the local database endpoint for exactly that
use.

### Download and verify

Installation happens at start, not when the package is installed. The
first `tripwire start` with no verified binary for the pinned version
begins the download in the background while the server comes up, so
the dashboard is available for first run while the engine arrives
(state `installing`, with bytes and total reported).

1. Download `SHA256SUMS` and `SHA256SUMS.minisig`.
2. Verify the signature with the pinned public key: the key id
   matches, the Ed25519 signature over the file (BLAKE2b-512 prehashed,
   as minisign signs) verifies, and the global signature over the
   signature and its trusted comment verifies. Any failure stops here.
3. Download the platform's executable to
   `TRIPWIRE_HOME/engine/bin/.download-<random>`, streaming it through
   SHA-256.
4. Compare the digest with the executable's line in `SHA256SUMS`.
   A mismatch deletes the download and stops here.
5. Set mode `0755`, rename into
   `TRIPWIRE_HOME/engine/bin/<version>/tripwire-engine`, and keep
   `SHA256SUMS` and its signature beside it.
6. Run it with `--version` and check the printed version equals the
   pin (G5 below).

Network failures retry three times with backoff, then the state is
`failed` with the last error; a restart request (API or CLI) retries.
A verification failure is `failed` at once, naming what did not match,
and is never retried automatically: it means the file is not what the
release published.

On every later start the application recomputes the installed
executable's SHA-256 against the kept `SHA256SUMS`, which costs a
fraction of a second and catches a corrupted or replaced file.

Verification uses `node:crypto` only (Ed25519 and BLAKE2b-512 are both
built in), about sixty lines, so the package gains no dependency.

### Offline

`tripwire engine install --from <dir>` installs from a directory
holding the executable, `SHA256SUMS` and `SHA256SUMS.minisig`, with the
same verification. It is also how an image build installs the engine
ahead of time: `tripwire engine install` with no `--from` downloads
and verifies without starting anything.

### Where it lives

| Path | Holds |
|-|-|
| `TRIPWIRE_HOME/engine/` | the engine's data directory (`[data] dir`), mode `0700`: the engine writes `interface-secret` and `keys/` here |
| `TRIPWIRE_HOME/engine/bin/<version>/` | an installed release: `tripwire-engine`, `SHA256SUMS`, `SHA256SUMS.minisig` |
| `TRIPWIRE_HOME/engine/engine.pid` | the running engine's pid, start time and binary path |
| `TRIPWIRE_HOME/engine.toml` | the generated engine configuration, mode `0600` |
| `TRIPWIRE_HOME/logs/engine.log` | the engine's output, rotated |
| `TRIPWIRE_HOME/run.lock` | held by a running server |

The pinned version and the one before it are kept; older versions are
deleted once the pinned one has reached `ready`.

## Configuration

`TRIPWIRE_HOME/config.json` (mode `0600`) is the application's
configuration. `DATABASE.md` defines `database`; this document defines
`chain`, `response`, `retention` and `mempool`, which together are
everything the engine is configured with.

```json
{
  "version": 1,
  "database": { "mode": "local" },
  "chain": {
    "chainId": 1,
    "rpcHttp": "env:TRIPWIRE_RPC_HTTP",
    "rpcWs": null,
    "pollIntervalMs": 2000,
    "controllerAddress": null,
    "controllerDeployedBlock": null
  },
  "response": {
    "mode": "notify",
    "key": null,
    "maxFeeGwei": null,
    "maxPriorityFeeGwei": null,
    "replacementBlocks": 5,
    "maxAttempts": 3,
    "submission": "private",
    "privateEndpoints": null
  },
  "retention": { "pointsDays": 90, "notificationsDays": 90 },
  "mempool": { "enabled": false, "respond": false }
}
```

`chain` is absent until first run's chain step saves it
(`FIRST-RUN.md`); the other members take the defaults above when
absent.

Validation, at load and before any write:

| Member | Rule |
|-|-|
| `version` | `1` |
| `chain.chainId` | a positive integer; fixed once set. An installation watches one chain (`DATABASE.md`, DB9): a different chain is a different `TRIPWIRE_HOME` and database |
| `chain.rpcHttp` | an `http://` or `https://` URL, or `env:NAME` |
| `chain.rpcWs` | a `ws://` or `wss://` URL, `env:NAME`, or null |
| `chain.pollIntervalMs` | integer, 100 to 60000 |
| `chain.controllerAddress`, `chain.controllerDeployedBlock` | both set or both null. Null means the known deployment for the chain id, from the table in `RESPONSES.md`; a chain with none runs without a controller |
| `response.mode` | `notify`, `prepare` or `send` |
| `response.key` | an address or null |
| `response.maxFeeGwei` | a positive integer, or null for the engine's default of 100 |
| `response.maxPriorityFeeGwei` | an integer, 0 or more, or null for the engine's default of 2. It is the first attempt's priority fee, not a cap: escalation may raise it, bounded only by the maximum fee. It may not exceed the maximum fee, counting the engine's defaults for whichever of the two is null |
| `response.replacementBlocks`, `response.maxAttempts` | integer, 1 or more |
| `response.submission` | `private`, `private_strict` or `public` |
| `response.privateEndpoints` | a non-empty list of `http://` or `https://` URLs, or null (the engine's built-in set). An empty list is refused: the engine would treat it as an empty route set, under which `private` submits publicly and `private_strict` cannot start |
| `retention.pointsDays`, `retention.notificationsDays` | integer, 7 or more. The engine accepts 1 or more; 7 is the application's own floor, so a slip of the keyboard cannot erase a week of history |
| `mempool.enabled` | true only with `chain.rpcWs` set |
| `mempool.respond` | true only with `mempool.enabled` |
| anything else | an unknown member is an error, as it is in the engine |

A failure stops the start with `config_invalid`, naming the member and
the rule. What the response values mean, and the extra conditions on
switching `response.mode`, are `RESPONSES.md`'s.

RPC URLs usually carry a provider key. They may be written literally
(the file is `0600`) or as `env:NAME`. No API response and no log line
carries one in full: the scheme and host are shown and the path and
query are masked.

The key passphrase for unattended starts is never in this file. It is
read from `TRIPWIRE_KEYS_PASSPHRASE` in the application's own
environment and passed through to the engine (`RESPONSES.md`).

## engine.toml

Generated on every start from `config.json`, written to a temporary
file and renamed, mode `0600`. The application writes only keys the
pinned release documents, since the engine rejects unknown keys. For
the configuration above in local mode:

```toml
# Generated by Tripwire from config.json on every start. Edits are overwritten.

[chain]
chain_id = 1
rpc_http = "env:TRIPWIRE_RPC_HTTP"
poll_interval_ms = 2000
controller_address = "0x328aed8f7a01f45a959c187f3cb97ec508064854"
controller_deployed_block = <the deployment block from RESPONSES.md>

[database]
url = "env:TRIPWIRE_DATABASE_URL"
max_connections = 1

[data]
dir = "/home/owner/.tripwire/engine"

[engine]
bind = "127.0.0.1:41873"

[response]
mode = "notify"
replacement_blocks = 5
max_attempts = 3
submission = "private"

[retention]
points_days = 90
notifications_days = 90

[mempool]
enabled = false
respond = false
```

| Key | From |
|-|-|
| `[chain] rpc_http`, `rpc_ws` | always `env:TRIPWIRE_RPC_HTTP` and `env:TRIPWIRE_RPC_WS`; `rpc_ws` only when `chain.rpcWs` is set |
| `[chain] controller_address`, `controller_deployed_block` | `chain.controller*`, or the known deployment for the chain; omitted when there is none |
| `[database] url` | always `env:TRIPWIRE_DATABASE_URL`; `max_connections = 1` in local mode only (`DATABASE.md`) |
| `[data] dir` | `TRIPWIRE_HOME/engine`, absolute |
| `[engine] bind` | `127.0.0.1` and a free port chosen at each start |
| `[response]` | the `response` member; null values are omitted so the engine's defaults apply |
| `[retention]`, `[mempool]` | the members of the same name |
| `[keys] passphrase` | `env:TRIPWIRE_KEYS_PASSPHRASE`, written only when that variable is set in the application's environment |

The file contains no secret: every URL and the passphrase are `env:`
references.

### The engine's environment

The engine is spawned with an allow-listed environment, not the
application's own, so nothing unrelated in the owner's shell reaches
it:

| Variable | Value |
|-|-|
| `TRIPWIRE_DATABASE_URL` | the resolved database URL |
| `TRIPWIRE_RPC_HTTP` | `chain.rpcHttp`, resolved |
| `TRIPWIRE_RPC_WS` | `chain.rpcWs`, resolved, when set |
| `TRIPWIRE_KEYS_PASSPHRASE` | passed through, when set |
| `PATH` | passed through |

### The port

The control interface binds loopback only. The application picks a
free port at each start by binding port 0 and releasing it, and writes
it into `engine.toml`. Two installations on one machine never collide,
and nothing but the application talks to that port. If the port was
taken in the moment between, the engine exits with the generic code 1
and logs "cannot bind the control interface"; the supervisor
recognises that line in the log, picks another port for the next
start, and does not count the exit as unplanned. A code 1 without that
line is a crash like any other.

## Start

`DATABASE.md` fixes the order around the database. With the engine,
the full start is:

1. Take `run.lock` (below). Stop an orphaned engine if one is found.
2. Load and validate `config.json`.
3. Bring up the database, pre-flight, apply the application's
   migrations (`DATABASE.md`, steps 1 to 3).
4. Listen. The dashboard is available from here; everything below runs
   in the background and is reported through the engine state.
5. With no `chain` configured: state `unconfigured`. The install runs
   if needed, and the engine starts when first run saves the chain.
6. Resolve the binary: the pinned version, installing it if missing
   (`installing`), checking its SHA-256.
7. Write `engine.toml`.
8. Run `tripwire-engine migrate --config engine.toml` with the engine's
   environment. It migrates the engine's schemas and exits without
   touching the chain. A refusal (for example a schema newer than this
   engine) is shown verbatim and the state is `failed`.
9. Spawn `tripwire-engine run --config engine.toml` in its own process
   group, with stdout and stderr piped to the log, and write
   `engine.pid`. State `starting`.
10. Wait until `TRIPWIRE_HOME/engine/interface-secret` exists, read
    it, and poll `GET /v1/health`: every second while starting, every
    five seconds after. The engine writes the file beside its final
    name and renames it into place, so it appears whole or not at all;
    the application still refuses a secret that is not 64 hexadecimal
    characters, as a crash.

The engine gets its own process group so a Ctrl+C in the terminal
reaches the application only, which then stops the engine in the order
`DATABASE.md` requires.

The secret is read after each spawn. The engine reuses the file, so it
rarely changes; a `401` from the engine makes the application re-read
it once before treating the engine as unhealthy.

## Supervision

### States

| State | Meaning |
|-|-|
| `unconfigured` | no `chain` in `config.json` yet; nothing to start |
| `installing` | the pinned release is being downloaded and verified |
| `starting` | spawned, not yet `ready` |
| `ready` | health says ready |
| `degraded` | health says degraded, with the engine's cause: the RPC is failing, evaluation lags the node's head, the response mode is `send` and no signing key is unlocked, or the pending-transaction subscription is down |
| `unresponsive` | the process is alive but its health has not answered for 60 seconds |
| `restarting` | it exited or was killed without being asked to; waiting out the backoff |
| `failed` | it will not restart until something changes: installation or verification failed, the platform is unsupported, the configuration was refused, or the schema is newer than the engine |
| `stopped` | stopped on purpose, while the server shuts down |
| `stand-in` | the development stand-in answers instead of the engine |

`ready` and `degraded` both count as running: in both the engine is
protecting.

### Health

Each poll of `GET /v1/health` has a five-second timeout and records
the engine's status and its cause when degraded, version, the head it
last observed on the node (`observed_head`), the last block it
evaluated, each cursor's position and age, and its RPC state. Lag is
the observed head minus the ingest cursor. While the process is down,
cursors come from the `api_v1.engine_status` view instead, which stays
readable, so the dashboard can say both "stopped" and "last block
processed 4 minutes ago". The engine reports no block times in health;
where the application shows a time for the head, it is when the ingest
cursor last moved (below, `GET /engine`).

### Restart policy

| Event | Response |
|-|-|
| exit with code 0 when not asked to stop | restart with backoff |
| exit because the database is unreachable or the RPC failed verification (codes in G3) | restart with backoff; the message is shown until the engine is up |
| exit because another engine holds the database (code `70`) | retry every 10 seconds, not counted as unplanned and raising nothing; state `starting` with "waiting for the previous engine's hold on the database to lapse". After 90 seconds of this it becomes an unplanned exit like any other |
| exit because the configuration was refused or the schema is newer (codes in G3) | `failed`; no restart until the configuration changes or a person asks |
| any other exit, including a crash or a signal | restart with backoff |
| health unanswered for 60 seconds | `unresponsive`, and "engine not responding" |
| still unanswered at 120 seconds | `SIGKILL`, then restart with backoff |

The backoff starts at one second and doubles to a cap of 60 seconds.
It resets once the engine has been running for ten minutes. A hung
engine is not protecting, and killing it is the only recovery the
application has, so an unresponsive engine is not left alone.

Code `70` has its own row because of how the engine guards against
two engines on one database (G1): a running engine holds a lease in the
database, renewed every 10 seconds and released on a clean stop. An
engine that did not stop cleanly (`kill -9`, the 120-second `SIGKILL`
above, a crash) leaves its lease behind, and a new engine may take it
over only once it is 60 seconds stale. Until then every start exits
`70`. Retrying on the normal backoff would count five or six unplanned
restarts for one death and raise "engine restarting repeatedly";
retrying on a fixed interval without counting waits out the lease
quietly. So after an unplanned death the engine is back within about
70 seconds, not within the first backoff step.

The alerts are the `system` notifications in `NOTIFICATIONS.md`: an
unplanned exit from a running engine raises "engine stopped", a third
unplanned restart within ten minutes raises "engine restarting
repeatedly" once, entering `failed` raises "engine cannot start"
(install verification, configuration, schema or platform, which no
waiting will fix), and reaching `ready` after any of them raises
"engine recovered". Planned restarts (configuration changes, a restart
a person asked for) raise nothing.

### One engine only

Two engines writing one database would double every response. Three
guards prevent it:

- **`run.lock`.** The server creates `TRIPWIRE_HOME/run.lock`
  exclusively with its pid, in both database modes. A lock whose pid is
  gone is replaced; a live one stops the start with "Tripwire is
  already running as process N". The local database's own lock
  (`DATABASE.md`) is unchanged.
- **`engine.pid`.** The server records the engine's pid, start time and
  binary path. A server that died without stopping its engine leaves
  it running in external mode (in local mode it loses its database and
  exits). At the next start, if the recorded pid is alive and its
  command line names the recorded binary, the application stops it
  (`SIGTERM`, 15 seconds, `SIGKILL`) before spawning another. A pid
  reused by an unrelated process is left alone and the file deleted.
- **The engine's own guard** (G1), which covers two installations
  pointed at one external database.

## Stop

On shutdown, `DATABASE.md`'s stop step 2 is: send `SIGTERM`, which the
engine answers by finishing the block in flight and exiting 0; after
15 seconds, `SIGKILL`. Then delete `engine.pid`. State `stopped`.

## Applying configuration

The engine has no runtime configuration endpoint. Every change that
reaches `engine.toml` is applied by one supervisor operation, used by
`SETTINGS.md`, `RESPONSES.md` and `FIRST-RUN.md`:

1. Validate the new configuration as above.
2. Copy `config.json` to `config.json.previous`; write the new one to a
   temporary file and rename it into place.
3. Regenerate `engine.toml` and restart the engine (stop as above, then
   start from step 6).
4. Wait up to 60 seconds for `ready` or `degraded`. The stop is a clean
   one, which releases the engine's database lease, so the new engine
   does not wait on it; time spent retrying exit `70` (a previous engine
   that died uncleanly just before) does not count against the 60
   seconds.
5. If the engine exits instead, or does not get there in time: restore
   `config.json.previous`, restart again, and return the engine's own
   error message (its log lines from the failed attempt).

One change is applied at a time; a second request while one is in
progress gets `409 settings_busy`. The restart is a few
seconds without evaluation; the engine resumes from its cursor, so no
block is skipped. The dashboard shows "restarting to apply settings"
for the duration. Changing `database` is not applied this way: it moves
the application's own pool too, and takes a full restart of Tripwire
(`DATABASE.md`).

## Logs

The engine's stdout and stderr go line by line to
`TRIPWIRE_HOME/logs/engine.log`, rotated at 10 MB with five files
kept; the directory is `0700` and the files `0600`. The supervisor adds
its own lines, prefixed `[tripwire]`: spawned (pid, version), exited
(code or signal, how long it ran), killed, restarting (backoff),
configuration applied or rolled back. The last 1000 lines are kept in
memory for the API.

No secret reaches the log: the engine does not log its configuration
secrets, and the application never logs environment values or URLs
beyond scheme and host.

## Upgrades

A new application release that pins a new engine version installs it
at its first start (`installing`), then starts it; the engine migrates
its schemas forward in the `migrate` step. The previous binary stays
until the new one reaches `ready`, and then one version back is kept.

The application only ever runs its pinned version. After a downgrade
of the application, the older engine refuses a schema that a newer one
has already migrated: `migrate` fails, the state is `failed`, and the
engine's message, which names the version the schema requires, is
shown verbatim in the dashboard and by `tripwire engine status`. The
remedy is to reinstall the newer application.

## Development

| Setting | Effect |
|-|-|
| `TRIPWIRE_ENGINE=stand-in` | the stand-in in the server answers instead of the engine: state `stand-in`, the dashboard shows "Stand-in". `pnpm dev` sets it. Nothing is installed or spawned |
| `TRIPWIRE_ENGINE_URL` and `TRIPWIRE_ENGINE_SECRET_FILE` | attach to an engine someone runs by hand: the application polls its health and reports the same states, but spawns, restarts and reconfigures nothing (`409 engine_attached`). Chain id and response mode are read from `config.json` as usual; keeping the hand-run engine's configuration consistent is the developer's job |
| `TRIPWIRE_ENGINE_BINARY=<path>` | spawn this binary instead of the pinned release: no download, no signature check, otherwise supervised normally. The dashboard and `tripwire engine status` mark the engine "unpinned" |

The stand-in is opt-in. Without `TRIPWIRE_ENGINE`, an installation with
no engine configured is `unconfigured`, never simulated, so a
production install cannot silently show made-up data. Today's
`TRIPWIRE_RESPONSE_MODE` and `TRIPWIRE_CHAIN_ID` variables are retired:
both values come from `config.json`.

## API

All under `/api/v1`, requiring a session (`AUTHENTICATION.md`), with
the API's error envelope.

| Method | Path | Purpose |
|-|-|-|
| GET | `/engine` | the engine as the application sees it (below) |
| POST | `/engine/restart` | a planned restart; from `failed` it retries the install or the start. Returns `/engine` once the process is spawned, without waiting for `ready`. `409 engine_attached` or `409 engine_stand_in` when there is nothing to restart |
| GET | `/engine/log` | `?lines=` (default 200, at most 1000): `{ lines }`, oldest first |

`GET /engine` keeps the fields it has today and adds the supervisor's:

```json
{
  "chainId": 1,
  "responseMode": "prepare",
  "simulated": false,
  "state": "ready",
  "since": "2026-09-26T09:14:03Z",
  "runner": "supervised",
  "version": "0.1.0",
  "pinnedVersion": "0.1.0",
  "unpinned": false,
  "install": null,
  "health": {
    "head": 23145870,
    "headTime": "2026-09-26T09:20:11Z",
    "lagBlocks": 0,
    "rpc": "ok",
    "cursors": [{ "name": "ingest", "block": 23145870, "ageSeconds": 3 }]
  },
  "restarts": { "last10Minutes": 0, "total": 1 },
  "lastExit": null,
  "problem": null
}
```

| Field | Meaning |
|-|-|
| `runner` | `supervised`, `attached` or `stand-in` |
| `install` | `{ bytes, total }` while `installing`, else null |
| `health` | from the last health answer: `head` is the ingest cursor's block, `headTime` is when that cursor last moved (now minus its `age_seconds`), `lagBlocks` is `observed_head` minus the ingest cursor. While the process is down, `head` and `headTime` are the `ingest` row of `api_v1.engine_status` (`block_number`, `updated_at`), cursors come from the same view, and the rest is null, so the health strip can say when the last block was processed (`OVERVIEW.md`). The block's own time reaches the browser with each `block` event (`LIVE-UPDATES.md`) |
| `lastExit` | `{ code, signal, at, reason }` of the last unplanned exit |
| `problem` | `{ code, message }` while `failed`, `restarting` or `unresponsive`: the engine's own message where it gave one |

`simulated` stays true exactly when `runner` is `stand-in`. State
changes also reach the browser as `health` events on the live stream
(`LIVE-UPDATES.md`). Restarts are logged at info level with the
username.

## Command line

| Command | Does |
|-|-|
| `tripwire start` | as today, and additionally installs, starts and supervises the engine |
| `tripwire engine status` | the pinned version; installed versions and whether each verifies; whether an engine is running (from `engine.pid`) and since when; the last 20 log lines. Works with the server stopped |
| `tripwire engine install [--from <dir>]` | downloads (or takes from a directory) the pinned release and verifies it, without starting anything |
| `tripwire engine log [-n <lines>] [--follow]` | prints the engine log |

Cursors and view schema state are `tripwire db status`'s
(`DATABASE.md`).

## What the application relies on from the engine

Each of these is part of the engine's published process contract; the
application depends on them and tests them in its checkpoint.

| # | Fact | Why the application needs it |
|-|-|-|
| G1 | The engine refuses to run while another engine holds the same database. The guard is a lease row in the database, renewed every 10 seconds, released on a clean stop and taken over only when 60 seconds stale; it is not session-scoped, so it holds under the transaction pooler (`DATABASE.md`). A refused start exits `70` | two engines on one database would evaluate and respond twice; the application's own locks cannot see an engine from another installation |
| G2 | `tripwire-engine verify --config <file>` loads the configuration, connects to the RPC and runs the startup checks without a database: the chain id, the receipts method, and, whenever `[chain] rpc_ws` is present, the pending-transaction subscription. It prints one JSON line `{ ok, chain_id, head, receipts, ws, problems: [{ code, message }] }` and exits 0, or `69` with problems. `chain_id` is the configured id; a node serving another chain is the problem `wrong_chain`, whose message names both ids. `head` is a block number with no time. `receipts` is `block_receipts` or `per_transaction`. `ws` is null without `rpc_ws`, else `{ ok, pending }`. A configuration the engine cannot load prints no JSON: it exits `78` with the reason on stderr | first run and Settings check an RPC endpoint before committing it; the application never talks to the chain itself. The application leaves `rpc_ws` out of the verify configuration when it does not want the WebSocket checked |
| G3 | Exit codes: `0` clean stop, `78` configuration refused (unknown key, invalid value, send mode without an unlocked signer), `65` database schema newer than this engine, `75` database unreachable, `69` RPC verification failed, `70` another engine holds the database; anything else, including `1`, is a crash | the supervisor restarts on what can recover by itself, waits on what will clear by itself, and stops on what needs a person, instead of looping on a bad configuration |
| G4 | The interface secret is written, atomically (staged and renamed, mode `0600`, reused across starts), and the control interface bound before the engine touches the database or the chain, and `GET /v1/health` answers `starting` until it is ready | the application reads the secret right after spawning and polls health from the first second |
| G5 | `--version` prints exactly the version the release is named by | the installer confirms the binary it verified is the version it pinned |

## Decisions

| # | Decision | Recommendation and reason |
|-|-|-|
| EN1 | When the engine is installed | At first start, not in a package install script. Install scripts are off by default in pnpm and in many CI and container setups, and a failure there leaves a half-installed package with no one to tell; at start, the dashboard shows progress and any failure |
| EN2 | How it is verified | A minisign signature over `SHA256SUMS` with the public key shipped in the package, then the binary's checksum, implemented on `node:crypto` with no dependency. Trust never depends on the download channel, which is what makes mirrors and offline installs safe |
| EN3 | Which version runs | Exactly the pinned one. The application is built against that release's contract files; a range of versions would be a range of untested interfaces |
| EN4 | Who writes `engine.toml` | The application, on every start, from `config.json`. One source of truth; the file is output, not configuration |
| EN5 | How secrets reach the engine | Through an allow-listed environment and `env:` references. The database URL, the RPC URLs and the key passphrase land in no file the application writes |
| EN6 | The control interface port | A free loopback port per start. Nothing but the application uses it, and a fixed port would collide between installations |
| EN7 | Restart policy | Backoff from one second to 60, without giving up on failures that can clear by themselves (database, RPC, crashes); a quiet fixed retry for a lease another engine left behind (`70`); `failed` for those that cannot (configuration, schema, installation), chosen by exit code |
| EN8 | A hung engine | Killed at 120 seconds of silence and restarted. An engine that does not answer is not protecting |
| EN9 | Orphans and doubles | `run.lock`, `engine.pid` and the engine's own guard. Two engines on one database is the worst failure available, so it gets three independent guards |
| EN10 | The stand-in | Opt-in only. A production install with no engine says so instead of simulating |
| EN11 | Applying configuration | Restart with an automatic return to the previous configuration. The engine only reads configuration at start, and a change it refuses must never leave an installation unprotected |
| EN12 | Unsupported platforms | Fail clearly and keep serving the dashboard. The engine publishes two Linux targets for now; guessing at others would run untested code |

## Checkpoint

The engine layer is done when, provably and repeatably:

1. A first start in an empty `TRIPWIRE_HOME` downloads the pinned
   release, verifies it and installs it while the dashboard is already
   served. A release with one byte of the executable changed, a
   `SHA256SUMS` with a changed line, and a signature made by another key
   are each refused with a message naming what failed, and nothing is
   installed. `install --from` applies the same checks.
2. On an unsupported platform the state is `failed` with the platform
   named, and the dashboard still serves.
3. With a chain configured, the start reaches `ready`. `engine.toml` is
   `0600` and contains neither the RPC URL nor the database URL; the
   engine's environment holds only the allow-listed variables.
4. `kill -9` of the engine restarts it, and it returns to `ready`
   within about 70 seconds, the new engine's exits `70` retried every
   10 seconds without raising "engine restarting repeatedly". Three
   kills within ten minutes raise "engine restarting repeatedly"
   exactly once, and the backoff is observed.
5. `SIGSTOP` of the engine gives `unresponsive` and "engine not
   responding" at 60 seconds, and a kill and restart at 120.
6. A configuration change the engine refuses (an RPC for another chain)
   rolls back: the previous configuration is restored, the engine is
   `ready` again on it, and the caller receives the engine's message. A
   configuration refused at start (exit `78`) is `failed` and does not
   loop.
7. With the server killed hard in external mode, the next start stops
   the orphaned engine before spawning its own, and at no moment do two
   engines run. A second engine started by hand against the same
   database is refused by the engine.
8. `SIGTERM` to the server stops the engine within 15 seconds at a whole
   block, and removes `engine.pid`.
9. An older pin against a database a newer engine has migrated is
   `failed` with the engine's message verbatim, and does not restart in
   a loop.
10. Without `TRIPWIRE_ENGINE=stand-in`, an installation with no chain is
    `unconfigured` and never simulated.
11. The log rotates at 10 MB keeping five files, `GET /engine/log`
    returns the requested tail, and a scan of every log file for the RPC
    URL, the database password and the key passphrase finds nothing.
