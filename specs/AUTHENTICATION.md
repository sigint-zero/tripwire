# Authentication

How the application decides who is talking to it. This covers the
dashboard, the local HTTP API, the event stream, the MCP server and the
command line. The engine has its own shared-secret channel with the
server and is out of scope here; users never talk to the engine directly.

## Why

The server binds to the loopback address by default, and the request
guard already blocks DNS rebinding, cross-origin writes and framing. That
is enough while the only browser is on the same machine. It stops being
enough the moment the port is reachable from anywhere else: a `--host`
other than loopback, a Docker port mapping (inside the container the
server still believes it is local), an SSH tunnel, a VPN or a reverse
proxy. Whoever reaches the port can then create rules, approve response
transactions and manage keys. None of those situations is detectable
from inside the process, so the server does not try to guess. Every
request that reads or changes Tripwire state proves who it is from.

Two kinds of caller, two credentials, and nothing else:

| Caller | Credential | Carried in | Opens |
|-|-|-|-|
| a person, in a browser or a script | username and password, exchanged for a session | an HttpOnly cookie | the dashboard and `/api/v1` |
| an AI agent | an MCP token, minted by a logged-in person | `Authorization: Bearer` | the MCP endpoint only |

A script that needs the API logs in the same way a browser does and
holds the cookie. There is no third credential.

## Principles

- **Always on.** Authentication does not depend on the bind address.
  The first thing a fresh installation does is create an account.
- **Host access is the root of trust.** Anyone who can read the data
  directory already owns the installation, so account recovery is a
  command run on the host, not an email flow.
- **No dependency on the engine or its database.** A user must be able
  to log in to see that the engine is down. Accounts, sessions and MCP
  tokens live in files under the application's own data directory.
- **Boring cryptography from the standard library.** Node's built-in
  `scrypt`, `randomBytes`, `timingSafeEqual` and `createHash`. No native
  modules, so the single-file bundle keeps installing with no
  dependencies.
- **Fail closed.** A route is protected unless it is on the short public
  list. Missing, expired or malformed credentials all produce the same
  answer. Each credential opens exactly one door: a session is refused
  at the MCP endpoint and an MCP token is refused everywhere else.

## Accounts

An installation has one or more local accounts. All accounts are equal.

| Field | Rule |
|-|-|
| username | 1 to 64 characters from `a-z 0-9 . _ -`, compared case-insensitively, unique |
| password | 12 to 1024 characters, any content; no composition rules |
| password hash | scrypt, `N=2^17, r=8, p=1`, 32-byte random salt, 32-byte key |

The hash is stored as one string, `scrypt$17$8$1$<salt-b64url>$<key-b64url>`,
so the parameters can be raised later and old hashes re-hashed on the
next successful login.

**First account.** While no account exists, the API answers
`GET /api/v1/auth/setup` with `{ "required": true }` and accepts one
`POST /api/v1/auth/setup` with a username and password. That call
creates the account and opens a session. Every later call to it answers
`409`. The dashboard's first-run flow is what normally makes this call;
`tripwire user add` does the same from the command line.

**Recovery.** `tripwire user passwd <name>` on the host sets a new
password without knowing the old one and ends that account's sessions.

## Sessions

A successful login mints a session: 32 random bytes, base64url encoded,
returned in the cookie. The server stores only the SHA-256 of the token
together with the account, creation time, last-seen time and the client
address and user agent that opened it. A leaked session file therefore
yields no usable credential.

| Property | Value |
|-|-|
| cookie name | `tripwire_session` |
| attributes | `HttpOnly; SameSite=Lax; Path=/`, plus `Secure` when the request arrived over TLS |
| browser lifetime | session cookie, no `Expires`; the server decides validity |
| idle expiry | 7 days since last seen |
| absolute expiry | 30 days since login |
| last-seen updates | at most once per 5 minutes per session, so a busy dashboard does not rewrite the file on every request |

Both expiries are settings (`[auth] session_idle`, `[auth] session_max`)
once the configuration file exists; until then they are constants.

