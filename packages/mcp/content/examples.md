# Starting points by contract kind

Complete rule documents for common contract kinds. Each says when it applies and what to change. Every address here is a placeholder: use the registered contract's address, and the signatures `get_contract` reports, which may differ from these. Thresholds here are illustrations; derive yours from the live values and the source (`tripwire://guide/method`, step 4).

## ERC-20 token

**Supply grows slowly.** For a token whose supply changes by mints and burns in normal use. Change the window and the share to what the supply history supports.

```json
{
  "version": 1,
  "name": "Supply growth limit",
  "description": "Supply grows by at most 5% a day. Daily mints have stayed under 1% at the observed supply; a jump past 5% means an unexpected mint.",
  "contract": "0x1111111111111111111111111111111111111111",
  "severity": "warning",
  "when": "every_block",
  "trip_when": {
    "node": "compare",
    "op": "gt",
    "left": { "node": "metric", "metric": "windowed_delta", "of": { "node": "view_call", "function": "totalSupply() returns (uint256)", "args": [] }, "window": { "seconds": 86400 } },
    "right": { "node": "arithmetic", "op": "mul", "left": { "node": "view_call", "function": "totalSupply() returns (uint256)", "args": [] }, "right": { "node": "literal", "value": "0.05" } }
  },
  "on_trip": { "action": "notify", "cooldown_seconds": 3600 }
}
```

**No mint beyond a size.** A mint is a `Transfer` from the zero address. The size here is 1,000,000 tokens at 18 decimals, raw.

```json
{
  "version": 1,
  "name": "Large mint",
  "description": "A single mint above 1,000,000 tokens; the largest routine mint in the token's history is under 50,000.",
  "contract": "0x1111111111111111111111111111111111111111",
  "severity": "critical",
  "when": {
    "event": "Transfer(address indexed from, address indexed to, uint256 value)",
    "filters": [{ "arg": "from", "eq": "0x0000000000000000000000000000000000000000" }]
  },
  "trip_when": { "node": "compare", "op": "gt", "left": { "node": "event_arg", "arg": "value" }, "right": { "node": "literal", "value": "1000000000000000000000000" } },
  "on_trip": { "action": "notify" }
}
```

## ERC-4626 vault

**Share price never falls from its peak.** A vault that only earns sees its share price rise. `convertToAssets` of one whole share (here 18 decimals) is the share price; a fall of more than 1% from its all-time high is a loss.

```json
{
  "version": 1,
  "name": "Share price drawdown",
  "description": "The value of one share never falls more than 1% below its highest value. The vault's strategy only accrues; a fall means a loss was realised.",
  "contract": "0x1111111111111111111111111111111111111111",
  "severity": "critical",
  "when": "every_block",
  "trip_when": {
    "node": "compare",
    "op": "lt",
    "left": { "node": "view_call", "function": "convertToAssets(uint256) returns (uint256)", "args": ["1000000000000000000"] },
    "right": {
      "node": "arithmetic",
      "op": "mul",
      "left": { "node": "metric", "metric": "ath", "of": { "node": "view_call", "function": "convertToAssets(uint256) returns (uint256)", "args": ["1000000000000000000"] } },
      "right": { "node": "literal", "value": "0.99" }
    }
  },
  "on_trip": { "action": "notify" }
}
```

## Price oracle and its consumers

**Updated within its heartbeat.** A Chainlink-style feed's `latestRoundData` returns `updatedAt` as its fourth output (`returns: 3`). The feed's heartbeat is one hour; allow a quarter hour more.

```json
{
  "version": 1,
  "name": "Price feed freshness",
  "description": "The feed updates at least hourly (its heartbeat); 75 minutes without an update means it stalled.",
  "contract": "0x1111111111111111111111111111111111111111",
  "severity": "warning",
  "when": "every_block",
  "trip_when": {
    "node": "compare",
    "op": "gt",
    "left": { "node": "arithmetic", "op": "sub", "left": { "node": "now" }, "right": { "node": "view_call", "function": "latestRoundData() returns (uint80,int256,uint256,uint256,uint80)", "args": [], "returns": 3 } },
    "right": { "node": "literal", "value": "4500" }
  },
  "on_trip": { "action": "notify", "cooldown_seconds": 3600 }
}
```

