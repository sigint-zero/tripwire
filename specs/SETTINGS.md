# Settings

The Settings page: what it holds, which spec owns each section, and
the sections owned here: the chain and RPC endpoints, detection,
retention and the database readout. It also fixes how a change to the
engine's configuration is applied. `HIGH-LEVEL-SPEC.md` places the
area; `ENGINE.md` defines the configuration file these sections edit
and the engine states they report; `DATABASE.md` defines the database
modes.

## Terms

| Term | Meaning |
|-|-|
| engine setting | a value that lands in `engine.toml`: chain, RPC, detection, retention, response. The engine reads its configuration only at start, so changing one restarts the engine |
| application setting | a value only the application reads: accounts, tokens, channels, links. It takes effect at once |
| apply | saving an engine setting: write the configuration, restart the engine, confirm it came back |

## The page

One page at `/settings`, one column of sections, in this order. Each
section is specified where its subject is.

| Section | Holds | Owned by |
|-|-|-|
| Your account | the logged-in account and when its session ends, log out, its other sessions with revoke, change password (new password typed twice) | `AUTHENTICATION.md` (built) |
| Accounts | every account; add (password typed twice) and remove (confirmed in a dialog), the last-account guard | `AUTHENTICATION.md` (built) |
| AI agents | MCP tokens: label, owner, last used, expiry, revoke (confirmed in a dialog), create with the snippet shown once | `AUTHENTICATION.md`, `MCP-SERVER.md` (built) |
| Engine | state, version, restart, recent log lines | `ENGINE.md` |
| Chain and RPC | chain, RPC endpoints, polling interval | here |
| Detection | pending-transaction watching | here |
| Response | response mode, signing key, fee caps, submission route | `RESPONSES.md` |
| Keys | the keys Tripwire signs with: create, import, unlock, lock, where the files are | `RESPONSES.md` |
| Notifications | alert channels, dashboard link, outside heartbeat | `NOTIFICATIONS.md` |
| Retention | how long raw values and notifications are kept | here |
| Database | mode, target, schema versions | here |

The three account sections exist today; the page's description line
widens as sections land. Outside the page, the shell's top bar carries
the chain badge and the account menu (the username's initial, a link
to Settings, and Log out), so neither needs a visit here. Every
destructive action on the page (removing, revoking, deleting) is
confirmed in a dialog, as the built sections already do. A section whose data cannot be read (the
engine not running, the database down) says so in place and keeps the
rest of the page usable: Settings is where a person goes to fix
exactly those problems.

## Chain and RPC

| Field | Shown as | Editable |
|-|-|-|
| chain | name and id, such as "Ethereum (1)"; the same name the top bar's chain badge shows on every page | no |
| RPC endpoint (HTTP) | scheme and host, path and query masked: `https://eth-mainnet.example.org/••••` | yes, required |
| RPC endpoint (WebSocket) | same masking, or "not set" | yes, optional |
| polling interval | milliseconds, default 2000 | yes, 100 to 60000 |
| controller | the controller address for this chain and where it came from (known deployment, configured, none) | in `RESPONSES.md` |

**The chain is fixed.** An installation watches one chain
(`DATABASE.md`, DB9): every contract, rule, value and violation it has
recorded belongs to it. Changing chain is a new installation: a new
`TRIPWIRE_HOME`, or `tripwire db reset` followed by first run again.
The section says this under the chain name rather than offering a
control that would orphan the history.

**RPC endpoints are secrets.** Provider URLs usually carry an API key
in the path or query. The API never returns them in full, only the
masked form above, and the edit field starts empty: a person replaces
an endpoint, never reads it back. A value may be a literal URL or
`env:NAME`, in which case the section shows the variable's name and
whether it is set in the server's environment, never its value.

**Every endpoint change is verified before it is saved.** Saving runs
the engine's verify invocation (`ENGINE.md`, ask G2) against the
proposed configuration: the chain id must equal the installation's,
the node must serve receipts by one of the methods the engine knows,
and a WebSocket endpoint must accept a subscription when detection
needs one. The section shows the result as it comes back:

```
Chain id 1 matches.
Receipts: eth_getBlockReceipts.
Latest block 21,904,112, 4 seconds old.
```

