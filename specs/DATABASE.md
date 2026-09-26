# Database

How the application provides, reaches and shares the one database that
it and the engine both use. Two halves: what the engine expects of
the database it is given, and what the application owns in that
database, including the migrations it runs itself. `HIGH-LEVEL-SPEC.md` places this; `AUTHENTICATION.md` explains
why accounts are not in here.

## Summary

- One PostgreSQL database per installation. The application provides it:
  either the owner's own server, reached by a URL, or a local database
  the application brings up itself. The engine only ever receives a URL.
- Three schemas, each with one owner. `engine` and `api_v1` are the
  engine's and the engine migrates them. `app` is the application's and
  the application migrates it, with a migration runner of its own that
  ships inside the server package.
- The application reads `api_v1`, writes `app`, and touches nothing
  else. Every identifier it sends is schema-qualified.
- Accounts, sessions, MCP tokens and alert-channel secrets stay in
  files (`AUTHENTICATION.md`, `NOTIFICATIONS.md`). Everything else the
  application remembers lives in `app`.

## The engine's side of the contract

The engine is a black box behind two things: its local control
interface and the views below. This section states what the
application relies on at that boundary.

### What the engine takes

One connection URL, in its configuration file under `[database] url`,
plus a pool cap `[database] max_connections`. The application writes
that file on every start from its own configuration, so the two
processes always agree on the target. The engine states its
requirements in its own documentation and checks them loudly at
startup:

| Requirement | Meaning for the application |
|-|-|
| PostgreSQL wire protocol | the local database must speak it; a driver that only offers an in-process API is not enough |
| a database where the engine's user may create schemas and tables | the application checks this itself before spawning the engine, so the owner sees one clear message instead of an engine crash |
| PostgreSQL 14 or later | the minimum the engine states in its view reference (`postgres_min_major`); the external-mode pre-flight checks it before the engine is spawned |
| at least one connection | the engine is fully correct at a budget of one connection, and the application relies on that in local mode |

### What the engine does at startup

Connect, read its recorded schema version, migrate forward, open its
pool. The engine refuses to start against a schema newer than itself
and names the engine version that schema requires. Consequences:

- On the very first start the views do not exist until the engine has
  run its migrations. The application's read layer treats a missing
  `api_v1` schema as the state "engine has not initialised the database
  yet" and reports it as such, rather than as an error.
- Downgrading the pinned engine release after the schema has moved on
  is refused by the engine. The application surfaces that refusal
  verbatim on the status screen and in the CLI.

### Ownership

| Schema | Contains | Migrated by | Written by | Read by the application |
|-|-|-|-|-|
| `engine` | the engine's tables | engine | engine | never |
| `api_v1` | the read views | engine | nobody | yes, all reads |
| `app` | the tables in this document | application | application | yes |

The single crossing point is the application reading `api_v1`. There
are no foreign keys across schemas in either direction: an `app` row
that refers to an engine object stores its id as a plain number and
tolerates the object disappearing (see Sweeping).

### The views

Plain names inside the versioned schema. Within `api_v1` a view only
ever gains columns; a breaking reshape arrives as `api_v2` beside the
old schema, and the application moves over in a release of its own.
The application therefore names the columns it selects and pins the
view reference the engine publishes with each release.

| View | Read by | For |
|-|-|-|
| `contracts` | Overview, Contracts, Rules wizard, MCP `list_contracts` and `get_contract` | registered contracts with rule counts |
| `rules` | Rules, Contract detail, Overview counts, MCP `list_rules` | rule documents with state (`enabled`, `warming`, `last_evaluated_block`) |
| `violations` | Violations, Rule detail, Contract detail, Overview | firings and evaluation errors with evidence |
| `series`, `series_points` | Rule detail charts, Overview mini charts | recorded values by series and time range (`RULES.md`) |
| `series_rollups` | Rule detail charts | hourly summaries of points older than the engine's raw retention |
| `rule_series` | Rule detail charts, Overview mini charts | which series each rule reads, by role (`read` or `metric`) and path in the document (`RULES.md`) |
| `trip_state` | Overview, Contracts, Contract detail | what is paused now, by the controller or by a rule's confirmed call (`ACTIVITY.md`) |
| `controller_events` | Activity, response readiness | the controller's history: trips, resets, registration, operators, guardianship (`ACTIVITY.md`, `RESPONSES.md`) |
| `responses` | Responses, Activity | the approval queue and response history (`RESPONSES.md`) |
| `actions` | Activity, Contract detail | pauses and unpauses a person asked the engine for by hand, with their transactions (`RESPONSES.md`, `ACTIVITY.md`) |
| `notifications` | Notifications, the notification dispatcher | the engine's notification record: the feed, and what the application delivers (`NOTIFICATIONS.md`) |
| `engine_status` | health strip, Settings, `tripwire db status` | one row per cursor with `updated_at`; readable while the engine is down, which is how the dashboard tells "stale" from "stopped" |

