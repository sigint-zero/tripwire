# MCP server

How AI agents work with Tripwire. The application exposes a Model
Context Protocol server; a user points their own agent at it. This
document specifies what that server teaches, what it exposes, and the
one thing it lets an agent do.

Vocabulary follows the engine's rule language. A **rule** is one
watchable statement about a contract: a condition that should never
occur, and what to do when it does. Most rules encode **invariants**,
properties that must always hold, written as their violation. Others
watch for occurrences that are not strictly invariants: an ownership
transfer, a large outflow, an oracle going stale. One document shape
covers both, and this server teaches an agent to find both.

## Purpose

The server does three things, in this order, and nothing else:

1. **Teach.** Before an agent looks at a single contract it learns what
   a rule is, how to find the invariants and occurrences worth watching
   in an EVM protocol, how the rule language expresses them, and what
   mistakes produce false alarms or silent gaps.
2. **Show.** The agent can read a registered contract in full (ABI,
   verified source when available, live values, the addresses it
   depends on) and the rules already mapped onto it with their current
   detection state.
3. **Submit.** The agent can propose a new rule. The server validates
   it, evaluates it once at the chain head, checks it is not a
   duplicate, and stores it disabled, notify-only, attributed to the
   agent. A person enables it in the dashboard.

Not in this version: reading violations, editing or removing rules,
enabling anything, registering contracts, touching response settings,
keys, alert channels or tokens. The agent proposes detection; every
other decision stays with a person.

## Who connects and how

Authentication is specified in `AUTHENTICATION.md`: the endpoint accepts
an MCP token in `Authorization: Bearer` and nothing else. The server is
mounted inside the application server at `/mcp` (streamable HTTP
transport). Agent hosts that only launch local stdio servers run
`tripwire mcp`, a bridge that forwards to `/mcp` with the token from
`TRIPWIRE_MCP_TOKEN`.

The server is stateless between requests. It keeps no per-agent memory
and no conversation; every call carries what it needs. Everything an
agent creates is attributed to the token's label.

## The teaching layer

An agent host injects the server's instructions into the model's
context when it connects, and the model can read resources on demand.
Those two channels are the teaching layer, and the quality of the whole
feature rests on them. They are versioned content files in
`packages/mcp/content/`, reviewed like code.

### Server instructions

The instructions are short, because hosts truncate long ones, and they
point at the resources for depth. Required content, in this order:

1. What Tripwire is in two sentences: it watches contracts every block,
   evaluates rules, records violations with evidence, alerts, and can
   pause a contract through its on-chain circuit breaker.
2. What a rule is: one watchable statement whose `trip_when` states the
   bad condition, plus a trigger and a consequence. Most rules encode
   invariants; some watch occurrences. Warm-up never trips. Unknown
   means do not trip.
3. The workflow the agent must follow, as numbered steps: read
   `tripwire://guide/method`, then `tripwire://guide/rule-language`;
   call `list_contracts`; `get_contract` for the target; `list_rules`
   for what already exists; draft; `submit_rule` with
   `check_only: true` until clean; submit; tell the user what was
   proposed and that each rule lands disabled for their review.
4. Standing orders: never duplicate an existing rule; one statement per
   rule; thresholds justified from the live values and source, and the
   justification written in `description`; prefer the simplest node
   that expresses the statement; names a person can read in a list.
5. What the agent cannot do here, so it does not try or claim to.

### Resources

All under the `tripwire://` scheme. Static ones are served from the
content files; the schema is the pinned engine artefact served
verbatim.

| URI | Content |
|-|-|
| `tripwire://guide/method` | how to determine the rules for an EVM contract; the core of the teaching layer, outlined below |
| `tripwire://guide/rule-language` | a primer on the rule document with one example per node type, followed by the full JSON schema of the pinned engine version |
| `tripwire://guide/metrics` | the historical metrics one by one: what each measures, window semantics, warm-up, which questions each answers, worked numbers |
| `tripwire://guide/examples` | the starting-point catalogue: complete rule documents by contract archetype with a sentence on when to use each and what to change |
| `tripwire://guide/pitfalls` | the false-alarm and silent-gap catalogue |
| `tripwire://schema/rule` | the raw pinned rule schema, for hosts that validate client-side |

### The method

