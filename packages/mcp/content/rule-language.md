# The rule language

A rule is a JSON document, version 1. The engine validates every document and stays the authority; `tripwire://schema/rule` is the full JSON schema. This primer shows each part once.

## The document

```json
{
  "version": 1,
  "name": "Vault assets cover shares",
  "description": "totalAssets must never fall below totalSupply: each share was minted against at least one unit of the asset. At the head both read about 4.3M; any shortfall means value left the vault without shares being burned.",
  "contract": "0x1111111111111111111111111111111111111111",
  "severity": "critical",
  "when": "every_block",
  "trip_when": {
    "node": "compare",
    "op": "lt",
    "left": { "node": "view_call", "function": "totalAssets() returns (uint256)", "args": [] },
    "right": { "node": "view_call", "function": "totalSupply() returns (uint256)", "args": [] }
  },
  "on_trip": { "action": "notify" }
}
```

| Field | Rule |
|-|-|
| `version` | always `1` |
| `name` | 1 to 120 characters, read by a person in a list |
| `description` | optional prose: the statement, the evidence behind the threshold, what a violation means |
| `contract` | the address of the registered contract the rule belongs to, never its id or name |
| `severity` | `critical` (loss of funds or control), `warning` (a condition that comes before a loss), `info` (hygiene) |
| `when` | the trigger: `"every_block"`, or an event |
| `trip_when` | the bad condition. The rule trips when it is true |
| `on_trip` | the consequence. From an agent always `{ "action": "notify" }`, optionally with `cooldown_seconds` |

**Polarity.** `trip_when` states the violation, never the invariant. "Assets cover shares" is written as assets falling below shares. Anything that cannot be known (a metric still warming up, an unreachable branch) does not trip.

**Numbers** are decimal strings, exact: `"1000"`, `"1.5"`, `"-0.03"`. Reads are the raw integers the chain returns: a USDC balance of 1,000 tokens reads `"1000000000"`. Use `scale` to compare values with different decimals.

**Signatures** are exact. A function whose value is read declares its returns: `"totalSupply() returns (uint256)"`, `"getReserves() returns (uint112,uint112,uint32)"`. A function that is only called takes the bare form: `"withdraw(uint256)"`. Events are written in declaration style with parameter names and `indexed` markers: `"Transfer(address indexed from, address indexed to, uint256 value)"`. `get_contract` gives every signature in the form its field wants. Array and tuple parameters are not available in version 1.

**Caps.** A condition is at most 32 levels deep, 256 nodes, and 32 contract calls.

## Triggers

`"every_block"` evaluates the condition on every block.

An event trigger evaluates it on every matching log. `address` watches another contract's events (it defaults to the rule's contract), and `filters` narrow by argument:

```json
{
  "event": "Transfer(address indexed from, address indexed to, uint256 value)",
  "filters": [{ "arg": "from", "eq": "0x0000000000000000000000000000000000000000" }]
}
```

With an event trigger, `trip_when` may be `true` (every matching log trips), or a condition that reads the log's arguments with `event_arg`.

## Values

A **view_call** reads a function at the evaluated block. `address` reads another contract; `args` are strings; `returns` picks one output by index when the function returns several (it defaults to the first).

```json
{ "node": "view_call", "function": "getReserves() returns (uint112,uint112,uint32)", "args": [], "returns": 1 }
```

```json
{ "node": "view_call", "address": "0x2222222222222222222222222222222222222222", "function": "balanceOf(address) returns (uint256)", "args": ["0x1111111111111111111111111111111111111111"] }
```

A **literal** is a fixed number: `{ "node": "literal", "value": "1000" }`.

**now** is the block's timestamp in seconds: `{ "node": "now" }`.

An **event_arg** reads an argument of the triggering log, by name: `{ "node": "event_arg", "arg": "value" }`.

**arithmetic** combines two values with `add`, `sub`, `mul` or `div`:

```json
{ "node": "arithmetic", "op": "sub", "left": { "node": "now" }, "right": { "node": "view_call", "function": "latestTimestamp() returns (uint256)", "args": [] } }
```

**sum** adds two or more values: `{ "node": "sum", "terms": [ … ] }`.

**scale** multiplies by a power of ten; a negative `decimals` divides. It turns a 6-decimal raw amount into whole tokens with `"decimals": -6`:

```json
{ "node": "scale", "decimals": -6, "expr": { "node": "view_call", "function": "totalSupply() returns (uint256)", "args": [] } }
```

A **metric** is a value's history: `ath`, `prev_block`, `moving_avg`, `twap`, `windowed_delta` or `windowed_drop`, always of a `view_call`. The windowed four take `"window": { "seconds": n }` (60 seconds to 30 days); the other two take none. `tripwire://guide/metrics` explains each.

```json
{ "node": "metric", "metric": "twap", "of": { "node": "view_call", "function": "latestAnswer() returns (int256)", "args": [] }, "window": { "seconds": 3600 } }
```

A **simulate** value calls a function as a transaction would, without sending one, and reads what it returns: `{ "node": "simulate", "call": { "function": "previewRedeem(uint256) returns (uint256)", "args": ["1000000000000000000"] }, "yields": "value" }`. `from` and `value` set the caller and the wei sent.

## Conditions

**compare** with `eq`, `ne`, `lt`, `le`, `gt` or `ge`. Ordering needs numbers on both sides; `eq` and `ne` need the same type on both sides. A `bool` read compares with the literal `"true"`.

**deviation_band** trips when `value` is more than `tolerance_percent` away from `center`, on `"both"` sides, only `"above"`, or only `"below"`:

```json
{
  "node": "deviation_band",
  "value": { "node": "view_call", "function": "latestAnswer() returns (int256)", "args": [] },
  "center": { "node": "metric", "metric": "twap", "of": { "node": "view_call", "function": "latestAnswer() returns (int256)", "args": [] }, "window": { "seconds": 3600 } },
  "tolerance_percent": "5",
  "sides": "both"
}
```

A **simulate** condition trips when the call reverts. It takes a bare signature: `{ "node": "simulate", "call": { "function": "withdraw(uint256)", "args": ["1"], "from": "0x3333333333333333333333333333333333333333" }, "yields": "reverted" }`.

**and**, **or** (two or more `terms`) and **not** (`expr`) combine conditions. Branches past the deciding term are not evaluated.

## A complete event rule

```json
{
  "version": 1,
  "name": "Ownership transferred",
  "description": "The owner can upgrade and drain the vault; a transfer is expected only in a planned migration.",
  "contract": "0x1111111111111111111111111111111111111111",
  "severity": "critical",
  "when": { "event": "OwnershipTransferred(address indexed previousOwner, address indexed newOwner)" },
  "trip_when": true,
  "on_trip": { "action": "notify" }
}
```