**Answer stays near its own average.** The answer is the second output (`returns: 1`). A 10% move away from the six-hour time-weighted average is outside normal volatility for a major asset; widen it for volatile ones.

```json
{
  "version": 1,
  "name": "Price deviation",
  "description": "The answer stays within 10% of its 6-hour time-weighted average.",
  "contract": "0x1111111111111111111111111111111111111111",
  "severity": "warning",
  "when": "every_block",
  "trip_when": {
    "node": "deviation_band",
    "value": { "node": "view_call", "function": "latestRoundData() returns (uint80,int256,uint256,uint256,uint80)", "args": [], "returns": 1 },
    "center": { "node": "metric", "metric": "twap", "of": { "node": "view_call", "function": "latestRoundData() returns (uint80,int256,uint256,uint256,uint80)", "args": [], "returns": 1 }, "window": { "seconds": 21600 } },
    "tolerance_percent": "10",
    "sides": "both"
  },
  "on_trip": { "action": "notify", "cooldown_seconds": 1800 }
}
```

## AMM pool

**No sudden reserve drain.** A 20% fall in one reserve within ten minutes is beyond normal trading on a deep pool.

```json
{
  "version": 1,
  "name": "Reserve drain",
  "description": "reserve0 never falls more than 20% below its 10-minute high.",
  "contract": "0x1111111111111111111111111111111111111111",
  "severity": "critical",
  "when": "every_block",
  "trip_when": {
    "node": "compare",
    "op": "gt",
    "left": { "node": "metric", "metric": "windowed_drop", "of": { "node": "view_call", "function": "getReserves() returns (uint112,uint112,uint32)", "args": [], "returns": 0 }, "window": { "seconds": 600 } },
    "right": { "node": "literal", "value": "20" }
  },
  "on_trip": { "action": "notify", "cooldown_seconds": 600 }
}
```

## Lending pool

**Utilisation stays below its ceiling.** Borrows above 98% of what was supplied leave lenders unable to withdraw.

```json
{
  "version": 1,
  "name": "Utilisation ceiling",
  "description": "Borrows stay under 98% of cash plus borrows; the rate model's kink is at 90% and utilisation has not passed 93%.",
  "contract": "0x1111111111111111111111111111111111111111",
  "severity": "warning",
  "when": "every_block",
  "trip_when": {
    "node": "compare",
    "op": "gt",
    "left": { "node": "view_call", "function": "totalBorrows() returns (uint256)", "args": [] },
    "right": {
      "node": "arithmetic",
      "op": "mul",
      "left": { "node": "sum", "terms": [{ "node": "view_call", "function": "getCash() returns (uint256)", "args": [] }, { "node": "view_call", "function": "totalBorrows() returns (uint256)", "args": [] }] },
      "right": { "node": "literal", "value": "0.98" }
    }
  },
  "on_trip": { "action": "notify", "cooldown_seconds": 3600 }
}
```

## Proxy

**Implementation upgraded.** An upgrade replaces all of the contract's code.

```json
{
  "version": 1,
  "name": "Implementation upgraded",
  "description": "Upgrades happen only through governance with notice; an unannounced upgrade may be a takeover.",
  "contract": "0x1111111111111111111111111111111111111111",
  "severity": "critical",
  "when": { "event": "Upgraded(address indexed implementation)" },
  "trip_when": true,
  "on_trip": { "action": "notify" }
}
```

## Pausable contracts

**Paused unexpectedly.** Worth knowing whoever paused it.

```json
{
  "version": 1,
  "name": "Contract paused",
  "description": "The contract was paused; nothing is scheduled to pause it.",
  "contract": "0x1111111111111111111111111111111111111111",
  "severity": "warning",
  "when": { "event": "Paused(address account)" },
  "trip_when": true,
  "on_trip": { "action": "notify" }
}
```