`tripwire://guide/method` teaches a procedure, not a list of rules to
copy. Its required content:

**Step 1, understand the contract.** Read the ABI and source with a
purpose: what does this contract hold, who can move it, what does it
trust, and what does it promise. Write down the answers before drafting
anything. The `get_contract` result gives the material: view functions
are the observable state, mutators are the ways it changes, events are
what it announces, linked addresses are what it trusts (an asset, an
oracle, a pool, an owner, an implementation).

**Step 2, ask the five questions.** The first four find invariants,
the fifth finds occurrences. Each maps to a shape in the rule language.

| Question | What it finds | Typical shape |
|-|-|-|
| What must be conserved? | accounting identities: total assets cover total supply, the sum of parts equals the whole, shares redeem for at least what they were minted for | `every_block` + `compare` between two `view_call`s or a `sum` |
| What must stay within bounds? | ratios and limits: utilisation under 100%, collateral ratio above the minimum, price within a band of its reference | `compare` against a `literal`, or `deviation_band` against another `view_call` |
| What must move slowly? | rate limits: supply, balances or prices change by at most so much over a window; no sudden drawdown | `deviation_band` or `compare` against a `metric` (`moving_avg`, `twap`, `windowed_delta`, `windowed_drop`, `ath`) |
| What must stay fresh or alive? | liveness: an oracle updated recently, a reference withdrawal still succeeds, a heartbeat still ticks | `compare(now - view_call(updatedAt), literal)`, or `simulate` with `yields: reverted` |
| What must never happen? | occurrences: ownership transferred, implementation upgraded, paused, admin added, a mint from the zero address beyond a size | event trigger + `true`, or a comparison on `event_arg` |

The guide walks one real-shaped contract through all five questions so
the agent sees the questions produce rules, and also sees questions
that produce nothing for that contract, which is the normal case.

**Step 3, look outward.** Most losses come through what a contract
trusts, not what it holds. For every linked address ask the five
questions again from this contract's point of view: the oracle it reads
(staleness, deviation from a time-weighted reference), the asset it
holds (its supply, its own owner), the pool it prices against, the
implementation behind its proxy. Cross-contract `view_call`s and event
triggers with an explicit `address` exist for this.

**Step 4, set thresholds from evidence.** A threshold is a claim about
normal behaviour, so it is derived from the live values, the source
(hard caps, fee constants, decimals) and the existing rules, never
guessed. The guide gives the procedure: read the current value; find
the contract's own limits in source; choose a band or window that
normal activity cannot cross but an incident would; state the reasoning
in `description`. Start wide and let a person tighten; a rule that
fires in the first hour is discarded, a rule that fires only in an
incident is kept.

**Step 5, size windows to the contract's rhythm.** A window is
`{ "seconds": n }`, 60 seconds to 30 days, sampled per block. It should
cover several natural cycles of the value it watches: an oracle that
updates hourly needs a multi-hour window; a busy pool's price can use
minutes. The guide lists rhythms by archetype and reminds the agent
that warm-up equals the window: a 30-day window is 30 days of silence.

**Step 6, write it down properly.** `name` is what a person reads in a
list at three in the morning; the guide gives good and bad examples.
`description` carries the statement in words, the evidence behind the
threshold, and what a violation would mean. `severity` follows a stated
scale: `critical` for loss of funds or control, `warning` for
conditions that precede loss, `info` for hygiene. `on_trip` is always
`notify` from an agent; `cooldown_seconds` is set when a condition can
stay true for many blocks.

**Step 7, check before you submit.** `submit_rule` with
`check_only: true` returns the engine's verdict, the rule read back as
an English sentence, the values each `view_call` produced at the head,
whether the rule would fire right now, and how long it will warm up.
A rule that would fire now is wrong unless the agent can say why the
contract is already in violation. The sentence must say what the agent
meant.

**Archetypes.** The guide closes with a table of common contract kinds
and the rules that nearly always apply, each pointing at an entry in
`tripwire://guide/examples`:

| Archetype | Nearly always |
|-|-|
| ERC-20 | supply within cap or slow-moving; no mint beyond a size; owner unchanged; not paused unexpectedly |
| ERC-4626 vault | totalAssets covers totalSupply at the current share price; share price monotone or slow-moving; reference redeem succeeds; asset address unchanged |
| lending pool | utilisation bound; reserves cover deposits; collateral factor changes are events to watch; oracle freshness and deviation |
| AMM pool | reserve product or price within band of a time-weighted reference; large single-block reserve drops; fee parameter changes |
| price oracle and consumers | updated within heartbeat; answer within band of its own average; answer within band of a second source |
| proxy | implementation unchanged (event and view); admin unchanged |
| governance and timelock | delay parameter unchanged; proposal executed events; guardian or owner changes |
| bridge and escrow | locked balance covers minted supply on this side; large single withdrawal; pauser changes |

### Pitfalls

`tripwire://guide/pitfalls` lists the ways rules go wrong, each with
the symptom and the fix: decimals mismatch between two values (use
`scale`); rebasing or fee-on-transfer tokens breaking conservation
identities; comparing a raw integer against a human number; windows
shorter than the value's update interval; deviation bands around a
reference that is itself the monitored value; event filters on
arguments the event does not have; event signatures written without
parameter names; array or tuple parameters, which the language does
not take in version 1; `every_block` rules with many
`view_call`s on a busy chain; duplicating an existing rule with
different wording; thresholds copied from another protocol; forgetting
that a `simulate` reverting is a signal in one form (`yields:
reverted`) and an evaluation error in the other (`yields: value`).

### Prompt

One MCP prompt, `propose_rules`, with a single argument (a contract
address or name). It expands to the workflow from the instructions
applied to that contract, ending with the instruction to present
proposals to the user grouped by the five questions, with each rule's
English sentence and its justification. Hosts surface prompts as slash
commands, so this is the one-line way to start.

## Tools

Four tools. Inputs and outputs are JSON with snake_case fields. Numbers
that are on-chain quantities are decimal strings, as in the rule
language. Every tool description restates the step of the workflow it
belongs to.

### `list_contracts`

No input. Returns every registered contract:

```json
[
  {
    "id": "c_3f2a",
    "name": "Treasury Vault",
    "address": "0x…",
    "chain_id": 1,
    "active": true,
    "rule_count": 4,
    "tripped": false,
    "has_source": true
  }
]
```

`active: false` means a person has disabled the contract: its rules
were switched off together and come back together when the contract is
enabled. An agent may still study it and submit rules to it.

### `get_contract`

Input: `{ "contract": "<id | address | name>", "source": "none" | "list" | "<path>" }`.
`source` defaults to `list`.

Returns:

```json
{
  "contract": { "id": "c_3f2a", "name": "…", "address": "0x…", "chain_id": 1, "active": true },
  "abi": {
    "views":    [ { "signature": "totalAssets()", "inputs": [], "outputs": ["uint256"] } ],
    "mutators": [ { "signature": "withdraw(uint256,address,address)", "inputs": ["uint256","address","address"] } ],
    "events":   [ { "signature": "Withdraw(address indexed caller, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)" } ]
  },
  "state": {
    "block": 21000000,
    "values": [ { "function": "totalAssets()", "value": "1234567890000000000000", "type": "uint256" } ],
    "decimals": 18
  },
  "linked": [ { "function": "asset()", "address": "0x…", "registered_as": "c_9b10" } ],
  "source": {
    "verified": true,
    "compiler": "0.8.24",
    "files": [ { "path": "src/Vault.sol", "bytes": 18234 } ],
    "content": null
  }
}
```

- Signatures are given exactly as the rule language wants them:
  functions as bare positional signatures, events in declaration style
  with parameter names and `indexed` markers, so the agent can paste
  them into `function`, `event`, `filters` and `event_arg` unchanged.
  Functions and events with array or tuple parameters carry
  `"unsupported": "array or tuple parameters are not available in
  language version 1"` so the agent does not draft against them.
- `state.values` are the zero-argument view functions evaluated at the
  current head through the engine. Tuples are returned as arrays.
  Functions that revert are listed with `"error"` instead of `"value"`.
  When the engine is unavailable `state` is replaced by
  `{ "unavailable": "engine is not running" }` and the rest still
  returns.
- `decimals` is present when the contract exposes `decimals()`.
- `linked` is every zero-argument view returning an address, with the
  registered contract id when that address is also registered. This is
  how the agent finds the oracle, asset, owner and implementation.
