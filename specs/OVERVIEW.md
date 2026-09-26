# Overview

The dashboard's first page: what needs attention now, whether Tripwire
itself is well, and the rules a person chose to keep in view.
`HIGH-LEVEL-SPEC.md` places it. It owns no data of its own: every part
is read from a route another spec defines, and each section names that
spec.

## Principles

- **Attention first.** What is paused and what is open comes before
  anything that is merely interesting.
- **Tripwire's own health is on the page.** A quiet Overview must mean
  "nothing happened", never "nothing is being watched". The health
  strip says which.
- **Nothing here is a second copy.** Counts, lists and charts are the
  same reads the dedicated pages make, so the Overview and a page
  never disagree.

## Layout

At `/`, top to bottom:

| # | Section | Shown |
|-|-|-|
| 1 | Header | always |
| 2 | Health strip | always |
| 3 | Setup checklist | until every step is done or it is dismissed |
| 4 | Counts | always |
| 5 | Tripped now | always |
| 6 | Open violations | always |
| 7 | Pinned | always |

## Header

As built: the title "Overview" and the line "What needs attention, and
what you pinned." The chain's name and the signed-in account are not
the page's: they sit in the shell's top bar on every page (the chain
badge, from `GET /api/v1/engine`, and the account menu).

While the development stand-in answers instead of the engine
(`ENGINE.md`), the health strip below says so in amber, so nobody takes
simulated violations for real ones. The shell's chain badge gains the
same word, **Stand-in**, beside the chain's name, because the stand-in
affects every page, not only this one.

## Health strip

One line across the page saying whether Tripwire is watching, read
from `GET /api/v1/engine` (`ENGINE.md`). It is readable while the
engine is down: the server fills the head and its age from the
`engine_status` view, which the engine's cursors keep and which
outlives the process.