`SameSite=Lax` rather than `Strict` because a link to the dashboard from
a chat alert must open logged in. Lax still withholds the cookie from
cross-site `POST`, and the request guard rejects cross-origin writes
independently, so state changes have two separate protections.

**Ending sessions.** Logout deletes the one session. Changing a password
deletes every other session of that account. The settings page lists an
account's sessions and can revoke any of them. All revocation is
immediate because every request looks the session up.

## MCP tokens

The MCP server is how AI agents reach Tripwire. An agent cannot type a
password, so a logged-in person mints a token for it. The token is the
agent's whole identity: it opens the MCP endpoint and nothing else, and
every MCP tool call is attributed to it.

| Property | Value |
|-|-|
| shape | `twm_` followed by 32 random bytes, base64url; the prefix makes a leaked token recognisable in logs and secret scanners |
| shown | once, at creation, in the dashboard or the terminal; never retrievable again |
| stored | SHA-256 of the token, with a label, the owning account, creation and last-used times, and an optional expiry |
| accepted at | the MCP endpoint only, as `Authorization: Bearer twm_…` |
| refused at | `/api/v1` and the dashboard, with the same `401` an anonymous request gets |
| lifetime | none by default; an expiry can be set at creation; revocable at any time |
| on account removal | all of that account's tokens are revoked |

There is one kind of token and no scopes. The MCP tool set is the scope:
inspect contracts, read the rule schema and templates, dry-run drafts,
create invariants, read violations. Invariants an agent creates land
disabled and are enabled by a person in the dashboard, so a leaked token
can draft but never arm.

**How the agent connects.** The MCP server runs inside the application
server at `/mcp` (streamable HTTP transport). An agent host that speaks
HTTP is pointed at that URL with the token as a bearer header. An agent
host that only launches local stdio servers runs `tripwire mcp`, a thin
bridge that reads the token from `TRIPWIRE_MCP_TOKEN` (or the `[mcp]
token` setting) and forwards to `/mcp`. Either way there is exactly one
place the token is checked.

Tool calls that create state record the token's label, which the
invariants list shows in its "created via MCP" badge, so a person can
tell which agent proposed what.

## Routes

All under `/api/v1/auth`. Bodies are JSON. Errors use the API's error
envelope with a stable `code`.

| Method | Path | Auth | Purpose |
|-|-|-|-|
| GET | `/setup` | none | `{ required: boolean }` |
| POST | `/setup` | none, only while no account exists | create the first account, open a session |
| POST | `/login` | none | `{ username, password }`; `204` with `Set-Cookie`, or `401 invalid_credentials` |
| POST | `/logout` | session | revoke this session, clear the cookie |
| GET | `/session` | session | `{ user: { id, username }, createdAt, expiresAt }`, or `401` |
| POST | `/password` | session | `{ currentPassword, newPassword }`; revokes other sessions |
| GET | `/sessions` | session | this account's sessions, current one flagged |
| DELETE | `/sessions/:id` | session | revoke one session of this account |
| GET | `/users` | session | list accounts (id, username, createdAt) |
| POST | `/users` | session | add an account |
| DELETE | `/users/:id` | session | remove an account, its sessions and its MCP tokens; refused for the last account and for yourself |
| GET | `/mcp-tokens` | session | all tokens: id, label, owner, createdAt, lastUsedAt, expiresAt; never the token |
| POST | `/mcp-tokens` | session | `{ label, expiresAt? }`; returns `{ id, token }` once |
| DELETE | `/mcp-tokens/:id` | session | revoke; open MCP connections using it are closed |

Login failures never say which half was wrong. When the username does
not exist the server still runs scrypt against a fixed dummy hash, so
timing does not reveal valid usernames either.

**Brute force.** Two limits on login, both returning `429` with
`Retry-After`:

- per account, persisted: after 5 consecutive failures each further
  attempt waits `2^(n-5)` seconds, capped at 60; a success resets the
  counter. Persisting it means a restart does not reset it.
- per client address, in memory: 20 login attempts per minute.