Rule documents come back as `jsonb`. The application never rewrites a
document it read; edits go through the control interface, which
re-validates and re-renders the description.

## Disabling rules and contracts

There is one switch: each rule's `enabled`, which the engine stores.
Disabling a contract is a batch over that switch, carried out by the
application; the engine has no contract-level flag.

A disabled rule:

| Thing | Behaviour |
|-|-|
| evaluation | none: no values recorded, no violations, no responses, no notifications |
| the rule itself | unchanged; enabling it again picks up the same document |
| history | kept; charts show a gap for the disabled period |
| responses already awaiting approval | stay in the queue for the person to decide |
| edits | allowed; they take effect once it is enabled |
| rules with a metric | re-enter warm-up on enabling when their window spans the gap (the engine decides when the window is covered again), so a stale window never trips |

**Disabling a contract** disables every currently enabled rule on it in
one batch call to the engine, and records the ids of exactly those rules
in `app.contract_disables`. **Enabling the contract** enables those
recorded rules that are still disabled, in one batch call, and deletes
the record. Rules that were already off before stay off, which is the
point of recording the set. While the record exists:

- the contract shows as disabled in the dashboard and as
  `active: false` to agents;
- a rule enabled by hand runs, and is simply not in the set;
- a new rule created from the dashboard starts disabled, so a disabled
  contract stays quiet until someone enables it;
- trip state and controller events keep being mirrored, because they
  are on-chain facts, not evaluations.

New contracts start enabled. New rules start enabled from the dashboard
and disabled from an agent (`MCP-SERVER.md`). Every switch is a
dashboard action; no MCP tool can flip either.

## Modes

The application runs the database in one of two modes, chosen before
the server first starts (`FIRST-RUN.md`) and shown in Settings, where
changing it takes effect at the next start of Tripwire (`SETTINGS.md`).

| Mode | Database | Who provisions | Typical owner |
|-|-|-|-|
| `external` | the owner's PostgreSQL, reached by URL | the owner | a team with a database already |
| `local` | PGlite under the data directory, served over the wire protocol through a pooler the application runs | the application | one person, one machine, zero setup |

Whichever mode, the rest of the application sees a URL and a small set
of facts about the connection. Provisioning is one module
(`packages/server/src/db/provision.ts`) with two implementations
behind the same interface, and swapping the local engine for a
different one later changes nothing outside that module.

### External mode

The owner supplies a URL. Accepted forms are the standard
`postgres://` and `postgresql://` URLs with query parameters, including
`sslmode` and `host=/path` for Unix sockets. The application passes the
URL through unchanged to the engine, so both drivers must accept it;
the application's pre-flight check connects with its own driver, and
the engine's own startup check covers the other.

Pre-flight, run before the engine is spawned and again by
`tripwire db status`:

| Check | On failure |
|-|-|
| connect | `database_unreachable`, with the resolved host and database and the credentials redacted |
| `has_database_privilege(current_user, current_database(), 'CREATE')` | `database_underprivileged`, naming the grant to run |
| server major version at or above the minimum the pinned engine release states | `database_too_old`, naming both versions |
| the `app` schema, if present, is not newer than this application (see Migrations) | `app_schema_newer` |

The owner keeps their own backups, roles and retention of the server.
The application documents, once, the least-privilege setup: one role
that owns the database and is used by both processes, and optionally a
second role with `SELECT` on `api_v1` only for dashboards such as
Grafana; the application creates no roles.

### Local mode

The application brings up PGlite, a PostgreSQL build that runs inside
the Node process, persisted to `TRIPWIRE_HOME/db/data`, and serves it
over the wire protocol through a pooler it runs in the same process.
Both clients go through that pooler: the engine by construction, and
the application itself, whose pool connects to the pooler like any
wire-protocol client instead of calling the in-process API. One access
path to the database, one place where serialisation happens.