A failed verification names each problem in the engine's words and
saves nothing. A passed one proceeds to apply.

**Polling interval** is how often the engine asks for a new head. The
field explains the trade: shorter notices blocks sooner and costs more
RPC calls. A value outside 100 to 60000 is refused as it is typed.

## Detection

Pending-transaction watching: evaluating rules against transactions
seen before they are mined, as an early warning beside the mined-block
path, which stays the guarantee.

| Field | Default | Rule |
|-|-|-|
| watch pending transactions | off | requires a WebSocket endpoint in Chain and RPC; without one the switch is disabled and says why |
| respond to pending violations | off | requires watching to be on; only meaningful when the response mode is `prepare` or `send` |

A violation seen in pending transactions is recorded with kind
`pending` and appears in Violations beside mined ones
(`VIOLATIONS.md`). With **respond** off, a pending violation is
recorded and notified only. With it on, it may start a response
exactly as a mined violation does, so a protective transaction can
land before the harmful one. The switch explains that trade in one
line: acting on a transaction that may never be mined is faster and
can be wrong. Turning watching on verifies the WebSocket endpoint
first, like an endpoint change.

## Retention

| Field | Default | Minimum |
|-|-|-|
| raw values | 90 days | 7 |
| notifications | 90 days | 7 (`NOTIFICATIONS.md`, N3) |

Raw per-block values older than the setting are summarised into hourly
buckets and the raw points removed; charts read the buckets beyond the
raw range without a seam (`RULES.md`). The engine never thins values a
rule still needs for its longest window, whatever the setting says, and
the section says so. Violations, responses and controller events are
kept for good; there is no setting for them. Notifications older than
the setting leave the feed; the application's own delivery records
follow `NOTIFICATIONS.md`.

## Database

A readout, not a form:

| Item | Shown |
|-|-|
| mode | local or external |
| target | local: the data directory; external: host, port and database, credentials never shown |
| application schema | shipped and applied migration versions |
| engine views | present or not |
| cursors | from `api_v1.engine_status`, with their age |

The same facts as `tripwire db status` (`DATABASE.md`). The mode is
chosen before the server starts, because the server's own pool and,
in local mode, the database itself live in the server process. To
change it, the section shows the steps: stop Tripwire, start it with
`--database-url` or `TRIPWIRE_DATABASE_URL` for an external server, or
edit `database` in the configuration file, then start again. History
does not move with the mode: the new database starts empty, and
`tripwire db backup` is how a local database is kept. The section says
so before anyone switches.

## Applying engine settings

The engine has no endpoint for configuration; it reads `engine.toml`
at start. Every section above that edits an engine setting, and the
Response section in `RESPONSES.md`, saves the same way:

1. **Validate** the change against the rules above. Invalid: `400`
   with every problem, nothing written.
2. **Verify** endpoint changes through the engine's verify invocation.
   Failed: `409 settings_rejected` with the engine's problems, nothing
   written.
3. **Write** `config.json` atomically (temporary file, then rename),
   keeping the previous file as `config.json.previous`.
4. **Restart** the engine with a freshly generated `engine.toml`
   (`ENGINE.md`).
5. **Confirm**: wait up to 60 seconds for the engine to report `ready`
   or `degraded`. Either counts as started.
6. **Roll back** if it does not start: restore `config.json.previous`,
   restart again, and answer `409 settings_rejected` with the engine's
   own error message and log lines, so the person sees why and the
   installation is back to watching.

While an apply runs, the section shows "Restarting the engine to apply
settings", and the engine state everywhere else (health strip,
Overview) reads `starting`. The engine resumes from its cursor, so no
block is skipped; the pause is a few seconds of later evaluation, not
of lost coverage. Violations recorded during the restart arrive when
it is back.

**One apply at a time.** An apply holds an in-process lock for its
whole run; a second request, from another tab or account, gets `409
settings_busy` and the dashboard shows who started the one running.
Every apply is logged at info level with the username and the names
of the fields changed, never their values.

Application settings (accounts, tokens, channels, links) do not
restart anything and are saved as their own specs say.

## API

All under `/api/v1`, requiring a session (`AUTHENTICATION.md`), with
the API's error envelope. No MCP tool reads or changes any of it.

