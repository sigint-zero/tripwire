# Violations

How a person sees what tripped, reads what the engine saw, and marks
what they have dealt with. `HIGH-LEVEL-SPEC.md` places the area;
`DATABASE.md` holds the acknowledgement table; `RULES.md` shows one
rule's violations on its page; `RESPONSES.md` covers what the engine
did about them on chain; `NOTIFICATIONS.md` covers the alerts they
raise; `LIVE-UPDATES.md` keeps the page current.

Most of this page is built. This spec describes it as built, and marks
the additions.

## Terms

| Term | Meaning |
|-|-|
| violation | one record by the engine that a rule's condition held at a block, or that the rule could not be evaluated there |
| run | one rule's violations of the same kind and the same acknowledgement state at consecutive blocks: one event to a person |
| open | not acknowledged by anyone |
| acknowledged | a person has seen to it; acknowledging hides nothing and deletes nothing |

## Kinds

The engine records three kinds, all in the `api_v1.violations` view:

| Kind | Shown as | Meaning |
|-|-|-|
| `tripped` | Tripped | the rule's condition held at a block on the canonical chain |
| `evaluation_error` | Error | the rule could not be evaluated at that block; the evidence carries the error. Failing loud is deliberate: an error is never a silent pass |
| `pending` | Pending | seen in the mempool: evaluating a pending transaction against the head showed the condition would hold. `tx_hash` is the pending transaction, `block_number` the head it was evaluated at |

A pending violation is early warning, not a substitute. If the
transaction lands and the condition holds on chain, the engine records
its own `tripped` violation at that block, independently; the page
shows both, and neither replaces the other. A pending transaction that
never lands leaves its pending violation standing as a record of what
was seen. A pending violation never makes its rule read as tripped
(`RULES.md`), and it starts a response only when pending transactions
may respond (`SETTINGS.md`, Detection); otherwise it is recorded and
notified only.

## Runs

A rule whose condition keeps holding records a violation on every
block, so a list of raw rows would bury everything else under one
incident. The list groups rows into runs: walking newest first, a row
joins the growing run of the same rule, kind and acknowledgement state
when its block is at most one below the run's oldest block; otherwise
it starts a new run. The grouping happens in the dashboard over the
page of rows it has loaded, so a run that spans a page boundary shows
as two until the older page is loaded.

Each run row shows the severity, the rule's name (left out on the
rule's own page, where it is said), a count when the run has more than
one block, a tag for `Error` and `Pending`, `Acknowledged` when it is,
the contract's name, the block or block range, and how long ago the
newest block was.

## Evidence

Opening a run shows what the engine saw at its newest block: the
condition as a tree, each part on its own line with the value it had,
indented under the part it belongs to:

- a condition shows whether it held;
- a number shows its value, and a contract read is scaled by the
  rule's display settings (`RULES.md`) when it has them, with the unit;
- a part the evaluation never reached shows as not evaluated, and a
  metric with too little history as warming;
- literals and `now` are not repeated beneath their parent, whose
  sentence already names them;
- an evaluation error shows the engine's error message instead.

The evidence is rendered from the row alone, with no read of the
chain, so it shows exactly what was true at that block.

**Added:** when the violation produced a response, the panel names it
under the evidence: the action, its status (`RESPONSES.md`) and a link
to it on the Responses page. A violation that produced none says
nothing, because under `notify` mode, during a quiet period, or while
another response for the rule is live, none is expected.

## Acknowledging

A run is acknowledged in one step, with an optional note of up to 500
characters: every violation in it is marked with the account and the
time. A single violation is acknowledged the same way through the API.
Acknowledging a violation that already is acknowledged keeps the first
acknowledgement, so the record of who saw to it first is never
overwritten. Acknowledging is not undone; the note is how a person
records that something still needs attention.

Acknowledgements are the application's (`app.violation_acks`), joined
in when violations are read, so "open" means not in that table. The
Overview's open count and list read the same thing (`OVERVIEW.md`).
Accounts are equal: anyone logged in may acknowledge anything.