| Item | Value |
|-|-|
| data directory | `TRIPWIRE_HOME/db/data`, mode `0700` |
| endpoint on Linux and macOS | Unix socket `TRIPWIRE_HOME/db/sock/.s.PGSQL.5432`; URL `postgres:///tripwire?host=TRIPWIRE_HOME/db/sock` |
| endpoint on Windows | `127.0.0.1` on a free port picked at start; URL recorded in `TRIPWIRE_HOME/db/endpoint.json` (`0600`) for the CLI |
| lock | `TRIPWIRE_HOME/db/lock`, created exclusively with the holder's pid; a stale lock (pid gone) is replaced, a live one is refused with "database in use by process N" |
| pooler | in-process, transaction-boundary: it owns PGlite's one session and leases it to one client transaction at a time |
| engine pool | `max_connections = 1`, connected to the pooler |
| application pool | 1 connection, connected to the pooler |

PGlite is a single-session database; the pooler is what lets one
session serve two processes. It leases the session to one client
transaction at a time, so a statement from one client never runs
inside another client's open transaction. The pooler's contract:

| Situation | Pooler behaviour |
|-|-|
| a client sends its first message while the session is free | the client takes the lease |
| the session is leased | other clients' messages wait in arrival order |
| the database reports the session idle (`ReadyForQuery` with status `I`) | the lease ends; the next waiting client takes it |
| a transaction is open or failed (status `T` or `E`) | the lease is held until the client commits or rolls back |
| a client disconnects while holding the lease | the pooler issues `ROLLBACK` before the next lease |
| a leased transaction sits idle for 30 seconds | the pooler rolls it back and disconnects that client, so a stuck client can never stall the engine's block writes |
| a client uses the unnamed prepared statement after another client's Parse replaced it | the pooler replays that client's own last unnamed Parse first, then passes its message on; the replayed `ParseComplete` is not forwarded, since the client already had it. A driver may Parse in one lease and Bind in the next, and the session has only one unnamed statement to share |
| a simple query runs | the unnamed statement is gone, as PostgreSQL defines; the next client to use its own is replayed as above |

The pooler does not reset the session between leases, so anything
session-scoped one client leaves behind (a setting, a named prepared
statement, a temporary table) is seen by the other. The one exception
it manages is the unnamed prepared statement, above, which drivers use
for every parameterised query. That is why both processes keep nothing
session-scoped (E5 for the engine), and why the application follows
four rules whenever it talks to the
local database. They cost nothing in external mode, so they are simply
the rules:

1. Every identifier is schema-qualified. No `search_path`, no
   session-level `SET` of any kind; a per-statement need uses
   `SET LOCAL` inside the transaction that needs it.
2. Transactions are short: a handful of statements, no waiting on
   anything outside the database while one is open.
3. Reads are bounded: every chart and list query has a limit, and a
   `SET LOCAL statement_timeout` of a few seconds.
4. No named prepared statements, no `LISTEN`, no `COPY`.

The checkpoint at the end proves the one property the application
cannot take on faith: that the pooler serialises whole
transactions. A statement from one client, issued while another
client holds a transaction open, must wait until that transaction
ends; it must never run inside it. Without that, an application read
could land inside the engine's block write, or an application
rollback could undo engine rows. The pooler is the application's own,
a small module in the server package that speaks the wire protocol to
the clients and PGlite's protocol interface inward, because PGlite's
socket server does not say it holds to transaction boundaries. Only if
PGlite itself cannot hold up does local mode move to an embedded
PostgreSQL server (decision DB1); either way the provisioning module is
the only code that changes.

The Unix socket path is not authenticated; it is protected by the
`0700` directory, which is the same protection the data directory has.
The Windows loopback port is reachable by any local process, and the
documentation says so; an owner who needs isolation from other local
users chooses external mode.

## Configuration

The application's configuration file is `TRIPWIRE_HOME/config.json`,
mode `0600`, created by first run. This document defines its
`database` member; `ENGINE.md` defines the members the engine's
configuration is generated from (`chain`, `response`, `retention`,
`mempool`).

```json
{
  "version": 1,
  "database": { "mode": "local" }
}
```

```json
{
  "version": 1,
  "database": { "mode": "external", "url": "env:TRIPWIRE_DATABASE_URL" }
}
```

`url` is either a literal URL or `env:NAME`, resolved from the
environment at start. Precedence at start:
`--database-url` on the command line, then `TRIPWIRE_DATABASE_URL` in
the environment, then the file; the first two force external mode for
that run without rewriting the file.

The application writes `TRIPWIRE_HOME/engine.toml` on every start
(`ENGINE.md` shows the whole file). Its database part, in local mode:

```toml
[database]
url = "env:TRIPWIRE_DATABASE_URL"
max_connections = 1
```

In external mode the `url` line is the same and `max_connections` is
omitted, leaving the engine's default. The application resolves the
URL and places it in the engine's environment when it spawns it, using
the engine's own `env:` form, so the URL and its password are written
into no file the application creates.

## Start and stop

Order matters, because the engine cannot reach a database that is not
up yet, and in local mode the database cannot go down before the
engine has.

Start:

1. Load configuration, resolve the URL or take the lock and open the
   local database, start the pooler.
2. Pre-flight (external) or a `select 1` through the pooler (local).
3. Apply the application's migrations (below).
4. Listen. The dashboard is served from here.
5. In the background: install the engine if needed, write
   `engine.toml`, run the engine's migrations, spawn it and begin
   polling its health (`ENGINE.md`, Start). Until the engine reports
   ready, the dashboard shows its state and reads that need `api_v1`
   answer "engine starting".

Stop, on `SIGINT` or `SIGTERM`:

1. Stop accepting requests, finish in-flight ones with a short bound.
2. Signal the engine, wait for it to exit (bounded, then kill).
3. Close the application pool.
4. Local mode: stop the pooler, close PGlite, release the lock.

The engine exiting on its own does not stop the database: the
supervisor restarts the engine (`ENGINE.md`), and the dashboard keeps
serving what `api_v1` holds.

## The `app` schema

Everything the application remembers that is not a credential. The
tables are small and grow slowly; they exist so a restart, a second
server process, or a CLI command all see the same state.

Conventions follow the engine's so the two halves read alike: `bigint`
identity keys, `timestamptz`, lowercase text addresses, `jsonb` for
documents.

### Tables (migration 0001)

`app.migrations`: the runner's ledger.

| Column | Type | Notes |
|-|-|-|
| version | integer PK | the file's number |
| name | text | the file's name |
| checksum | text | SHA-256 of the file as shipped |
| applied_at | timestamptz | |

`app.settings`: key and value, for settings too small for a table.

| Column | Type | Notes |
|-|-|-|
| key | text PK | |
| value | jsonb | |
| updated_at | timestamptz | |

Keys defined so far:

| Key | Value | Used by |
|-|-|-|
| `dashboard.pinned_rules` | ordered array of rule ids | Overview mini charts |
| `mcp.submissions_per_hour` | integer, default 50 | the MCP volume guard |
| `notifications.dashboard_url` | text, unset by default | links in alert messages |
| `notifications.heartbeat_url` | text, unset by default | the outside heartbeat |
| `notifications.dispatch_since` | timestamp, set on first start | notifications before it are shown, never sent |
| `setup.dismissed` | boolean, default false | the Overview's setup checklist, closed before every step was done (`FIRST-RUN.md`) |

`app.rule_prefs`: how a rule is shown, which the engine has no reason
to know.

| Column | Type | Notes |
|-|-|-|
| rule_id | bigint PK | an `api_v1.rules` id, no foreign key |
| display_decimals | integer null | scale the raw value is divided by for display |
| display_unit | text null | suffix shown after the value |
| updated_at | timestamptz | |

`app.rule_submissions`: every rule an MCP token stored, for the
permanent "Via <token label>" badge and the volume guard.

| Column | Type | Notes |
|-|-|-|
| id | bigint identity | |
| rule_id | bigint | the created rule |
| token_id | text | from `mcp-tokens.json`; kept after the token is revoked |
| token_label | text | copied at submission time so the badge survives revocation |
| submitted_at | timestamptz | indexed with token_id: the guard counts rows in the trailing hour |

`app.notification_reads`: which in-app notifications have been
marked read; one state shared by all accounts, which are equal
(`AUTHENTICATION.md` AU11).

| Column | Type | Notes |
|-|-|-|
| source | text | `engine` for an `api_v1.notifications` row, `app` for an `app.local_notifications` row; PK with notification_id |
| notification_id | bigint | |
| read_at | timestamptz | |

Four more tables carry notification delivery and are specified with it
in `NOTIFICATIONS.md`: `app.channels`, `app.local_notifications`,
`app.dispatches` and `app.deliveries`.

`app.violation_acks`: violations a person has acknowledged; the
Overview's "open violations" is `api_v1.violations` minus this table.

| Column | Type | Notes |
|-|-|-|
| violation_id | bigint PK | an `api_v1.violations` id |
| acknowledged_by | text | account id from `users.json` |
| note | text null | |
| acknowledged_at | timestamptz | |