- `source` is what the application stored when the contract was added
  (fetched from a verification service or pasted). The server never
  fetches from the internet on an agent's behalf. `list` returns paths
  and sizes; a path returns that file's `content`; any single response
  is capped at 200 KB and says so when truncated.

### `list_rules`

Input: `{ "contract": "<id | address | name>" }`, or empty for all.

Returns each rule mapped onto the contract with its detection state:

```json
[
  {
    "id": "r_77c1",
    "rule": { "version": 1, "name": "…", "trip_when": { "…": "…" } },
    "sentence": "On every block, notify when totalAssets() falls below totalSupply() (critical).",
    "enabled": true,
    "origin": "dashboard",
    "status": "ok",
    "current": { "series": "totalAssets()", "value": "1234567890000000000000", "block": 21000000 },
    "warmup_remaining_seconds": 0,
    "violations_24h": 0,
    "created_at": "2026-09-20T10:00:00Z"
  }
]
```

- `rule` is the canonical document, so the agent sees exactly what the
  engine evaluates and can avoid restating it.
- `sentence` is the engine's `describe` output.
- `origin` is `"dashboard"` for rules the application created (the
  wizard or an import), `{ "mcp": "<token label>" }` for agent
  submissions, with the label read from `app.rule_submissions`, or
  `"api"` for rules created directly against the engine's interface.
- `status` is one of `ok`, `violated`, `warming_up`, `eval_error`,
  `disabled`.
- `current` is the first recorded series of the rule at its last
  evaluation, when there is one.

### `submit_rule`

Input:

```json
{
  "rule": { "version": 1, "name": "…", "contract": "0x…", "severity": "warning",
            "when": "every_block", "trip_when": { "…": "…" },
            "on_trip": { "action": "notify" } },
  "display_decimals": 18,
  "check_only": false
}
```

The server, in order:

1. resolves `rule.contract` to a registered contract; unknown addresses
   are refused with `contract_not_registered` and the instruction to
   ask the user to add it;
2. requires `on_trip.action` to be `notify`; anything else is refused
   with `response_not_allowed` and the sentence "agents propose
   detection; a person chooses the response in the dashboard";
3. sends the document to the engine for validation; issues come back as
   the engine reports them, `{ code, message, path }`, all of them at
   once;
4. asks the engine to evaluate `trip_when` once at the current head and
   collects every `view_call` value, the boolean result, the `describe`
   sentence and the needs report;
5. compares the document in the engine's canonical form (lowercase
   addresses, normalised signatures and numbers) against the contract's
   existing rules, ignoring `name`, `description` and `severity`; a
   match is reported as `duplicate_of`;
6. unless `check_only`, stores the rule through the engine with
   `enabled: false` and origin `mcp`, then records the token id and
   label in `app.rule_submissions` and `display_decimals`, when given,
   in `app.rule_prefs` (`DATABASE.md`).

Returns the same shape either way, plus `id` and `stored: true` after a
real submission:

```json
{
  "valid": true,
  "issues": [],
  "sentence": "On every block, notify when totalAssets() falls below totalSupply() (critical).",
  "evaluation": {
    "block": 21000000,
    "would_trip_now": false,
    "reads": [ { "call": "totalAssets()", "value": "1234567890000000000000" } ]
  },
  "warmup_seconds": 0,
  "duplicate_of": null,
  "id": "r_81d0",
  "stored": true,
  "next": "This rule is disabled until a person enables it in the dashboard."
}
```

An invalid document returns `valid: false` with `issues` and nothing
stored. A duplicate returns `duplicate_of` and nothing stored. If the
engine is unavailable the tool fails with `engine_unavailable`; there
is no submission path that skips validation.

## Guardrails

| Guard | Rule |
|-|-|
| response | `on_trip.action` must be `notify`; the person upgrades it |
| arming | every submission lands `enabled: false` |
| attribution | the engine records the rule's origin as `mcp`; the token id and label are kept in `app.rule_submissions` (`DATABASE.md`), and the dashboard shows the label on the "created via MCP" badge |
| duplicates | canonical-form match against existing rules on the same contract is refused |
| volume | 50 stored submissions per token per hour, counted from `app.rule_submissions`, configurable as `mcp.submissions_per_hour`; `check_only` calls do not count against it |
| size | document caps are the engine's (depth 32, 256 nodes, 32 calls); source responses cap at 200 KB |
| scope | no tool reads violations, edits, enables or disables rules or contracts, deletes, registers contracts, or touches settings |
| network | the server never fetches from the internet for an agent |