## The page

At `/violations`:

- a choice of **Open** (the default) and **All**;
- **added:** filters for kind, contract and rule, kept in the URL so a
  filtered view can be linked; the rule filter is what a rule's page
  and an alert link to;
- runs, newest first, loaded 200 violations at a time with **Older**
  paging by id;
- empty states: "Nothing open" when everything is acknowledged, "No
  violations yet" before anything has tripped.

Built today, the list refreshes every 12 seconds. **Added:** it
refreshes when `LIVE-UPDATES.md` announces a `violation` or a
`response`, and polls only while that stream is down.

Violations are kept by the engine for good: they are the audit trail
and grow with incidents, not with blocks. Deleting a rule deletes its
violations with it, which the rule page says before it does
(`RULES.md`).

## API

All under `/api/v1`, requiring a session (`AUTHENTICATION.md`), with
the API's error envelope.

| Method | Path | Purpose |
|-|-|-|
| GET | `/violations` | newest first: `?rule&contract&kind&open&before&limit`; `limit` 1 to 1000; `before` is an id; `contract` an address, answering `[]` when it is not registered |
| GET | `/violations/:id` | one violation; `404 not_found` |
| POST | `/violations/:id/acknowledge` | `{ note? }`; returns the violation |
| POST | `/violations/acknowledge` | `{ ids, note? }`, up to 1000 ids: all acknowledged, or none with `404 not_found` naming the first missing id; returns the violations |

A violation:

```json
{
  "id": "18342",
  "ruleId": "12",
  "ruleName": "Assets cover supply",
  "severity": "critical",
  "contractAddress": "0x…",
  "kind": "tripped",
  "blockNumber": 21000000,
  "blockTime": "2026-09-26T10:00:11Z",
  "txHash": null,
  "evidence": { "node": "compare", "value": true, "left": { … }, "right": { … } },
  "createdAt": "2026-09-26T10:00:12Z",
  "acknowledged": { "by": "u_1", "note": "Known, fixed in the next upgrade", "at": "…" },
  "response": { "id": "7", "status": "confirmed" }
}
```

`kind` and `response` are the additions. `response` is `null` when the
violation produced none; it is read from `api_v1.responses` by
violation id in the same query as the page.

Ids are the engine's, carried as strings because they are 64-bit.
`400 invalid_request` with issues answers any malformed query or body.
No MCP tool reads or acknowledges violations.

## Decisions

| # | Decision | Recommendation and reason |
|-|-|-|
| VI1 | Runs | Grouped in the dashboard, not stored. A run is a way of looking at rows, and grouping over the loaded page keeps the API a plain list any script can use |
| VI2 | Acknowledging twice | The first acknowledgement stands. Who saw to it first is the useful fact; a later note belongs in the team's own tools |
| VI3 | Pending beside tripped | Both shown, separately tagged. A pending violation that is later confirmed on chain was the early warning, and hiding either would lose the timeline |
| VI4 | Deleting violations | Not offered. They are the audit trail; acknowledging is how a person clears them from view |
| VI5 | Response on the violation | Joined in by the server. The person reading the evidence asks next "did it pause?", and one link answers it |

## Checkpoint

The Violations page is done when, provably and repeatably:

1. A rule tripping at ten consecutive blocks shows as one run of ten;
   a gap of one block starts a second run; the same rule's evaluation
   errors form runs of their own.
2. Acknowledging a run marks every violation in it, and a second
   acknowledgement with a different note leaves the first in place.
3. The batch acknowledgement with one unknown id changes nothing and
   names that id.
4. A pending violation and the tripped violation the same transaction
   later caused both appear, each tagged.
5. With a rule in `prepare` mode, a violation's panel links to its
   response, and the link's status changes when the response does,
   with no reload.
6. A new violation appears on an open page within seconds of the
   engine recording it, with the stream connected and without polling.
7. The kind, contract and rule filters survive a reload and a copied
   link.
