# Rules

How a person sees the rules Tripwire runs: the list, a rule's page, its
values and charts, and moving rules between installations. Creating
and editing a rule is the wizard's (`RULE-WIZARD.md`). `HIGH-LEVEL-SPEC.md`
places the area; `DATABASE.md` holds what the application keeps about
rules (`app.rule_prefs`, `dashboard.pinned_rules`); `VIOLATIONS.md`
covers the violations shown here; `OVERVIEW.md` shows pinned rules;
`LIVE-UPDATES.md` keeps it all current.

Much of this is built. This spec describes it as built, and marks the
additions.

## Terms

| Term | Meaning |
|-|-|
| series | the values of one contract read, recorded by the engine at every block while a rule needs it. Rules reading the same thing share one series |
| computed series | the recorded output of a windowed metric (a moving average, a TWAP, a windowed change) over a series |
| rollup | an hourly summary of a series (first, last, minimum, maximum, average, count) that replaces its raw points once they are older than the raw retention (`SETTINGS.md`) |
| display scale | how a rule's raw integers are shown: divided by 10 to a number of decimals, followed by a unit |

## Status

Every rule has one status, worked out by the server in this order:

| Status | When |
|-|-|
| off | `enabled` is false |
| tripped | the rule's newest violation is `tripped` and at its last evaluated block: the condition holds now |
| error | the rule's newest violation is `evaluation_error` and at its last evaluated block: it cannot be evaluated now |
| warming | a metric the rule reads has too little history to be judged; the rule cannot trip until it has |
| holding | on, evaluated, and the condition does not hold |

Alongside the status, the count of the rule's open violations
(`VIOLATIONS.md`), because a rule can be holding now and still have a
run nobody has looked at. An event-triggered rule is only evaluated
when its event appears, so it is **tripped** only at the block of its
newest firing, and holding after.

## The list

At `/rules`, newest first. Each row, as built, shows a status dot, the
rule's name, **Off** when it is off, **Via** and the token's label
when an agent proposed it, the pin mark when it is pinned to the
Overview, the engine's sentence, the contract's name, the severity and
the action. A rule just created is highlighted when the wizard returns
to the list.

**Added:**

- the status in words when it is not holding (Tripped, Error, Warming
  up), with the open count;
- the rule's current value: the newest point of its first series, in
  the order the document reads them, with its display scale; a rule
  with no series (an event-triggered rule, for instance) shows none;
- a 24-hour sparkline of the same series, drawn with the list and read
  in one request for all visible rows;
- filters for contract and status, kept in the URL.

The empty state points to the wizard.

## A rule's page

At `/rules/:id`. As built:

- the name, the pin mark when pinned, and the on/off switch
  ("Watching" or "Off");
- the engine's sentence, then tags: the contract (a link to its
  page), the severity, the action, **Via** and the token's label for
  an agent's rule, **Warming up** while warming;
- **Edit** (the wizard, `RULE-WIZARD.md`), **Pin** or **Unpin**
  (pinned rules show on the Overview, at most 12), and **Delete**,
  which asks in a dialog: the rule stops watching and its violations
  go with it, which cannot be undone, and an enabled rule is reminded
  that switching it off is the reversible choice;
- facts: last evaluated block, created, changed;
- **How values show**: the display scale, decimals from 0 to 77 and a
  unit up to 16 characters, stored in `app.rule_prefs`;
- its violations as runs (`VIOLATIONS.md`), up to 200.

Switching a rule on or off is immediate and asks nothing. A rule on a
disabled contract can be switched on by hand; it then runs, and is not
among the rules the contract's enable restores (`DATABASE.md`).

**Added**, between the facts and the violations:

- the status and open count, as in the list;
- **Now**: the newest value of every series the rule reads or
  computes, each with its block and the display scale where it
  applies;
- the chart;
- **Check now**.

**Origin.** A rule stored by the dashboard carries no badge; one stored
through the API by a script or an import shows **Via API**; one stored
by an agent shows **Via** and its token's label, which survives the
token being revoked (`MCP-SERVER.md`).

## Charts

One chart per rule, drawn in hand-rolled SVG like every chart in the
dashboard, with a line per series.

**Which series.** The engine assigns series keys and the application
never derives them. The views do not yet say which series belong to
which rule (ask C1); until they do, the server takes the series from a
dry run of the stored document, whose needs list the calls the rule
records as metric inputs, and finds each in `api_v1.series` by its
address, function, arguments and tuple position, and the computed
series over it by metric and window. A rule whose reads are not metric
inputs has no chart until C1 lands, and its page says so; its current
values and evidence still show.

