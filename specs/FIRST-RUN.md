# First run

How a fresh installation goes from nothing to watching its first
contract: the guided flow in the dashboard at `/setup`, and the same
setup from the command line for machines with no browser.
`HIGH-LEVEL-SPEC.md` places the area; `AUTHENTICATION.md` owns the
account step; `SETTINGS.md` owns the chain step's fields and how they
are applied; `ENGINE.md` owns installing and starting the engine;
`CONTRACTS.md`, `RULE-WIZARD.md` and `NOTIFICATIONS.md` own the forms
the later steps reuse.

## Principles

- **Only what watching needs is required.** An account, because
  everything else sits behind it, and a chain with an RPC endpoint,
  because the engine cannot start without one. Everything after that
  can be skipped and done later in its own page.
- **Nothing new to learn.** Each later step is the same form as its
  page elsewhere, so what a person learns in setup is what they use
  afterwards.
- **No waiting in silence.** The engine download and first start show
  their progress; a failure says what failed and what to do.
- **Response is not part of setup.** Watching needs no keys and no
  on-chain changes. On-chain response is a separate, deliberate step
  (`RESPONSES.md`).

## The steps

| # | Step | Required | Done when |
|-|-|-|-|
| 1 | Account | yes | an account exists (built) |
| 2 | Chain and RPC | yes | `chain` is in the configuration and the engine has started on it |
| 3 | First contract | no | a contract is registered |
| 4 | First rule | no | a rule exists |
| 5 | First alert channel | no | a channel exists |

Progress is derived from state, not stored: each step is done when
what it creates exists, whichever page created it. The only stored
fact is `setup.dismissed` in `app.settings`, set when a person closes
the checklist before finishing.

### 1. Account

As built: `/setup` shows "Set up Tripwire" and asks for a username
(letters, digits, dots, dashes and underscores, up to 64), a password
of 12 characters or more, and the password again; a mismatch says so
under the field and keeps **Create account** disabled. It is reachable only
while no account exists; once one does, `/setup` sends to `/login`.
Creating the account logs the person in and moves to the next step.

### The database, shown

The database is chosen before the server starts, because the server
runs on it from its first request (`DATABASE.md`). The chain step
therefore shows it as a fact above the form: "Data is stored in a
local database in `~/.tripwire/db/data`" (`TRIPWIRE_HOME/db/data`,
with the actual home shown; it defaults to `~/.tripwire`) or "Data is
stored in PostgreSQL at db.example.org:5432/tripwire", with a line on
how to change it (`SETTINGS.md`, Database). The default is local
mode, which needs no setup. A person who wants their own server
starts Tripwire with `--database-url`, `TRIPWIRE_DATABASE_URL`, or
`tripwire setup`.

### 2. Chain and RPC

At `/setup/chain`:

| Field | Notes |
|-|-|
| chain | chosen from the chains the application knows by name (Ethereum, Base, Arbitrum One, OP Mainnet, Polygon, Sepolia, Base Sepolia), or another chain by id |
| RPC endpoint (HTTP) | required; a literal URL or `env:NAME` |
| RPC endpoint (WebSocket) | optional, needed only to watch pending transactions |

**Verify** runs the engine's verify invocation (`ENGINE.md`, G2) on
the proposed values and shows the result line by line as
`SETTINGS.md` does: the chain id matching, the receipts method the
node serves, the latest block number, and the pending-transaction
subscription when a WebSocket endpoint was given. A mismatch names
both chain ids, taken from the engine's `wrong_chain` message ("this
endpoint serves Base (8453), not Ethereum (1)"). Continue is enabled
only after a passing verification of the values as they stand; editing
a field clears it.

**Continue** saves the chain as `SETTINGS.md` applies any engine
setting, then starts the engine and waits for it. The step shows the
engine's state as it moves (`ENGINE.md`):

```
Engine 0.1.0  downloading  18.2 of 31.0 MB
              verifying signature
              starting
              ready at block 21,904,112
```

Waiting ends at `ready` or `degraded`. A failure keeps the person on
the step with the reason: a signature that does not verify, a platform
the engine is not built for, or the engine's own startup error with
its recent log lines, and the fields stay editable.

**The download starts early.** The first `tripwire start` begins
fetching and verifying the pinned engine binary in the background
while the engine is `unconfigured`, so by the time a person has made
an account and pasted an endpoint it is usually already on disk. An
installation given the binary ahead of time (`tripwire engine install
--from`, `ENGINE.md`) skips the download entirely.

### 3. First contract

The registering form from `CONTRACTS.md`: address, the verified ABI
looked up as it is typed, a name. Registering moves to the next step
with that contract chosen. **Skip** moves on.

### 4. First rule

The rule wizard (`RULE-WIZARD.md`) with the contract from the previous
step chosen, opening on its starting points. Creating the rule moves
on. When step 3 was skipped the wizard's own contract section offers
the registering form, as it always does. **Skip** moves on.

### 5. First alert channel

The channel form from `NOTIFICATIONS.md`: a type, its settings and
secrets, and **Send a test**, whose result shows in place. Saving
moves on. **Skip** moves on.

### Done

A short summary of what now exists, with links: "Watching 1 contract
with 1 rule. Alerts go to #ops-alerts." And, once, where response
lives: "To let Tripwire pause contracts on-chain, set up response in
Settings." Finishing goes to Overview.

## Where people are sent