| Engine state | Strip says | Tone |
|-|-|-|
| `ready` | "Watching Ethereum. Block 21,004,512, 4 s ago." | quiet |
| `degraded` | "Behind: 38 blocks behind the chain head, RPC retrying." (the engine's own cause) | amber |
| `starting` | "Starting the engine." | quiet |
| `installing` | "Installing the engine." with the download's progress | quiet |
| `restarting` | "The engine stopped. Restarting in 8 s. Last block seen 2 min ago." | red |
| `unresponsive` | "The engine is not answering. Last block seen 1 min ago." | red |
| `failed` | "The engine cannot start: " and the reason, with a link to Settings | red |
| `stopped` | "The engine is stopped." | red |
| `unconfigured` | "No chain set up yet." with a link to `/setup` | amber |
| `stand-in` | "Stand-in: simulated blocks, no chain." | amber |

After the sentence, smaller: the RPC's state (connected, retrying),
the database mode (`local` or `external`, from
`GET /api/v1/settings/database`) and the engine version. The whole
strip links to Settings, where the same facts sit with the engine's
log.

The head number moves with the stream's `block` event without a
refetch (`LIVE-UPDATES.md`); the age is computed in the browser from
the block's time, so it keeps counting while no block arrives, which
is exactly when it matters.

## Setup checklist

A card with the steps of `FIRST-RUN.md` that are not yet done
(`GET /api/v1/setup`): add a contract, create a rule, connect an alert
channel. Each step links to where it is done and ticks itself when its
state exists. The card disappears when every step is done, or at
**Dismiss**, which `POST /api/v1/setup/dismiss` remembers for every
account. The account and chain steps never appear here: without them
the dashboard is not reachable past `/setup`.

## Counts

As built, plus one tile:

| Tile | Value | Links to |
|-|-|-|
| Contracts watched | enabled contracts over all, `3 / 4` | `/contracts` |
| Rules on | enabled rules over all, `12 / 15` | `/rules` |
| Open violations | violations not acknowledged; `1000+` beyond the page size | `/violations` |
| Waiting for approval | responses in `awaiting_approval` | `/responses` |

"Open violations" and "Waiting for approval" turn red when above zero.
"Waiting for approval" is shown only while the installation's
response mode is `prepare`, or while any response is still waiting
from a time it was: a queue does not vanish from the page because the
mode changed under it. A dash stands in for a count still loading.

## Tripped now

Everything paused at this moment, from `GET /api/v1/trip-state`
(`ACTIVITY.md`): one row per paused contract or function, from either
source.

| Column | Shows |
|-|-|
| what | the contract's name, and the function's name for a function-level pause or "whole contract" for a global one |
| how | "confirmed call" (a rule's call whose confirmation reads as in effect) or, for a contract using the optional TripwireController, "controller" |
| since | the block, and its time as "2 h ago" |
| by | "Tripwire" with a link to the response when the pausing transaction was a Tripwire response, else the address that sent it; nothing for a confirmed call, whose state is observed rather than sent |

A row links to the contract's page. When nothing is paused the section
shows "Nothing paused". A pause on a contract that is not registered
here is not shown: the controller is shared by every guarded contract
on the chain.

## Open violations

As built: open violations as runs, a run being one rule's violations
at consecutive blocks (`VIOLATIONS.md`), at most five, then "All
violations". Empty: "All clear. Nothing has tripped that is not
acknowledged." A run can be acknowledged from here as on the
Violations page.

## Pinned

As built: the rules pinned from their page (`RULES.md`,
`dashboard.pinned_rules`), in the order pinned, each a card with the
rule's name, an on or off dot, its sentence, and its state: "3 open,
tripped 5 min ago" in red, else "Holding", or "Off". Empty: "Nothing
pinned. Pin a rule from its page to keep it here."

Added: a sparkline of the last 24 hours of the rule's first recorded
value (the first series of role `read` in `RULES.md`), downsampled to
60 points by the server, with the rule's threshold or band drawn as in
its full chart when it has one, and the latest value in the rule's
display scale. A rule with no recorded series (an event rule) shows
its last firing instead. A warming rule's line starts where its data
does, and the card says "Warming up".

## Reading

The page composes the routes the other pages already use; there is no
Overview route.

| Section | Route | Query key |
|-|-|-|
| health strip (and the shell's chain badge) | `GET /engine` | `["engine"]` |
| health strip | `GET /settings/database` | `["settings", "database"]` |
| setup checklist | `GET /setup` | `["setup"]` |
| counts | `GET /contracts`, `GET /rules`, `GET /violations?open=true&limit=1000`, `GET /responses/counts` | `["contracts"]`, `["rules"]`, `["violations", ...]`, `["responses", "counts"]` |
| tripped now | `GET /trip-state` | `["trip-state"]` |
| pinned | `GET /pinned-rules`, then per card `GET /rules/:id/series` and `GET /series/:id/points` | `["pinned"]`, `["rule-series", id]`, `["series", id, range]` |

Freshness comes from the stream (`LIVE-UPDATES.md`); the built
12-second poll on open violations is removed. Sparklines refetch every
minute on their own, not per block.

## Decisions

| # | Decision | Recommendation and reason |
|-|-|-|
| OV1 | An Overview route | None. The page makes seven small reads that other pages make and cache anyway; one combined route would be a second shape of the same data to keep in step, and the stream already refreshes each part separately |
| OV2 | Health strip always shown | Yes, one line even when all is well. The failure it guards against is a quiet page that looks healthy because the engine stopped |
| OV3 | Waiting for approval | A fourth tile, shown in `prepare` mode or while anything waits. In `prepare` mode an unapproved response is the most urgent thing on the page |
| OV4 | Tripped now above open violations | Yes. A pause is in effect on chain and may be stopping users; a violation is a record |
| OV5 | Pauses on unregistered contracts | Not shown. The shared controller carries every guarded contract on the chain; only ours are this installation's business |
| OV6 | Sparkline series | The rule's first recorded read, over 24 hours at 60 points. One line per card stays readable at card size; the full chart is one click away |

## Checkpoint

The Overview is done when, provably and repeatably:

1. With the engine stopped, the page loads, the health strip is red
   and names the last block seen and its age from `engine_status`, and
   every other section shows what the views hold.
2. A rule tripping on the connected chain raises "Open violations"
   and adds its run within two seconds, with no poll running.
3. A controller trip sent from an independent wallet on a registered
   contract appears under Tripped now with that wallet's address, and
   a trip sent by a Tripwire response appears as "Tripwire" linking
   to the response; a trip on an unregistered contract does not
   appear.
4. In `prepare` mode a response awaiting approval shows the fourth
   tile in red; approving it elsewhere brings the tile to zero without
   a refresh.
5. A pinned deviation-band rule's card shows its value line and band
   over 24 hours from the recorded series, and matches the rule page's
   chart for the same range.
6. The setup checklist ticks "Add a contract" as soon as one is
   registered, and after Dismiss stays gone for every account.
7. Under the stand-in the health strip and the shell's chain badge
   both say Stand-in, and no copy on the page reads as if a real chain
   were watched.