**Windows:** 1 hour, 24 hours (the default), 7 days, 30 days, 90 days,
and all, remembered per browser. The time axis runs to now; a window
longer than the series starts where the series starts.

**Raw points and rollups.** The engine keeps raw points for the raw
retention period and hourly rollups beyond it, and each value is in
exactly one of the two at any moment. A window is read from both: raw
points from the series' oldest raw point onwards, rollups before it.
Where one display bucket takes from both, the two are combined
(minimum of minimums, maximum of maximums, first and last by time),
never one chosen over the other, so the boundary leaves no seam.

**Downsampling.** A window is cut into at most 500 buckets of equal
time, and the server returns, per bucket, the first, last, minimum and
maximum value and the count, computed in SQL. A window holding 500
points or fewer returns the points themselves. The chart draws the
minimum-to-maximum range of each bucket behind the line through the
last values, so a spike inside a bucket is never averaged away: a
one-block drop is visible at any zoom. Where the window reaches back
into rollups and buckets are shorter than an hour, the chart is at
hourly resolution there, and says so on hover.

**Reads are bounded** as `DATABASE.md` requires: every chart query has
a limit and a statement timeout of a few seconds, so a long window on
a busy series never holds the engine's session in local mode.

**Exact values.** Values arrive as decimal strings. The browser turns
them into floating-point numbers only to place them on the chart;
every label and hover shows the exact string, with the display scale.

**Overlays:**

| Overlay | Drawn from |
|-|-|
| threshold | a comparison of a series against a literal: a horizontal line at the literal, labelled with the comparison |
| deviation band | the band's center, which is a computed series, drawn as its own line, with the band around it at the width the document states |
| violations | a mark at the time of each violation in the window: filled for tripped, amber for errors, hollow for pending |

**Gaps.** Nothing is recorded while a rule is off, while the engine is
stopped, or before a computed series' first warm block. The line
breaks where consecutive points are more than three times the series'
usual interval apart, so a gap reads as a gap and not as a straight
line across it.

**Display scale** applies to the series of the rule's contract reads,
to metrics computed over them, and to thresholds compared against
them. Values the rule computes from several reads (a ratio, a sum)
are shown raw.

Hovering shows the value, block and time at that point; the chart
follows the window as new blocks arrive (`LIVE-UPDATES.md`).

## Check now

**Check now** asks the engine to evaluate the stored document once at
the current block, through the same dry run the wizard uses, and shows
the answer beside the chart: whether it would trip now, whether it is
still warming (with how long is left), and the evidence tree as the
Violations page draws it (`VIOLATIONS.md`). It records nothing: no
value, no violation, no notification, no response. It works on a rule
that is off, which is how a person checks a rule before switching it
on.

## Command line

Moving rules between installations, or keeping them in version
control. Both commands talk to the running server's API, so the server
must be running; they log in with an account (prompting for the
password, or `TRIPWIRE_USERNAME` and `TRIPWIRE_PASSWORD` for scripts,
per `AUTHENTICATION.md`), and log out when done. `--url` names the
server, defaulting to `http://127.0.0.1:4747`; when nothing answers
there the command says Tripwire is not running at that address.

| Command | Does |
|-|-|
| `tripwire rules export [--contract <address>]` | writes the rules, or one contract's, to standard output as JSON |
| `tripwire rules import <file> [--disabled]` | submits each rule in the file through the checked path |

The export:

```json
{
  "version": 1,
  "chainId": 1,
  "exportedAt": "2026-09-26T10:00:00Z",
  "rules": [
    {
      "contract": { "address": "0x…", "name": "Treasury vault" },
      "enabled": true,
      "document": { "name": "Assets cover supply", … }
    }
  ]
}
```

The import checks first that the file's `chainId` is the
installation's, and refuses otherwise. It then submits each rule as a
script would, through `POST /rules`: every rule is validated by the
engine exactly as the wizard's are, and stored as any rule the
application stores (origin `app`, shown as the dashboard's; `api`
means a rule created directly against the engine's interface,
`MCP-SERVER.md`). Each rule is sent with the `enabled` it had in the
export, through an optional `enabled` in the `POST /rules` body
(default true, and false regardless while the contract is disabled),
so a rule that was off is never armed, not even for a moment.
`--disabled` stores them all off, for reviewing before arming.

Rules are independent, so the import is not all or nothing: it reports
one line per rule (created with its id, already present with the id of
the identical rule, invalid with its issues, or name taken) and exits
non-zero when any rule was not created. A rule whose contract is not
registered here is skipped and named, with the contract's address, and
the report ends by listing the contracts to register first.
Registering them is left to a person, because it involves choosing a
name and an ABI.

## API