The MCP endpoint applies the per-address limit to requests carrying an
invalid token. Token comparison is a hash lookup, so guessing a 256-bit
token is not a practical concern; the limit exists to keep a
misconfigured agent from filling the logs.

Every login, failed login, logout, password change, token creation,
token revocation and rejected token is logged at info level with
username or token label and client address. Passwords and tokens never
appear in logs.

## What is protected

Everything under `/api/v1` requires a session, with these exceptions:

| Public | Why |
|-|-|
| `GET /api/v1/health` | liveness probes and the sidebar dot; it discloses nothing beyond `{ status }` |
| `GET /api/v1/auth/setup`, `POST /api/v1/auth/setup` | there is no account yet |
| `POST /api/v1/auth/login` | obviously |
| the dashboard's static files | the dashboard is the login page; its assets carry no data |

`/mcp` requires an MCP token and accepts nothing else. A request there
with a session cookie and no token is anonymous.

The event stream is protected like any other API route; browsers attach
the cookie to `EventSource` automatically.

An unauthenticated request to a protected route gets
`401 { code: "unauthenticated" }` and, for cookie callers, a cleared
cookie if one was sent. The server never redirects API calls to a login
page; the dashboard handles that.

## Storage

Three files in the application data directory (`TRIPWIRE_HOME`, default
`~/.tripwire`), all created mode `0600`, all written by serialising to a
temporary file and renaming over the original so a crash mid-write
leaves the previous version intact.

**`users.json`**, versioned:

```json
{
  "version": 1,
  "users": [
    {
      "id": "u_8f3k…",
      "username": "ops",
      "passwordHash": "scrypt$17$8$1$…$…",
      "createdAt": "2026-09-26T03:00:00Z",
      "passwordChangedAt": "2026-09-26T03:00:00Z",
      "failedLogins": 0,
      "lastFailedLoginAt": null
    }
  ]
}
```

Read fresh on every login, setup and account change, so a `tripwire
user` command run beside a live server takes effect on the next login
with no restart. Two writers racing on this file is last-write-wins; it
changes a handful of times in the life of an installation and both
writers are the same person, so no lock.

**`mcp-tokens.json`**, versioned, same read-fresh rule so `tripwire mcp
token` commands take effect on the agent's next request:

```json
{
  "version": 1,
  "tokens": [
    {
      "id": "t_2c9a…",
      "label": "agent host on laptop",
      "userId": "u_8f3k…",
      "tokenHash": "sha256:…",
      "createdAt": "2026-09-26T03:10:00Z",
      "lastUsedAt": "2026-09-26T03:42:00Z",
      "expiresAt": null
    }
  ]
}
```

**`sessions.json`**: the server's alone, loaded at start, held in
memory, flushed on every change. Expired rows are dropped at load and
once an hour.

## Transport

A password over plain HTTP is only acceptable on the loopback interface.
When the server is asked to bind anywhere else it requires one of:

- `--tls-cert <file> --tls-key <file>`: the server terminates TLS itself
  and marks cookies `Secure`;
- `--behind-proxy`: the operator runs a reverse proxy that terminates
  TLS. The server then trusts `X-Forwarded-Proto` for the `Secure` flag
  and `X-Forwarded-For` for the client address used in logs and rate
  limits. Without this flag those headers are ignored.

With neither, a non-loopback `--host` is refused at startup with a
message saying which of the two to add. This is the one place the bind
address matters to authentication. The same rule protects MCP tokens,
which travel in a header on every agent request.

## Command line

`tripwire user` operates on `users.json` directly, so it works with the
server stopped and is the recovery path.

| Command | Effect |
|-|-|
| `tripwire user add <name>` | prompts for a password twice, creates the account |
| `tripwire user passwd <name>` | sets a new password, ends the account's sessions |
| `tripwire user remove <name>` | deletes the account, its sessions and its tokens; refused for the last one |
| `tripwire user list` | usernames and creation dates |
| `tripwire user unlock <name>` | clears the failure counter |