## Data and dependencies

Reads (`list_contracts`, `list_rules`, the static parts of
`get_contract`) come from the same service layer the dashboard uses.
Live values, validation, evaluation at head and the English sentence
come from the engine over its local interface, so with the engine down
the agent can still study a contract and the mapped rules but cannot
check or submit. The tools say so explicitly rather than degrading
quietly.

The rule schema and the example corpus are the engine's published
contract files, pinned by the application. The curated catalogue in
`tripwire://guide/examples` is the application's own content built on
top of that corpus: the engine judges documents and deliberately ships
no templates, so the starting points live here.

## Errors

Tool errors are structured and worded for the model to act on:

| Code | When |
|-|-|
| `contract_not_registered` | the document names an address the installation does not watch |
| `response_not_allowed` | `on_trip.action` is not `notify` |
| `invalid_rule` | validation failed; `issues` carries every problem with its JSON pointer |
| `duplicate` | a canonically equal rule exists; `duplicate_of` names it |
| `engine_unavailable` | the engine is not running or not ready |
| `rate_limited` | submission volume exceeded; includes the reset time |
| `not_found` | unknown contract, file path or rule |

## Package

`packages/mcp` exports a factory that takes the application's service
layer and returns an MCP server instance; `packages/server` mounts it at
`/mcp` behind the token check. Contents:

| Path | What |
|-|-|
| `content/instructions.md` | the server instructions |
| `content/method.md`, `metrics.md`, `examples/`, `pitfalls.md` | the resources |
| `src/tools/` | one file per tool: schema, handler, description |
| `src/resources.ts`, `src/prompts.ts` | wiring |
| `eval/` | the teaching evaluation, below |

The protocol implementation is the reference TypeScript SDK for MCP, a
deliberate dependency: the protocol has transport, capability
negotiation and schema details that are not worth reimplementing, and
the SDK is the project that defines them. Everything above it is ours.

## How we know the teaching works

Unit tests cover the tools against fixture data and a stub engine:
every guard refuses what it should, `check_only` stores nothing,
duplicates are detected across renames, a stored rule is disabled and
attributed, source truncation is reported.

The teaching layer is evaluated, not unit-tested. `packages/mcp/eval/`
holds three fixture contracts with ABI, source and state (an ERC-4626
vault over an ERC-20 with an oracle, a lending-style pool, a proxied
token) and, for each, a rubric: the rules a competent reviewer expects,
the thresholds the evidence supports, and traps (a rebasing asset, a
decimals mismatch, an already-covered statement). A script runs a
chosen model against the server with only the `propose_rules` prompt
and scores the run: coverage of expected rules, zero rules stored that
failed a check, zero duplicates, zero rules that would fire at
submission time, every name and description readable by the rubric's
standard. The pass bar is written in the rubric. Changes to the content
files run the eval before merging; a drop is a regression like any
other.

## Decisions

| # | Decision | Recommendation and reason |
|-|-|-|
| MC1 | Tool surface | four tools for the three capabilities. Validation is a mode of submission, not a fifth tool, so the agent cannot skip it |
| MC2 | Agent response power | none. `notify` only and disabled on landing. The human gate is the whole safety argument |
| MC3 | Contract registration by agents | no. Registering is where a person decides what Tripwire watches; agents work inside that |
| MC4 | Source fetching | the server serves what the application stored and never reaches the internet for an agent. Predictable, offline-safe, no new trust |
| MC5 | Protocol implementation | the reference MCP SDK. Hand-rolling a protocol is the wrong place to spend care |
| MC6 | Where the catalogue lives | here, on top of the engine's corpus. The engine judges, the application teaches |
| MC7 | Server memory | none. Stateless tools; the agent's context is its memory |
| MC8 | Violations access | not yet. It is the obvious next capability once proposals prove useful, and it needs its own thinking about evidence size |
| MC9 | Teaching quality | measured by a fixture eval with a written pass bar, run on content changes |
| MC10 | Vocabulary | "rule" for the document, as in the engine; "invariant" only for the property class most rules encode. One term for one thing across engine, application and agents |
