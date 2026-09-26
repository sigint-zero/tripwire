# Pitfalls

The ways rules raise false alarms or miss incidents. Each has its symptom and its fix.

| Pitfall | Symptom | Fix |
|-|-|-|
| Decimals mismatch | a comparison of two values is off by a power of ten: USDC (6 decimals) against a share (18) always looks insolvent | `scale` one side, e.g. `"decimals": 12` on the 6-decimal value |
| Raw integer against a human number | `totalSupply() > 1000000` trips at once, because reads are raw integers | write the literal raw (`"1000000000000000000000000"` for a million 18-decimal tokens), or `scale` the read down |
| Rebasing or fee-on-transfer tokens | a conservation identity drifts in normal use and trips | watch a ratio or rate instead of exact equality, or allow a tolerance with `deviation_band` |
| Window shorter than the update interval | a band around a `twap` of a feed that updates hourly swings on every update | size the window to several update intervals |
| A band around itself | `deviation_band` with a center that is the monitored value itself can never trip | center on a metric of the value (`twap`, `moving_avg`) or on a second source |
| Filter on an argument the event lacks | the engine refuses the document | use the event's parameter names exactly as `get_contract` gives them |
| Event signature without names | the engine refuses the document | write declaration style: `Transfer(address indexed from, address indexed to, uint256 value)` |
| Array or tuple parameters | the engine refuses the document | version 1 does not take them; `get_contract` marks them unsupported |
| Too many calls on every block | slow evaluation on a busy chain | keep an `every_block` rule to a few `view_call`s; the cap is 32 |
| Duplicate with different wording | the check reports `duplicate_of` | read `list_rules` first; the comparison ignores name, description and severity |
| Thresholds copied from another protocol | fires constantly or never | derive every threshold from this contract's live values and source |
| A read that returns several values | the rule compares the wrong output | set `returns` to the output's index; `get_contract` lists outputs in order |
| `simulate` in the wrong form | a revert is an evaluation error instead of a trip | `yields: "reverted"` trips on a revert; `yields: "value"` expects the call to succeed and fails loudly when it does not |
| A long window on a new rule | nothing happens for days | warm-up equals the window; prefer the shortest window that covers the rhythm |
| A rule that would trip now | it fires the moment it is enabled | a check with `would_trip_now: true` means the condition or threshold is wrong, unless the contract is already in violation |
