# Historical metrics

A metric turns a value's history into a number a rule can compare. Every metric is `of` one `view_call`, sampled once per block. A metric with too little history is warming: it has no value, and a rule that needs it cannot trip until it has one.

| Metric | Value | Window | Warm once |
|-|-|-|-|
| `ath` | the highest sample since the rule was created | none | one earlier sample exists |
| `prev_block` | the sample at the previously evaluated block | none | one earlier sample exists |
| `moving_avg` | the arithmetic mean of the samples in the window | required | the window is covered |
| `twap` | the time-weighted mean over the window: each sample weighted by how long it stood | required | the window is covered |
| `windowed_delta` | the current sample minus the value in effect at the window start, signed | required | the window is covered |
| `windowed_drop` | the fall from the window's highest sample, in percent: `(max - current) / max × 100`; 0 at a new high | required | the window is covered |

**Windows** are `{ "seconds": n }`, from 60 seconds to 30 days. Warm-up equals the window: a rule over a 7-day window is silent for its first 7 days. Choose the shortest window that covers several natural cycles of the value.

## Which question each answers

- **Did it jump in one block?** Compare the value with `prev_block`. Good for balances that should only move by bounded amounts per transaction.
- **Is it far from normal?** `deviation_band` around a `twap` or `moving_avg` of the same value. `twap` resists a single manipulated block better than `moving_avg`, because a short-lived spike stands for little time.
- **Is it growing too fast?** Compare `windowed_delta` with an allowance, such as a share of the current value.
- **Is it draining?** Compare `windowed_drop` with a percentage.
- **Has it fallen from its peak?** Compare the value with a share of `ath`. It never forgets a peak, so use it for values that should only rise, like a vault's share price.

## Worked numbers

A pool's `reserve0` samples, one per block, over a one-hour window: 1,000,000 at the window's start, a high of 1,020,000, and 900,000 now.

- `windowed_delta` is 900,000 - 1,000,000 = -100,000.
- `windowed_drop` is (1,020,000 - 900,000) / 1,020,000 × 100 ≈ 11.76. A rule tripping above `"10"` trips.
- A `deviation_band` of 5% around a `twap` that sits near 990,000 trips, since 900,000 is about 9% below.

Reading a percentage: `windowed_drop` is already in percent, so compare it with a literal like `"10"`, not `"0.1"`.

## An allowance as a share of the value

Growth limited to 5% of the current supply per day:

```json
{
  "node": "compare",
  "op": "gt",
  "left": { "node": "metric", "metric": "windowed_delta", "of": { "node": "view_call", "function": "totalSupply() returns (uint256)", "args": [] }, "window": { "seconds": 86400 } },
  "right": { "node": "arithmetic", "op": "mul", "left": { "node": "view_call", "function": "totalSupply() returns (uint256)", "args": [] }, "right": { "node": "literal", "value": "0.05" } }
}
```
