# Invariant Wizard

How a person creates and edits an invariant in the dashboard. This
covers the wizard's flow, the templates, the rule format it produces,
the live preview, and the API behind them. How the engine evaluates a
rule once it is saved is out of scope; so is the MCP server, except
where it shares the same path.

## Terms

| Term | Meaning |
|-|-|
| invariant | a named statement about a contract that should always hold, together with what Tripwire does when it breaks |
| rule | the invariant's equation: the condition the engine evaluates, written in the rule format below |
| template | a sentence with blanks that builds one shape of rule |
| draft | an invariant that has not been saved: contract, rule, response and name |
| dry run | evaluating a draft's rule against current values without saving it |

## Why

A rule is an expression tree: reads from contracts, arithmetic,
historical values, comparisons. Writing that tree by hand is slow and
easy to get subtly wrong, and a rule the engine cannot evaluate is
worse than none, because it looks armed and never fires. Most useful
invariants are one of a handful of shapes ("this never drops below
that", "this never moves more than 5% in an hour"). The wizard makes
those shapes a sentence to fill in, shows the rule running against
live values before it is saved, and refuses anything the engine could
not evaluate.

## Principles

- **Sentence first.** Common invariants are built from templates, in
  plain words. The expression tree stays underneath, visible on request.
- **One schema, checked everywhere.** The rule format is a Zod schema
  in `shared`. The wizard checks drafts as they are edited, the server
  checks them again on every request, and the MCP server uses the same
  schema. Nothing is saved that fails it.
- **See it run before it is armed.** Every valid draft is dry-run
  continuously while the wizard is open.
- **Human units.** Percentages, durations and names from the ABI. The
  user never types a selector, a hex topic or a number of seconds.
- **One way in.** The wizard, the MCP server and rule import all submit
  the same draft to the same endpoint.

## Flow

A full page at `/invariants/new`, inside the navigation shell. Five
steps on the left, the live preview on the right. Steps already
completed can be revisited; a later step opens only when every step
before it is complete.

| Step | Asks | Complete when |
|-|-|-|
| 1 Contract | chain and address, or a pasted ABI | an ABI is loaded |
| 2 Template | which kind of invariant | a template is picked (picking one moves to step 3) |
| 3 Rule | the blanks in the template's sentence | the built rule passes the schema |
| 4 Response | what happens when it breaks | function scope, if chosen, names a function |
| 5 Review | a name | the name is not empty; submitting creates the invariant |

Changing the contract clears the template, the blanks and the name.
Picking another template resets the blanks to that template's defaults.

## Contract

The user picks a chain and pastes an address. As soon as the address
is valid, the server looks up the contract's verified ABI (see
[ABI lookup](#abi-lookup)). The step then shows the contract's name,
whether it is a proxy and which implementation it points to, and how
many values, events and functions the wizard can offer.

When there is no verified source, or the user prefers, the ABI can be
pasted instead: a bare JSON array or any object with an `abi` field (a
compiler artifact). A pasted ABI takes precedence over the lookup.

From the ABI the wizard extracts:

| Offered as | Taken from |
|-|-|
| values | `view` and `pure` functions with no inputs, one entry per integer output; a function returning several values offers each, named `function.output` (e.g. `latestRoundData.updatedAt`) |
| events | every event, by canonical signature |
| functions to pause | every non-view function, with its 4-byte selector computed from the canonical signature |

## Templates

Each template is a sentence with typed blanks and a builder that turns
the filled blanks into a rule. Blanks are pre-filled when the wizard
opens a template: values by preferred names (`totalAssets` for a
balance, `updatedAt` for a timestamp), skipping constants such as
`decimals` and `version`; numbers with a sensible default. A template
the contract cannot support (no readable values, or no events) is
shown disabled with the reason.

| Template | Sentence | Rule |
|-|-|-|
| Never drops below | *value* never drops below *value or number* | `value ≥ floor` |
| Stays near its average | *value* stays within *n*% of its *window* average | deviation band of *n*% around the *window* time-weighted average of *value* |
| Growth limit | *value* grows by at most *n*% in *window* | change of *value* over *window* ≤ *n*% of *value* |
| Outflow limit | *value* falls by at most *n*% in *window* | drop of *value* over *window* ≤ *n*% of *value* |
| Stays fresh | *timestamp* is never more than *window* old | `now − timestamp ≤ window` |
| Event never appears | *event* is never emitted | log rule, `must_not_appear` |
| Custom comparison | *value* *comparison* *value or number* | `left op right` |

Blank types:

| Blank | Input | Stored as |
|-|-|-|
| value | a dropdown of the contract's values | a `view_call` |
| value or number | the same dropdown plus "a fixed number…", which opens a number field | a `view_call` or a `literal` |
| percent | whole number, 0 to 999 | `band_percent`, or `numerator` over `denominator` 100 |
| window | 5 minutes, 15 minutes, 20 minutes, 1 hour, 6 hours, 24 hours, 7 days | whole seconds |
| comparison | is at least, is above, is at most, is below, equals, never equals | `gte`, `gt`, `lte`, `lt`, `eq`, `neq` |
| event | a dropdown of the contract's events | the canonical signature |

Templates live in the dashboard (`packages/web/src/lib/templates.ts`)
because they are presentation: sentences, defaults, labels. The rules
they build are plain schema values, so an invariant does not depend on
the template that made it.

## Rule format

An invariant **holds while its condition is true**. The engine records
a violation when the condition becomes false.

A rule is one of:

| Kind | Fields |
|-|-|
| `expression` | `condition`: a condition tree |
| `log` | `event`: canonical signature; `condition`: `must_not_appear` or `must_appear`; optional `match` on indexed topics (`topic1`–`topic3`, each also as `_neq`) and on the data value (`data_gte`, `data_lte`) |

Conditions:

| Type | Fields | True when |
|-|-|-|
| `compare` | `op`, `left`, `right` | `left op right` |
| `deviation_band` | `value`, `center`, `band_percent`, optional `downward_only` or `upward_only` | `value` is within `band_percent`% of `center` (one-sided if flagged) |
| `and`, `or` | `conditions` (at least one) | all, or any, hold |
| `not` | `condition` | the inner condition does not hold |

Values:

| Type | Fields | Value |
|-|-|-|
| `view_call` | `contract`, `method`, optional `args`, optional `return_index` | the result of calling the view function |
| `literal` | `value` | an unsigned 256-bit integer, decimal or `0x` hex |
| `now` | | the current time in unix seconds |
| `arithmetic` | `op` (`add`, `sub`, `mul`, `div`), `left`, `right` | integer arithmetic |
| `sum` | `operands` (at least one) | the total |
| `scale` | `value`, `numerator`, `denominator` | `value × numerator ÷ denominator` |
| `historical` | `key`, `source`, `metric` | a value derived from the history of `source` |

Historical metrics: `ath` (all-time high), `prev_block`, `moving_avg`
with `window` in blocks, and `twap`, `windowed_delta` and
`windowed_drop` with `window_secs`. `key` names the series the engine
keeps for the metric; the wizard derives it from the source and window
(e.g. `totalAssets()#0:twap:1200`), so two invariants over the same
series share it.

Limits the schema enforces, all of them things the engine would
otherwise reject silently: literals are whole numbers no larger than
2^256 − 1; `band_percent`, windows, `numerator` and `denominator` are
whole numbers, with windows and `denominator` above zero; addresses
are 20-byte hex; methods and events look like `name(types)`; topics
are 32-byte hex.

Every value is an integer. Token amounts are compared in the token's
smallest unit, so a fixed number typed into a blank is in that unit
too; see [Units](#units).

## Response

| Field | Values |
|-|-|
| `mode` | `alert`: record and notify, nothing on-chain; `approval`: prepare the pause and hold it in Responses for a person to approve; `autonomous`: pause immediately |
| `scope` | `contract`: the whole contract; or `function` with `selector` and `signature`: one function. Only asked for when the mode is not `alert` |
| `cooldownSecs` | quiet period after a trip before the same invariant can act again: none, 1 minute, 5 minutes (default), 1 hour |

The response says what the user wants; how the engine carries it out,
and whether the contract is registered for on-chain response at all,
belong to the engine and to response-mode onboarding in Settings. The
wizard shows a notice when a pausing mode is chosen for a contract that
is not yet registered for response, once that state is readable.

## Live preview

The preview panel is visible on every step. Once a contract is loaded
it shows the contract; once the rule is valid it shows the sentence as
filled in, the rule as an equation (`totalAssets ≥ totalSupply`), and a
dry run.

The dashboard dry-runs the current rule every 2 seconds for as long as
the rule stays the same, and starts over when it changes. The panel
shows:

- the two values being compared, with their labels;
- a sparkline of both over the last 40 dry runs;
- **Holds** or **Would trip**, with one line of detail: the margin to
  the limit, the distance from a band's center, or for an event rule
  whether it was seen recently;
- **Simulated** while values come from the stand-in rather than the
  chain.

A dry run is advisory. A rule that would trip right now can still be
saved; the user may be writing the invariant for an incident in
progress.

## Review and create

Review shows the name, pre-filled from the template (`totalAssets
floor`) and editable up to 80 characters; a summary of what is watched,
the invariant as a sentence, and the response; and the draft as JSON
behind a disclosure. Creating submits the draft and, on success, opens
the invariants list with the new invariant highlighted.

An invariant created in the wizard is enabled immediately. One created
over MCP is created disabled and shows a "created via MCP" badge until
a person enables it.

## Editing

Not built yet. Opening an existing invariant starts the wizard at step
3 with its contract, rule, response and name loaded. The template is
recovered by asking each template whether it can read the rule back
into blanks; a rule no template recognises opens in JSON mode.
Saving an edit replaces the rule and response and keeps the
invariant's identity and history.

**JSON mode.** A step-3 alternative to the sentence: the rule as
editable JSON, validated as it is typed with errors shown against
their path. It is how rules outside the templates are written, and how
a rule exported from one installation is pasted into another.

## Units

Not built yet. Values are compared as raw integers, which is exact but
hard to read: a vault's `totalAssets` is a 24-digit number. For display
only, the wizard reads `decimals()` when the contract has it and shows
amounts scaled by it, and typed amounts are entered in whole tokens and
converted to the smallest unit when the rule is built. Until then,
large values show in scientific notation and typed numbers are raw.

## API

All under `/api/v1`, all JSON, all requiring a session as specified in
[AUTHENTICATION.md](AUTHENTICATION.md). Errors use the API's error
envelope with a stable `code`.

| Method | Path | Purpose |
|-|-|-|
| GET | `/contracts/:chainId/:address/abi` | `{ chainId, address, name, abi, implementation }`, or `400 invalid_contract`, `404 not_verified`, `502 lookup_failed` |
| POST | `/invariants/preview` | body: a rule; returns `{ holds, terms: [{ label, value }], detail, simulated }`, or `400 invalid_rule` with `issues: [{ path, message }]` |
| GET | `/invariants` | all invariants, newest first |
| POST | `/invariants` | body: a draft; returns the invariant with `id`, `enabled` and `createdAt`, or `400 invalid_rule` |
| GET | `/invariants/:id` | one invariant (not built yet) |
| PUT | `/invariants/:id` | replace rule, response and name (not built yet) |
| PATCH | `/invariants/:id` | `{ enabled }` (not built yet) |
| DELETE | `/invariants/:id` | remove (not built yet) |

Values in `terms` are decimal strings, because they exceed what a
JSON number can hold.

### ABI lookup

The server asks Sourcify, which needs no API key, for the contract's
ABI, name and proxy resolution. When the contract is a proxy, the
server also fetches the first implementation's ABI and merges the two,
so the implementation's functions are offered alongside the proxy's.
Results are cached in memory for the life of the process; a verified
ABI does not change. This is the application's only outbound request
that is not to the engine, and it carries nothing but a chain ID and an
address.

## Engine boundary

The server forwards drafts and dry runs to the engine, which validates
them again and owns the stored invariants. Until the engine is
available, a stand-in inside the server keeps invariants in memory and
dry-runs rules against deterministic simulated values that drift slowly
over time, so the wizard can be built and demonstrated end to end.
Every dry run from the stand-in is marked `simulated`.

## Decisions

| # | Decision | Recommendation and reason |
|-|-|-|
| WZ1 | Templates or a free-form expression builder | Templates, plus JSON mode for everything else. A visual tree editor is a large UI that still exposes engine vocabulary; the common invariants fit a sentence |
| WZ2 | Rule polarity | a rule states what must hold, and a violation is the condition becoming false. It reads the same way as the invariant it encodes |
| WZ3 | Where templates live | the dashboard. They are wording and defaults; the saved rule does not reference them, so templates can change without migrating invariants |
| WZ4 | ABI source | Sourcify by default, pasted ABI as the fallback. No API key to configure, and proxies resolve automatically |
| WZ5 | Percentages | whole numbers. The engine's band is an integer percentage; finer control is a JSON-mode rule with `scale` |
| WZ6 | Windows | a fixed list of durations. Arbitrary seconds invite mistakes, and the list covers the cases the templates target |
| WZ7 | Saving a rule that would trip now | allowed, with the preview saying so. Refusing it blocks writing an invariant during an incident |
| WZ8 | Pre/post-transaction simulation rules | left out. They need raw calldata and fit neither a sentence nor the preview |
| WZ9 | Reading values through functions with arguments | left out of the pickers for now; the rule format supports `args`, so JSON mode can express them |
| WZ10 | Wizard-created invariants | enabled on creation. A person built and reviewed it; MCP-created ones stay disabled until a person enables them |

## Open questions for the engine

1. Confirm the polarity in WZ2 and the rule JSON above, or name the
   differences so the server can translate.
2. How a dry run reports a historical metric that has no history yet
   (a new series has no 24-hour change): a separate "warming up" state
   in the preview is proposed.
3. Whether `key` for a historical series is chosen by the application,
   as here, or assigned by the engine.

## Implementation notes

| Where | What |
|-|-|
| `packages/shared/src/rule.ts` | the Zod schema and the rule, response and draft types |
| `packages/shared/src/describe.ts` | a rule as a one-line equation; number and duration formatting |
| `packages/server/src/abi.ts` | the ABI lookup route and proxy merge |
| `packages/server/src/mock-engine.ts` | the stand-in store and simulated dry runs |
| `packages/web/src/lib/abi.ts` | extracting values, events and functions from an ABI |
| `packages/web/src/lib/templates.ts` | the templates and their defaults |
| `packages/web/src/components/wizard/` | the steps, the sentence with blanks, the preview panel |
| `packages/web/src/pages/NewInvariant.tsx` | the wizard page and its state |

Tests: the schema accepts every template's output and nested trees,
and rejects fractional and oversized literals, fractional bands, bad
addresses and method names, and malformed function scopes; each
template builds a valid rule from its defaults for a sample ABI, and
builds nothing while a blank is empty; ABI extraction offers one value
per integer output and computes selectors; the API answers dry runs,
rejects invalid rules with their paths, creates and lists invariants,
merges a proxy's ABI, and maps an unverified contract and an
unreachable Sourcify to `404` and `502`.