All under `/api/v1`, requiring a session (`AUTHENTICATION.md`), with
the API's error envelope. Creating and replacing rules is specified in
`RULE-WIZARD.md`.

| Method | Path | Purpose |
|-|-|-|
| GET | `/rules` | all rules, newest first, or one contract's with `?contract=`; **added:** each with `status` and `openViolations`, and `?status=` to filter |
| GET | `/rules/:id` | one rule, with the same additions; `404 not_found` |
| PATCH | `/rules/:id` | `{ enabled?, display? }`; returns the rule |
| DELETE | `/rules/:id` | removes the rule and its history; drops it from the pinned list |
| GET | `/pinned-rules` | the pinned rule ids, in order, missing rules left out |
| PUT | `/pinned-rules` | `{ ruleIds }`, at most 12, every one existing; `400 unknown_rule` names the first that does not |
| GET | `/rules/:id/series` | **added:** the rule's series: `{ id, call, metric, windowSeconds, role }`; `role` is `read` or `metric` |
| GET | `/rules/:id/current` | **added:** the newest point of each of those series: `{ seriesId, value, blockNumber, blockTime }` |
| GET | `/series/:id/points` | **added:** `?from&to&points`, `points` at most 500: `{ resolution, buckets: [{ start, first, last, min, max, count }] }` or, when the range holds no more than `points` values, `{ resolution: "block", points: [{ blockNumber, blockTime, value }] }` |
| GET | `/sparklines` | **added:** `?rules=1,2,3&window=24h`, at most 200 rules: 48 buckets per rule's first series |
| POST | `/rules/:id/check` | **added:** a dry run of the stored document: `{ block, wouldTripNow, warming, warmupSecondsLeft, evidence }`; stores nothing |

Every value is a decimal string. A rule's status is computed from the
views in the same request: the newest violation per rule is read with
one bounded query, never one query per rule.

No MCP tool reads charts or changes a rule's switch, display or pin;
agents read rules through `list_rules` (`MCP-SERVER.md`).

## What the application requires of the engine

| # | Requirement | Why |
|-|-|-|
| C1 | A view linking rules to the series they record: `api_v1.rule_series` with the rule id, the series id, its role (`read` or `metric`) and the path of the node in the document that produced it | series keys are the engine's; without the link the application must guess which series a rule draws from its needs, which covers metric inputs only, and a chart built on a guess can show the wrong line |

## Decisions

| # | Decision | Recommendation and reason |
|-|-|-|
| RL1 | Where status is worked out | The server, from the views, one bounded query per list. The list, the rule page, the Overview and scripts then agree on what "tripped" means |
| RL2 | "Tripped" | The newest violation is at the last evaluated block. Open violations alone would call a rule tripped long after its condition cleared |
| RL3 | Downsampling | On the server, to at most 500 buckets with minimum and maximum kept. Sending a month of per-block points to a browser is slow, and averaging hides exactly the spike a person is looking for |
| RL4 | Series before C1 | The dry run's needs, matched on the series view's columns, with no chart when that does not cover the rule. A missing chart is honest; a wrong one is not |
| RL5 | Sparklines | One request for the visible rows, not one per row. A list of 50 rules should not cost 50 round trips to a database that, in local mode, has one session |
| RL6 | Check now | A dry run of the stored document: the engine's own judgement, with nothing recorded. Re-evaluating "for real" would record a violation nobody asked for |
| RL7 | Export and import | Through the API with a login, not the database, so an import is checked by the engine exactly as a person's rule is. Per rule, not all or nothing, because rules are independent and one bad rule should not block forty good ones |

## Checkpoint

Rules are done when, provably and repeatably:

1. A deviation-band rule that has run for a day charts its value and
   its center from the views, with the band drawn around the center,
   and the chart equals the series points the engine recorded.
2. A one-block spike inside a 30-day window is visible on the chart.
3. A window spanning the raw retention boundary shows no seam: the
   combined buckets at the boundary equal those computed from the raw
   points and rollups directly.
4. A rule switched off for an hour shows a gap on its chart, and its
   status reads off, then holding once it is on again (or warming, if
   its metrics need to warm up again).
5. Tripped means tripped now: a rule whose condition held and then
   cleared reads holding with an open count, not tripped.
6. Check now on a rule that is off returns the evidence, and the
   engine's views are identical before and after.
7. The list of 50 rules with sparklines loads with a fixed number of
   requests, whatever the number of rules.
8. An export imported into an empty installation on the same chain,
   after its contracts are registered, recreates every rule with the
   same documents and switches; an import with one invalid rule
   creates the others and exits non-zero naming it; a file from
   another chain is refused.
