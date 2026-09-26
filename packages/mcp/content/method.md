# How to find the rules for a contract

This is a procedure, not a list to copy. Follow the steps in order, and write down what each one finds before you draft anything.

## Step 1: understand the contract

Read the ABI and source with a purpose. Answer four questions in writing:

- **What does it hold?** Assets, balances, positions, collateral, reserves.
- **Who can move it?** Which mutators move value, and who may call them: anyone, an owner, a role, a keeper.
- **What does it trust?** Every address it calls or reads: an asset, an oracle, a pool, an owner, an implementation behind a proxy.
- **What does it promise?** What must stay true for its users: redeemable shares, solvent loans, fair prices.

`get_contract` gives the material. View functions are the observable state, mutators are the ways the state changes, events are what the contract announces, and `linked` is what it trusts. Read the source files it lists (`source` set to a path) where the ABI leaves a question open, such as a hard cap or a fee constant.

## Step 2: ask the five questions

The first four find invariants; the fifth finds occurrences. Each maps to a shape in the rule language.

| Question | What it finds | Typical shape |
|-|-|-|
| What must be conserved? | accounting identities: total assets cover total supply, the sum of parts equals the whole, shares redeem for at least what they were minted for | `every_block` and a `compare` between two `view_call`s, or a `sum` |
| What must stay within bounds? | ratios and limits: utilisation under 100%, collateral ratio above the minimum, price within a band of its reference | `compare` against a `literal`, or `deviation_band` against another `view_call` |
| What must move slowly? | rate limits: supply, balances or prices change by at most so much over a window; no sudden drawdown | `deviation_band` or `compare` against a `metric` |
| What must stay fresh or alive? | liveness: an oracle updated recently, a reference withdrawal still succeeds | `now` minus an update time against a `literal`, or `simulate` with `yields: "reverted"` |
| What must never happen? | occurrences: ownership transferred, implementation upgraded, paused, a role granted, a mint beyond a size | an event trigger with `true`, or a `compare` on an `event_arg` |

Most questions produce nothing for a given contract. That is the normal case: say so and move on rather than forcing a rule.

### A worked example: an ERC-4626 vault

A vault holds one asset (`asset()` returns its address), mints shares on deposit, and invests through a strategy an owner can change.

- **Conserved.** Each share redeems for a growing amount of the asset: the share price, `convertToAssets` of one whole share, never falls below its peak by more than rounding. One rule: share price against a share of its `ath`.
- **Bounded.** The source caps deposits at `maxTotalAssets`. One rule: `totalAssets()` above that cap means the cap is not enforced. The live value is 4.3M against a 10M cap.
- **Slow-moving.** Deposits and withdrawals move `totalAssets` by at most a few percent an hour in its history. One rule: `windowed_drop` of `totalAssets` over one hour above 25.
- **Fresh or alive.** The vault reads no oracle and has no heartbeat. Nothing.
- **Never happens.** `OwnershipTransferred` and `StrategyChanged` both hand control of the funds to someone new. Two event rules.

## Step 3: look outward

Most losses come through what a contract trusts, not what it holds. For every linked address, ask the five questions again from this contract's point of view:

- the oracle it reads: is it fresh, and is its answer near its own recent average;
- the asset it holds: does its supply move as expected, and did its owner change;
- the pool it prices against: can one block move its reserves or price far;
- the implementation behind its proxy: did it change.

A `view_call` with an `address`, and an event trigger with an `address`, watch another contract from this contract's rule. When a linked address is itself registered, `get_contract` says so in `registered_as`, and its own rules may already cover it: check `list_rules` for it too.

## Step 4: set thresholds from evidence

A threshold is a claim about normal behaviour. Derive it; never guess or copy one from another protocol.

1. Read the current value from `get_contract` (`state.values`).
2. Find the contract's own limits in the source: hard caps, fee constants, decimals, bounds on parameters.
3. Choose a bound or window that normal activity cannot cross but an incident would.
4. Write the reasoning in `description`: the value you saw, the limit you found, and why the threshold sits where it does.

Start wide and let a person tighten it. A rule that fires in its first hour gets switched off and forgotten; a rule that fires only in an incident is kept.

## Step 5: size windows to the contract's rhythm

A window is `{ "seconds": n }`, from 60 seconds to 30 days, sampled every block. It should cover several natural cycles of the value it watches.

| Value | Rhythm | A window that works |
|-|-|-|
| a feed with a one-hour heartbeat | updates hourly | 6 hours or more |
| a busy pool's price or reserves | moves every block | 10 minutes to an hour |
| a vault's assets | moves with deposits and harvests | hours to a day |
| a token's supply | moves with mints and burns | a day to a week |

Warm-up equals the window: a rule over a 30-day window is silent for 30 days. Prefer the shortest window that still covers the rhythm.

## Step 6: write it down properly

- **name** is what a person reads in a list at three in the morning. Good: "Vault assets cover shares", "USDC feed freshness". Bad: "Rule 1", "check totalAssets", "invariant_vault_solvency_v2".
- **description** carries the statement in words, the evidence behind the threshold, and what a violation would mean.
- **severity** follows one scale: `critical` for loss of funds or control, `warning` for conditions that come before a loss, `info` for hygiene.
- **on_trip** is `{ "action": "notify" }`. Add `cooldown_seconds` when the condition can stay true for many blocks, so one incident is one alert.

## Step 7: check before you submit

Call `submit_rule` with `check_only: true`. It returns the engine's verdict, the rule read back as an English sentence, the value of every `view_call` at the head, whether the rule would trip right now, and how long it warms up.

- Every issue comes back at once with its path: fix them all, then check again.
- The sentence must say what you meant. If it does not, the document does not either.
- A rule that would trip right now is wrong, unless you can say why the contract is already in violation, and you tell the user.
- A duplicate means the statement is already watched: drop yours.

## Archetypes

The rules that nearly always apply, by kind of contract. `tripwire://guide/examples` has complete documents for most of them.

| Kind | Nearly always |
|-|-|
| ERC-20 | supply within cap or slow-moving; no mint beyond a size; owner unchanged; not paused unexpectedly |
| ERC-4626 vault | assets cover shares at the current share price; share price monotone or slow-moving; a reference redeem succeeds; asset address unchanged |
| lending pool | utilisation bound; reserves cover deposits; collateral factor changes are events to watch; oracle freshness and deviation |
| AMM pool | reserves or price within a band of a time-weighted reference; large single-block reserve drops; fee parameter changes |
| price oracle and consumers | updated within its heartbeat; answer within a band of its own average; answer within a band of a second source |
| proxy | implementation unchanged (the event and the view); admin unchanged |
| governance and timelock | delay parameter unchanged; proposal executed events; guardian or owner changes |
| bridge and escrow | locked balance covers minted supply on this side; large single withdrawal; pauser changes |