| Method | Path | Purpose |
|-|-|-|
| GET | `/settings/chain` | `{ chainId, chainName, rpcHttp, rpcWs, pollIntervalMs }` with each endpoint as `{ masked, env, envSet }` |
| PUT | `/settings/chain` | `{ rpcHttp?, rpcWs?, pollIntervalMs? }`; an omitted endpoint is kept, `rpcWs: null` removes it. Verifies, then applies. `{ applied: true }`, or `400 invalid_settings`, `409 settings_rejected`, `409 settings_busy` |
| GET | `/settings/detection` | `{ enabled, respond, wsConfigured }` |
| PUT | `/settings/detection` | `{ enabled, respond }`; verifies the WebSocket endpoint when turning on, then applies |
| GET | `/settings/retention` | `{ pointsDays, notificationsDays }` |
| PUT | `/settings/retention` | same shape; applies |
| GET | `/settings/database` | `{ mode, target, appSchema: { shipped, applied }, engineViews, cursors: [{ name, block, updatedAt }] }` |

A `PUT` returns only once the engine is back on the new configuration
or rolled back to the old one. `409 settings_rejected` carries
`{ message, problems?, log? }`.

## Command line

| Command | Does |
|-|-|
| `tripwire config show` | prints `config.json` with endpoints and database URLs masked as the API masks them; `env:` references shown by name |
| `tripwire config set <path> <value>` | sets one field by its dotted path, such as `chain.pollIntervalMs 1000` or `retention.pointsDays 30`, after the same validation as the API |

`config set` works on the file directly, so it works with the server
stopped. It validates but does not verify endpoints, since verifying
needs the engine binary and the endpoint may not be reachable from
where the command runs; the engine verifies at its next start. When a
server is running, the command writes the file and says the change
takes effect at the next start, or now through the dashboard, which
verifies and applies it. `chain.chainId` is refused, for the reason in
Chain and RPC. RPC endpoints set this way are best given as `env:NAME`
so the value does not land in shell history.

## Decisions

| # | Decision | Recommendation and reason |
|-|-|-|
| ST1 | Apply by restart | Yes. The engine reads configuration only at start, and a restart resumes from its cursor with no gap. A runtime configuration endpoint would be a second path to the same state for a change made a few times in an installation's life |
| ST2 | Roll back a configuration the engine refuses | Automatically, to the previous file. The alternative leaves an installation that watches nothing until someone notices; a rollback keeps protection on and still shows the error |
| ST3 | Verify endpoints before saving | Through the engine, not the application. The application never talks to the chain, and the engine's own verification is the one that decides whether it will start |
| ST4 | Chain editable | No. History is bound to one chain; a new chain is a new installation, and the page says how |
| ST5 | Show RPC endpoints | Masked, replace-only. Provider keys in URLs are credentials; nobody needs to read one back to change it |
| ST6 | Database mode from the dashboard | A readout with instructions. The server's own connection and the local database live in the server process, so the switch can only happen across a restart of Tripwire itself |
| ST7 | Concurrent applies | One at a time, `409 settings_busy` for the rest. Two interleaved restarts could leave the file and the running engine disagreeing |
| ST8 | `tripwire config set` verifying | Validate only; the engine verifies at start. The command must work with no engine installed and from a shell that may not reach the endpoint |

## Checkpoint

Settings is done when, provably and repeatably:

1. A new RPC endpoint on the same chain verifies, applies, and the
   engine is `ready` on it within 60 seconds, with no gap in the
   ingest cursor across the restart.
2. An endpoint for another chain is refused at verification with the
   engine's message naming both chain ids, and `config.json` is
   byte-identical before and after.
3. A configuration the engine refuses at start (forced in a test) is
   rolled back: the previous file is restored, the engine is `ready`
   again, and the response carries the engine's error.
4. No API response, log line or `tripwire config show` output contains
   an RPC endpoint's path or query, or a database password.
5. Two applies started together: one runs, the other gets `409
   settings_busy`, and the file reflects exactly the first.
6. Detection cannot be turned on without a WebSocket endpoint, and
   respond cannot be on while watching is off, through the API and
   through `config set` alike.
7. Retention below 7 days is refused for both fields.
8. With the engine stopped, the page still loads, the account sections
   work, and the engine sections say the engine is not running.