| State | A dashboard page request goes to |
|-|-|
| no account exists | `/setup` (built) |
| account exists, not logged in | `/login` (built, `AUTHENTICATION.md`) |
| logged in, engine `unconfigured` | `/setup/chain` |
| logged in, chain configured | where it asked; the later steps are reached from the checklist |

The chain redirect applies to every dashboard page except Settings'
account sections and `/logout`: with no chain there is nothing to
show, and a page full of "engine not configured" messages helps less
than the one form that fixes it. `/setup/contract`, `/setup/rule` and
`/setup/channel` are ordinary pages, reachable any time.

## The checklist on Overview

Until steps 3 to 5 are all done, or `setup.dismissed` is set, Overview
shows a checklist card (`OVERVIEW.md`): each optional step with a tick
or a link to its setup page, and **Dismiss**. Because progress is
derived, a contract registered from the Contracts page ticks the same
box. Dismissing is for the whole card and is not undone by later
changes; it can be reset only by removing the setting, which nothing
in the dashboard offers.

## Command line

`tripwire setup` does steps 1 and 2 and chooses the database, for
machines where the dashboard is not open yet: a server reached over
SSH, or a container.

Interactive, it prompts in order:

1. Database: local (default) or a PostgreSQL URL, checked with the
   external-mode pre-flight (`DATABASE.md`).
2. Account: username and password, twice, with echo off, as
   `tripwire user add` does.
3. Chain: id or name, and the RPC endpoints, then verifies them
   through the engine, installing it first if needed, and prints the
   same lines as the dashboard.

It writes `config.json` and the account and stops; `tripwire start`
then runs everything.

Non-interactive, for containers and scripts, every prompt has a flag,
and the command fails instead of prompting when one is missing:

```
tripwire setup --username ops --chain-id 1 \
  --rpc-http env:TRIPWIRE_RPC_HTTP [--rpc-ws env:TRIPWIRE_RPC_WS] \
  [--database-url env:TRIPWIRE_DATABASE_URL]
```

The password comes from `TRIPWIRE_PASSWORD`, never from an argument,
as `AUTHENTICATION.md` requires. `--skip-verify` writes the chain
without verifying, for images built where the endpoint is not
reachable; the engine then verifies at its first start. Run against
an installation that already has an account or a chain, the command
refuses and names what exists: setup happens once, and later changes
belong to `tripwire user` and `tripwire config`.

## API

All under `/api/v1`, with the API's error envelope. The account step
uses the existing `GET` and `POST /auth/setup` (`AUTHENTICATION.md`);
the rest requires a session.

| Method | Path | Purpose |
|-|-|-|
| GET | `/setup` | `{ steps: { account, chain, contract, rule, channel }, dismissed }`, each step `true` when done |
| POST | `/setup/chain/verify` | `{ chainId, rpcHttp, rpcWs? }` → the verify result `{ ok, chainId, head, receipts, ws, problems }`; saves nothing |
| PUT | `/setup/chain` | `{ chainId, rpcHttp, rpcWs? }`; verifies, writes the chain, starts the engine. `{ applied: true }`, or `400 invalid_settings`, `409 settings_rejected`, `409 already_configured` once a chain exists (changes go through `SETTINGS.md`) |
| POST | `/setup/dismiss` | sets `setup.dismissed` |

The step's engine progress is read from `GET /engine` and the
`health` event on the browser stream (`ENGINE.md`,
`LIVE-UPDATES.md`), not from a setup route of its own.

## Decisions

| # | Decision | Recommendation and reason |
|-|-|-|
| FR1 | What setup requires | Account and chain only. They are what the engine needs to run; contracts, rules and channels are each one page away and forcing them makes setup a form to get through rather than a start |
| FR2 | Where progress lives | Derived from state, with only the dismissal stored. A stored step list goes stale the moment someone registers a contract from its own page |
| FR3 | Database in the web flow | Shown, not chosen. The server is already running on a database when the page loads; choosing belongs to the command line and the environment, before start |
| FR4 | Redirect while unconfigured | Every page goes to the chain step. Nothing else works without an engine, and one form is clearer than every page explaining the same absence |
| FR5 | Download timing | In the background from the first start, not at install time. Package-manager install scripts are often disabled, and starting early hides most of the wait behind the account step |
| FR6 | Response in setup | Left out, with a pointer at the end. Response needs a key, funds, and a permission granted to that key on the contract; it is a decision, not a setup step |
| FR7 | Headless setup | `tripwire setup` with prompts and matching flags, password from the environment. Servers and containers are where Tripwire runs longest, and they often have no browser until a tunnel is set up |
| FR8 | Setup run twice | Refused once an account or chain exists. Changes after setup have their own commands and pages, which keep their own checks |

## Checkpoint

First run is done when, provably and repeatably:

1. On a machine with an empty `TRIPWIRE_HOME`, a person creates an
   account, enters a chain and endpoint, verifies, and reaches an
   engine at `ready`, with the download and verification shown, then
   skips the rest and lands on Overview with the checklist card.
2. An endpoint serving another chain is refused at Verify naming both
   chain ids, and nothing is written.
3. While the chain is unconfigured, every dashboard page redirects to
   `/setup/chain`; once configured, none does.
4. Registering a contract from the Contracts page ticks the checklist's
   contract step; dismissing the card hides it for every account.
5. `tripwire setup` with flags and `TRIPWIRE_PASSWORD` in a container
   with no terminal produces a working installation that
   `tripwire start` runs to `ready`; with a flag missing it fails
   naming the flag, and run a second time it refuses naming what
   exists.
6. An engine binary whose signature fails verification stops the
   chain step with that reason and is never run.