Passwords are read from the terminal with echo off, or from
`TRIPWIRE_PASSWORD` for scripted installs, never from an argument where
they would land in shell history.

`tripwire mcp` serves agents:

| Command | Effect |
|-|-|
| `tripwire mcp token new <label> [--expires <duration>] [--user <name>]` | mints a token, prints it once with a ready-to-paste agent configuration snippet |
| `tripwire mcp token list` | labels, owners, created and last-used times |
| `tripwire mcp token revoke <id or label>` | revokes |
| `tripwire mcp` | the stdio bridge for agent hosts that launch local servers; needs `TRIPWIRE_MCP_TOKEN` and a running server |

## Dashboard

- On load the app calls `GET /auth/setup`, then `GET /auth/session`.
  Setup required sends it to the first step of `/setup`, which is
  account creation. No session sends it to `/login`, remembering the
  requested path in a `redirect` query parameter that is only honoured
  when it is a same-origin path.
- `/login` sits outside the navigation shell, like `/setup`.
- Any `401` from any query clears the query cache and returns to
  `/login`. The sidebar server dot keeps polling `/health`, which does
  not need a session, so "server unreachable" and "logged out" stay
  distinguishable.
- Settings gains an Account section (change password, active sessions
  with revoke, accounts with add and remove) and an AI agents section:
  MCP tokens with label, owner, last used, revoke, and a create dialog
  that shows the new token once beside the agent configuration snippet
  for the HTTP and stdio cases.

## Decisions

| # | Decision | Recommendation and reason |
|-|-|-|
| AU1 | Auth on loopback too | Yes, always on. Port mappings and tunnels make "local" undetectable; a login on first visit is a small price |
| AU2 | Password hash | scrypt from `node:crypto`. Argon2id would be marginally better but needs a native module, which breaks the dependency-free bundle |
| AU3 | Session storage | opaque random token, hash stored server-side in a file. Real revocation and a session list, no signing key to manage, survives restarts |
| AU4 | Where accounts live | files in the data directory, not the database. Login must work with the engine and database down, and the server never writes that database |
| AU5 | Cookie SameSite | Lax. Strict breaks links from alerts; writes are already origin-checked |
| AU6 | Plain HTTP off loopback | refused unless TLS or a declared proxy. Anything else ships passwords and tokens in the clear by default |
| AU7 | HTTP Basic instead of a login form | No. Browsers cache Basic credentials with no way to log out, and the password would travel on every request |
| AU8 | General API tokens for scripts | None. Scripts log in like a browser. One credential per kind of caller keeps the surface small; if a real need appears it is a separate decision |
| AU9 | MCP token scopes | one kind, no scopes. The tool set is the scope and agent-created invariants land disabled, so the human gate does the work scopes would |
| AU10 | Where MCP tokens are checked | only at `/mcp`, and sessions are refused there. Each credential opens one door, so a token found in an agent's config cannot be replayed against the API |
| AU11 | Roles | none; all accounts equal. Can follow if asked for |
| AU12 | Second factor | not in this version. TOTP is the natural addition and nothing here precludes it |

## Implementation notes

Server side this is one module, `packages/server/src/auth/`, with a
file store, password hashing, session handling, MCP token handling, the
routes and two hooks: `requireSession`, which the API plugin registers
before its routes with the public list as a set of exact paths, and
`requireMcpToken`, which the MCP endpoint registers. Cookie parsing is a
dozen lines; no library is needed for it.

Tests, all against a server in memory with a temporary data directory:
setup works once and then answers `409`; login succeeds, fails with an
unrevealing error, and runs the dummy hash for unknown users; the fifth
failure starts the delay and a success clears it; protected routes
answer `401` without a cookie, with a bad cookie, with an expired
session, and with a valid MCP token; the public list answers without
one; `/mcp` answers `401` with a session cookie and `200` with a token;
a revoked or expired token is refused on the next request; removing an
account removes its tokens; logout and password change revoke as
specified; cookie attributes are exactly as listed; files are created
`0600` and a torn write leaves the previous file readable; the CLI
commands round-trip against the same files.
