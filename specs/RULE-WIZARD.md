# Rule Wizard

How a person creates and edits a rule in the dashboard. This covers the
wizard's flow, the starting points, the document it produces, the check
before a rule is stored, and the API behind them. How the engine
evaluates a stored rule is out of scope; the MCP server submits through
the same path and is specified in `MCP-SERVER.md`.

## Terms

| Term | Meaning |
|-|-|
| rule | one watchable statement about a contract: the condition that should never occur, and what to do when it does. The engine's rule document |
| invariant | a property that must always hold. Most rules encode one, written as its violation |
| starting point | a sentence with blanks that builds one shape of rule (a template, in the code) |
| draft | a rule document that has not been stored |
| check | the engine's verdict on a draft: whether it is valid, the rule read back as a sentence, and the rule evaluated once at the current block |

## Why

A rule is an expression tree: reads from contracts, arithmetic,
historical metrics, comparisons. Writing that tree by hand is slow and
easy to get subtly wrong, and a rule the engine cannot evaluate is
worse than none, because it looks armed and never fires. Most useful
rules are one of a handful of shapes ("this never drops below that",
"this never moves more than 5% in an hour"). The wizard makes those
shapes a sentence to fill in, reads the result back in the engine's own
words before it is stored, and refuses anything the engine would not
accept.

## Principles

- **Sentence first.** The user states what must stay true, in plain
  words. The wizard writes the violation the engine watches for. The
  expression tree stays underneath, visible on request.
- **One document, checked everywhere.** A draft is the engine's rule
  document, language version 1. `shared` mirrors its schema in Zod, so
  the wizard can say what is wrong while the user types; the server
  checks again; the engine is the authority.
- **Read it back before it is armed.** Review shows the engine's
  sentence for the rule, whether it would trip right now, and how long
  it warms up.
- **Human units.** Percentages, durations and names from the ABI. The
  user never types a selector, a hex topic or a number of seconds.
- **One way in.** The wizard, the MCP server and rule import submit to
  the same path, checked only or checked and stored.

## Flow

One continuous page at `/rules/new`, inside the navigation shell, read
top to bottom so the rule is understood as a whole. It is built from
four sections. Only the first is shown at the start. The rule section
opens as soon as the contract loads, with no starting point chosen: the
user picks one. Each later section ends with **Continue**, which is
enabled once the section is complete and opens the next section and
scrolls to it. Opened sections stay open and editable, and later
sections update as earlier ones change.

A stepper stays pinned to the top of the page. It highlights the
section in view, marks completed sections done, and scrolls to a
section when clicked. Sections not yet opened cannot be selected.

| Section | Asks | Complete when |
|-|-|-|
| 1 Contract | an address, or a pasted ABI | an ABI is loaded |
| 2 Rule | a starting point, and the blanks in its sentence | the trigger and condition pass the schema |
| 3 Response | severity, action and quiet period | a function trip names a function |
| 4 Review | a name and an optional description | the document passes the schema and no identical rule exists; creating stores it |

Changing the contract clears the starting point, the blanks, the name
and the severity, and closes every section after it. Blanks are kept
per starting point, so trying another and coming back does not lose
what was filled in.

## Contract