`app.contract_disables`: contracts a person has disabled, with the
rules that action switched off, so enabling the contract restores
exactly those.

| Column | Type | Notes |
|-|-|-|
| contract_id | bigint PK | an `api_v1.contracts` id |
| rule_ids | bigint[] | the rules this action disabled |
| disabled_by | text | account id from `users.json` |
| disabled_at | timestamptz | |

`app.contract_sources`: verified source fetched when a contract was
added, served to agents by `get_contract` and shown in Contract detail.
The ABI itself goes to the engine at registration and is read back
from `api_v1.contracts`; only the source lives here.

| Column | Type | Notes |
|-|-|-|
| address | text PK | lowercase |
| verified | boolean | |
| compiler | text null | |
| implementation | text null | the resolved implementation address for a proxy |
| files | jsonb | array of `{ path, content }`; total capped at 2 MB per contract |
| fetched_from | text | the verifier consulted |
| fetched_at | timestamptz | |

### Sweeping

Because nothing is enforced across schemas, rows can outlive the
engine object they name. Once a day and at start, the application
deletes `rule_prefs` and `rule_submissions` rows whose `rule_id` is
absent from `api_v1.rules`, `violation_acks` rows absent from
`api_v1.violations`, `contract_disables` rows absent from
`api_v1.contracts`, `notification_reads` and `dispatches` rows whose
notification is absent from `api_v1.notifications` or
`app.local_notifications`, and `contract_sources` rows absent from
`api_v1.contracts`, and prunes `dashboard.pinned_rules` the same way.
The volume guard is unaffected: it counts the trailing hour, and a
rule deleted within the hour still counted when it was stored.

## Migrations the application runs

The application migrates the `app` schema itself, on every start,
before the engine is spawned. The runner is part of the server package
and is about a hundred lines; it has no dependency beyond the driver.

| Rule | Detail |
|-|-|
| files | `packages/server/migrations/NNNN_name.sql`, four digits, contiguous from `0001`, bundled into the CLI executable |
| one transaction each | a file runs inside one transaction; a failure rolls it back and stops the start with the file name and the database's message |
| serialised | each file's transaction starts with `pg_advisory_xact_lock` on a fixed key, then re-reads the ledger and skips the file if another process applied it meanwhile. A transaction-scoped lock is released with its transaction, so it cannot be held across files and is safe behind the pooler; a session lock would outlive the lease |
| ledger | `app.migrations`; `0001` creates the schema and the ledger together |
| never edited | an applied file's checksum must match the shipped file, else `migration_altered` and the start stops; changes are new files |
| forward only | there are no down migrations; a release that must undo something ships a new file that does |
| newer schema | a ledger version above the highest shipped file means a newer application wrote it; the start stops with `app_schema_newer` naming both versions, the mirror of the engine's own guard |
| schema-qualified | every statement names `app.`; the runner never sets `search_path` |
| SQL only | plain SQL files, so a reviewer reads exactly what will run |

Ordering with the engine's migrations is a non-issue by construction:
the two schemas do not reference each other, so either side may
migrate first, and a start where the engine is absent still leaves the
`app` schema current.

## Command line

Under `tripwire db`:

| Command | Does |
|-|-|
| `status` | mode, resolved target with credentials redacted, application migration version (shipped and applied), engine view schema present or not, cursors from `api_v1.engine_status` with their age |
| `migrate` | applies pending application migrations without starting the server; what `start` does anyway, for owners who want to see it happen |
| `backup <file>` | local mode only: refuses while the lock is held, then writes a tarball of the data directory; external owners use their server's tools |
| `restore <file>` | local mode only, same refusal; replaces the data directory after confirmation |
| `reset` | local mode only, same refusal; deletes the data directory after typed confirmation. Everything the engine recorded is gone |

Every command that opens the local database takes the lock like the
server does, so a command and a running server never open the data
directory at once.

## Development

The fixture backend of the read layer stays for the development
stand-in (`ENGINE.md`) and for tests. The Postgres backend is the one
described here. CI exercises it against a local-mode database that the
pinned engine release has migrated with `tripwire-engine migrate`
(E1 below), so view queries are tested against the real views with no
chain and no RPC. The engine's migrations stay inside its
binary; the application never ships or replays them.

## What the application relies on from the engine

Capabilities this document relies on at the engine boundary, beyond
the URL and the views above. Each is part of the engine's published
interface.