An installation watches one chain (`DATABASE.md`, DB9), which the
engine reports. The user pastes an address; as soon as it is valid, the
server looks up the contract's verified ABI on that chain (see
[ABI lookup](#abi-lookup)). The section then shows the contract's name,
the chain, whether it is a proxy and which implementation it points to,
and the contract itself in three tabs, so the user sees what can be
watched before choosing how:

| Tab | Shows |
|-|-|
| Values | every value the wizard can read, by name |
| Events | every event, by name with its parameters |
| Functions | every function that can be paused, with its selector |

When there is no verified source, or the user prefers, the ABI can be
pasted instead: a bare JSON array or any object with an `abi` field (a
compiler artifact). A pasted ABI takes precedence over the lookup.

From the ABI the wizard extracts:

| Offered as | Taken from |
|-|-|
| values | `view` and `pure` functions with no inputs, one entry per integer output; a function returning several values offers each, named `function.output` (e.g. `latestRoundData.updatedAt`) |
| events | every event, in the declaration style rules name them by: `Transfer(address indexed from, address indexed to, uint256 value)` |
| functions to pause | every non-view function, by bare signature (`withdraw(uint256)`), with its 4-byte selector |

Functions and events with array or tuple parameters are left out, and
so are events with an unnamed parameter: language version 1 cannot
reference them.

## Starting points

Each starting point is a sentence with typed blanks and a builder that
turns the filled blanks into the rule's trigger (`when`) and condition
(`trip_when`). The rule section shows them as tiles with the chosen
one's sentence below them, set large in its own panel, so the user can
try each against this contract and see the statement change at once.
Nothing is chosen until the user picks a tile; suggested ones come
first.

Blanks are pre-filled when a starting point is first opened: values by
preferred names (`totalAssets` for a balance, `updatedAt` for a
timestamp), skipping constants such as `decimals` and `version`;
numbers with a sensible default. A starting point the contract cannot
support (no readable values, or no events) is shown disabled with the
reason.

Starting points also name the values that make them a strong fit: a
timestamp such as `updatedAt` for "Stays fresh", a price or rate for
"Stays near its average", a balance beside a supply for "Never drops
below". When the contract has every such value, the tile is marked
**Suggested** and listed first. A blank that needs such a value is left
empty when the contract has no clear match (*"choose timestamp… is
never more than 1 hour old"*) rather than filled with a poor guess.
Names are matched on the output's own name, so
`getReserves._blockTimestampLast` counts as a timestamp, not a reserve.

The sentence says what must stay true; the document says when that
stops being true:

| Starting point | Sentence | Trips when | Severity |
|-|-|-|-|
| Never drops below | *value* never drops below *value or number* | `value < floor` | critical |
| Stays near its average | *value* stays within *n*% of its *window* average | *value* moves more than *n*% away from its *window* time-weighted average (`deviation_band`, both sides, around a `twap` metric) | warning |
| Growth limit | *value* grows by at most *n*% in *window* | the *window* change in *value* (`windowed_delta`) rises above *value* × *n*/100 | warning |
| Outflow limit | *value* falls by at most *n*% in *window* | the *window* percent drop in *value* (`windowed_drop`) rises above *n* | critical |
| Stays fresh | *timestamp* is never more than *window* old | `now − timestamp > window` | warning |
| Event never appears | *event* is never emitted | the event itself: an event trigger with the condition `true` | critical |
| Custom comparison | *value* *comparison* *value or number* | the opposite comparison: "is at least" trips on `lt`, "equals" on `ne` | warning |

The severity column is the default the Response section starts from.

Blank types:

| Blank | Input | Stored as |
|-|-|-|
| value | a dropdown of the contract's values | a `view_call`, with `returns` when the function returns several values |
| value or number | the same dropdown plus "a fixed number…", which opens a number field | a `view_call` or a `literal` |
| percent | whole number, 0 to 999 | `tolerance_percent`, a literal, or a fraction in a `mul` |
| window | 5 minutes, 15 minutes, 20 minutes, 1 hour, 6 hours, 24 hours, 7 days | `{ "seconds": n }` |
| comparison | is at least, is above, is at most, is below, equals, never equals | the opposite of `ge`, `gt`, `le`, `lt`, `eq`, `ne` |
| event | a dropdown of the contract's events | the declaration-style signature |

Starting points live in the dashboard (`packages/web/src/lib/templates.ts`)
because they are presentation: sentences, defaults, labels. The engine
ships no catalogue of its own. The documents they build are plain rule
documents, so a rule does not depend on the starting point that made
it.

## The rule document

The wizard produces the engine's rule document, language version 1:

| Field | Set from |
|-|-|
| `version` | always `1` |
| `name` | Review; 1 to 120 characters, unique per contract |
| `description` | Review, optional |
| `contract` | the address from the Contract section |
| `severity` | Response |
| `when` | `every_block`, or `{ event }` for "Event never appears" |
| `trip_when` | the starting point; states the violation |
| `on_trip` | Response |

Whether a rule is enabled is the engine's state, not part of the
document.

The condition states the bad case: the rule trips when `trip_when` is
true. Whatever cannot be known yet (a metric still warming up) counts
as false, so an unknown never trips.

`packages/shared/src/rule.ts` mirrors the engine's schema in Zod:
every node type, numbers as decimal strings, bare function signatures
and declaration-style event signatures, windows from 60 seconds to 30
days, a metric's window present exactly when the metric reads one, the
size caps (depth 32, 256 nodes, 32 calls), and event arguments only
under an event trigger that has them. Unknown fields are rejected at
every level. Problems are reported as `{ code, message, path }`, with
`path` a JSON pointer into the document (`/trip_when/left/window/seconds`),
the same shape the engine reports.

## Response

| Choice | Values |
|-|-|
| severity | critical: loss of funds or control; warning: a condition that comes before a loss; info: hygiene. Starts at the starting point's default |
| action | notify only: record the violation and alert; pause the contract (`trip_global`); pause one function (`trip_function`), chosen from the contract's functions |
| quiet period | `on_trip.cooldown_seconds`: none, 1 minute, 5 minutes (default), 1 hour. Trips inside it are still recorded, but not acted on again |

Whether a pause waits for a person's approval or is sent at once is not
part of the rule. It is the installation's response mode (notify,
prepare or send), set for every rule in Settings. When a pausing action
is chosen, the section says which mode the installation is in.

## Simulated trip

The response section shows, beside its options, what happens when the
rule trips with the action chosen, as a still picture. A chart shows a
scripted breach: the value crossing its limit, leaving its band, or the
event appearing, with the limit's name written on its line. The time
axis runs from three minutes before the breach to it, marked **0**, and
on through the quiet period, which is shaded. The actions that follow
the breach are numbered markers on the chart, matched by a numbered
list below it:

| Action | Installation mode | Steps |
|-|-|-|
| notify only | any | rule trips, violation recorded, alert sent |
| pause | prepare | as above, then pause prepared, waiting for approval in Responses |
| pause | send | as above, then pause sent, paused |
| pause | notify | as above, then pause skipped |

The list ends with the quiet period. The pause names its target, the
whole contract or the chosen function. The picture updates as the
response changes. It is labelled **Simulated trip**: it illustrates
the response, and makes no prediction about when or whether the rule
will trip.

## Review and create

Review asks for the name, pre-filled from the starting point
(`totalAssets floor`) and editable up to 120 characters, and an
optional description: why the rule exists and what a trip would mean.
It summarises what is watched, the rule as a sentence, the severity and
the response, and shows what the engine reads, the sentence from a
check of the document. Beneath it, as they apply:

- that the rule would trip right now, and at which block;
- how long it warms up before it can trip (its longest window);
- that an identical rule already watches the contract, in which case
  **Create** is disabled;
- that the check ran against simulated values.

The document is available as JSON behind a disclosure. Creating stores
it and opens the rules list with the new rule highlighted.

A rule created in the wizard is enabled at once: a person built and
reviewed it. One submitted over MCP arrives disabled and notify-only,
and shows a "created via MCP" badge until a person enables it.

## Editing

Not built yet. Opening an existing rule starts the wizard at the rule
section with its contract, document and name loaded. The starting point
is recovered by asking each one whether it can read the document back
into blanks; a document no starting point recognises opens in JSON
mode. Saving an edit goes through the engine, which re-validates the
document and keeps the rule's identity and history.

**JSON mode.** An alternative to the sentence in the rule section: the
document as editable JSON, validated as it is typed with problems shown
against their path. It is how rules outside the starting points are
written, and how a rule exported from one installation is pasted into
another.

## Units

Not built yet. Reads are raw integers, which is exact but hard to read:
a vault's `totalAssets` is a 24-digit number. The language's numbers
are exact decimals and `scale` shifts a value by a power of ten, so a
typed amount can be entered in whole tokens and compared against the
read scaled by `-decimals`. For display, the wizard reads `decimals()`
when the contract has it and keeps it in the rule's display settings
(`display_decimals`, `DATABASE.md`). Until then, large values show in
scientific notation and typed numbers are raw.

## API

All under `/api/v1`, all JSON, all requiring a session as specified in
`AUTHENTICATION.md`. Errors use the API's error envelope with a stable
`code`. Field names are camelCase; the rule document inside keeps the
engine's snake_case.

| Method | Path | Purpose |
|-|-|-|
| GET | `/engine` | `{ chainId, responseMode, simulated }` |
| GET | `/contracts/:address/abi` | `{ chainId, address, name, abi, implementation }` on the engine's chain, or `400 invalid_contract`, `404 not_verified`, `502 lookup_failed` |
| POST | `/rules` | body `{ rule, checkOnly }`; see below |
| GET | `/rules` | all rules, newest first: `{ id, rule, sentence, enabled, origin, createdAt }` |
| GET | `/rules/:id` | one rule (not built yet) |
| PUT | `/rules/:id` | replace the document (not built yet) |
| PATCH | `/rules/:id` | `{ enabled }` (not built yet) |
| DELETE | `/rules/:id` | remove (not built yet) |

`POST /rules` is the one way in, and follows the MCP server's
`submit_rule`. With `checkOnly` it stores nothing and answers `200`
with the check:

```json
{
  "valid": true,
  "issues": [],
  "sentence": "On every block, notify when totalAssets() falls below totalSupply() (critical).",
  "evaluation": {
    "block": 21000000,
    "wouldTripNow": false,
    "reads": [{ "call": "totalAssets()", "value": "1234567890000000000000" }]
  },
  "warmupSeconds": 0,
  "duplicateOf": null,
  "simulated": true
}
```

An invalid document answers `valid: false` with every issue. Without
`checkOnly`, a valid document is stored and answers `201` with the
check plus `id` and `stored: true`; otherwise `400 invalid_rule` with
the issues, `409 duplicate` with `duplicateOf`, or `409 name_taken`.
Duplicates are compared in canonical form (sorted keys, lowercase
addresses) on the contract, trigger, condition and response, ignoring
name, description and severity.

Values in `reads` are decimal strings, because they exceed what a JSON
number can hold.

### ABI lookup

The server asks Sourcify, which needs no API key, for the contract's
ABI, name and proxy resolution, on the engine's chain. When the
contract is a proxy, the server also fetches the first
implementation's ABI and merges the two, so the implementation's
functions are offered alongside the proxy's. Results are cached in
memory for the life of the process; a verified ABI does not change.
This is the application's only outbound request that is not to the
engine, and it carries nothing but a chain ID and an address.

## Engine boundary

The server forwards checks and submissions to the engine, which
validates them again and owns the stored rules. Until the engine is
available, a stand-in inside the server answers instead:

- it reports Ethereum as its chain and `prepare` as its response mode;
- it keeps rules in memory, refuses duplicates, and keeps names unique
  per contract;
- it checks rules against deterministic simulated values that drift
  slowly over time;
- every metric is warming, as it would be for a new rule with no
  history, so a rule over a metric never trips in a check.

Every answer from the stand-in is marked `simulated`.

## Decisions

| # | Decision | Recommendation and reason |
|-|-|-|
| WZ1 | Starting points or a free-form expression builder | Starting points, plus JSON mode for everything else. A visual tree editor is a large UI that still exposes engine vocabulary; the common rules fit a sentence |
| WZ2 | Polarity | The user states what must hold; the document states the violation. The engine's language puts the bad condition in `trip_when` so that an unknown never trips; the wizard keeps the invariant's reading in its sentences, and each starting point writes the negation |
| WZ3 | Where starting points live | The dashboard. They are wording and defaults, the engine ships no catalogue, and a stored rule does not reference them, so they can change without touching rules |
| WZ4 | ABI source | Sourcify by default, pasted ABI as the fallback. No API key to configure, and proxies resolve automatically |
| WZ5 | Percentages | Whole numbers in the sentence. The language takes decimals, so finer control is a JSON-mode rule |
| WZ6 | Windows | A fixed list of durations, all inside the engine's 60 seconds to 30 days. Arbitrary seconds invite mistakes, and the list covers the cases the starting points target |
| WZ7 | Storing a rule that would trip now | Allowed, with Review saying so. Refusing it blocks writing a rule during an incident |
| WZ8 | Simulation conditions (`simulate`) | Left out of the starting points. They need calldata and fit neither a sentence nor a check at the head |
| WZ9 | Reading values through functions with arguments | Left out of the pickers for now; `view_call` takes `args`, so JSON mode can express them |
| WZ10 | Wizard-created rules | Enabled on creation. A person built and reviewed it; MCP submissions stay disabled until a person enables them |
| WZ11 | Held for approval or sent at once | Per installation, not per rule. The engine treats it as response configuration, so the wizard chooses only what a trip pauses |
| WZ12 | Chain | One per installation, reported by the engine. No chain picker |
| WZ13 | Reads from functions that return several values | Always name `returns`, even for the first output, so a read never depends on how a missing index is treated |

## Open questions

1. **Registered contracts.** The rules wizard is meant to read the
   engine's `contracts` view (`DATABASE.md`), and registering a
   contract is a person's decision made where contracts are added
   (`MCP-SERVER.md`, MC3). Today the wizard takes any verified address.
   Either the Contract section picks from registered contracts and can
   add one inline, or it sends the user to Contracts first.
2. **Issue codes.** The mirror reports Zod's codes; the engine's own
   codes should replace them once its schema is published with them.
3. **Tuple reads.** Whether `returns` may be omitted for a function
   that returns several values (WZ13 avoids depending on it).
4. **Response mode.** Where the application reads the installation's
   response mode from: the engine's control interface, a view, or its
   own configuration.

## Implementation notes

| Where | What |
|-|-|
| `packages/shared/src/rule.ts` | the Zod mirror of the rule document and its types |
| `packages/shared/src/describe.ts` | a rule read back as a sentence; number and duration formatting |
| `packages/shared/src/api.ts` | the API's shapes: engine info, check, stored rule |
| `packages/server/src/abi.ts` | the ABI lookup route and proxy merge |
| `packages/server/src/mock-engine.ts` | the stand-in: store, checks, simulated values |
| `packages/web/src/lib/abi.ts` | extracting values, events and functions from an ABI |
| `packages/web/src/lib/templates.ts` | the starting points and their defaults |
| `packages/web/src/components/wizard/` | the sections, the sentence with blanks, the pinned stepper, the simulated trip |
| `packages/web/src/pages/NewRule.tsx` | the wizard page and its state |

Tests: the schema accepts every starting point's output, nested
conditions, metrics, event rules and decimal literals, and rejects bad
addresses and signatures, array parameters, numbers that are not
strings, unknown fields, windows out of range, a metric window given
or missing wrongly, a zero band, a function on a non-function trip, and
event arguments the trigger does not have, each located by its JSON
pointer; rules read back as sentences; each starting point builds a
valid document from its defaults for a sample ABI, states the
violation, and builds nothing while a blank is empty; ABI extraction
offers one value per integer output, names events in declaration
style, and leaves out what rules cannot reference; the API checks
without storing, reports a rule that would trip now and a warm-up,
stores and lists rules, refuses duplicates and taken names, merges a
proxy's ABI on the engine's chain, and maps an unverified contract and
an unreachable Sourcify to `404` and `502`.