| # | Fact | Why the application needs it |
|-|-|-|
| E1 | `tripwire-engine migrate --config <file>` migrates the database and exits without touching the chain, printing the schema version; a refusal exits with the same codes as a start (`ENGINE.md`, G3) | CI tests the read layer against the real views; `tripwire db status` can offer "migrate the engine schemas now" |
| E2 | The view reference states the minimum PostgreSQL major version (`postgres_min_major`, 14) | the external-mode pre-flight names it before the engine is spawned |
| E3 | A disabled rule behaves as in "Disabling rules and contracts" above, and `POST /v1/rules/enabled` takes many rule ids and applies them in one transaction | disabling a contract is a batch, and a half-applied batch would leave a contract partly watched |
| E4 | The view reference (`views.json`) lists, per view, the columns and their types, and the shapes of its `jsonb` payloads | the application selects columns by name and its types are written against that file |
| E5 | The engine is fully correct when its connection is served by a transaction-boundary pooler: it keeps no session state, runs every query as an unnamed statement and caches none, takes its migration lock per transaction, and uses no `LISTEN`/`NOTIFY` | in local mode both processes share PGlite's one session through the pooler, which hands the session over at transaction boundaries |

## Decisions

| # | Decision | Recommendation and reason |
|-|-|-|
| DB1 | Local database engine | PGlite behind a transaction-boundary pooler of the application's own that both processes connect through. It installs with the package, needs no download and no child binary, and the engine already guarantees correctness at one pooled connection for exactly this case. The fallback, taken only if PGlite itself fails the proof, is an embedded PostgreSQL server; the provisioning module is the only code that changes |
| DB2 | One URL for both processes | Yes. The application holds one credential and hands the same one to the engine. A split into a writer and a read-only role is documented for owners who want it, and the application does not need it to keep to its schema: the boundary is enforced by code review and by the test that rejects any query text naming `engine.` |
| DB3 | Where credentials live | Files, per `AUTHENTICATION.md` AU4. Login must work with the database down, and a CLI command must be able to add a user beside a running server without contending for the local database's one session |
| DB4 | Own migration runner | A hundred lines of SQL-file runner instead of a migration library. The schema is thirteen tables; a library would be the largest dependency in the server for the least work |
| DB5 | Cross-schema foreign keys | None. A key from `app` into `engine` would tie the application's schema to the engine's private tables and block the engine's cascades. Orphans are swept instead |
| DB6 | Where the ABI lives | With the engine, once, at registration; the application keeps verified source only. The engine decodes evidence and needs the ABI; the application does not need a second copy |
| DB7 | Unix socket versus loopback in local mode | Unix socket where the platform has one: protected by the directory mode, unreachable from other users, and the pooler offers no TLS or password. Loopback only on Windows, documented as reachable by local processes |
| DB8 | Statement timeout on reads | Yes, a few seconds, set per transaction. In local mode a slow chart query holds the engine's only session; bounded reads keep the block write on time |
| DB9 | Chain id in `app` tables | None. An installation watches one chain, as the engine's configuration does; contracts are keyed by address alone |

## Checkpoint

The database layer is done when, provably and repeatably:

1. First run in local mode with an empty data directory brings up the
   database, applies `0001`, spawns the engine, and the dashboard reaches
   "ready"; a second start applies nothing and reports the same
   versions.
2. External mode against an empty database passes pre-flight, migrates
   `app`, and the engine migrates its own schemas; against a database
   without `CREATE` privilege the start stops before the engine is
   spawned, naming the grant.
3. Isolation in local mode: client A begins a transaction and inserts
   a row; client B, concurrently, inserts and commits a row of its
   own; A rolls back. B's statement waited for A's transaction to end,
   B's row is present and A's is not. Only PGlite itself failing this
   flips DB1. The same run proves the contract's edges: a client
   killed mid-transaction leaves no open transaction for the next
   lease, a transaction left idle for 30 seconds is rolled back while
   the other client proceeds, and a client that parses the unnamed
   statement, loses the lease to another client's Parse, and then
   binds it gets its own statement's result.
4. A shipped migration file altered after being applied stops the
   start with `migration_altered`; a ledger version above the shipped
   set stops it with `app_schema_newer`.
5. Every read the dashboard makes is answered from `api_v1` views by
   name, and a test that scans the server's SQL for `engine.` finds
   nothing.
6. `tripwire db status` reports correctly in all four states: no
   database, database without views, views present and engine stopped,
   engine running.
7. Stop order holds: on `SIGTERM` with the engine mid-block, the engine
   exits first and the local database closes cleanly, and the next
   start finds the cursor at a whole block.
