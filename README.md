# Tripwire

**A circuit breaker for smart contracts.** Tripwire watches your on-chain
contracts in real time, evaluates safety rules you define, alerts you the
moment one breaks, and can pause the affected contract before an exploit
drains it. It runs entirely on your own machine or server: your RPC, your
database, your keys.

## What it does

Tripwire continuously re-checks a set of **invariants**, statements about
your protocol that should always hold:

- "the vault's exchange rate never deviates more than 5% from its own
  20-minute average"
- "totalAssets never drops below totalSupply"
- "no more than 5% of supply is minted within 24 hours"
- "this oracle updates at least every 30 days"
- "this event never appears in a transaction touching our pool"

When an invariant breaks, Tripwire:

1. **Records it** with full evidence: the values, the block, the
   transaction that caused it.
2. **Alerts you** on your channels: chat, paging, or your own systems.
3. **Optionally responds on-chain**: it can pause the affected function
   (or the whole contract) through the TripwireController before the
   damage is done. Response is opt-in per rule, with three modes: alert
   only, hold for your approval, or fully autonomous.

Between violations you get a live dashboard: current values, historical
charts, trip state, and the health of the monitor itself.

## How it is put together

- **This repo** is the application: the command line, the dashboard, and
  the local interface your own tools can use.
- **The engine** is the detection and response core. It ships as a signed
  native binary that is installed into the application.
- **[The contracts](https://github.com/sigint-zero/tripwire-contracts)**
  are the TripwireController circuit breaker, deployed and verified
  on-chain.

The app communicates with the engine over a local interface.

## Getting started

Setup is a guided install: point Tripwire at an RPC endpoint, open the
dashboard, add a contract, and create your first rule from a template.
Monitoring needs no keys and no on-chain changes.

On-chain response is a separate, deliberate step: you create an operator
key, register your contract with the TripwireController, and authorise
the operator from your own guardian wallet.

Full installation instructions will land here with the first release.

## Security model

- **Notify-only by default.** Tripwire holds no keys until you create one.
- **Guardian versus operator.** You keep the guardian key that controls
  the circuit breaker. Tripwire holds only an operator key, whose
  on-chain power is limited to pausing and un-pausing, never moving
  funds.
- **Local by default.** The dashboard and interface are only reachable
  from your machine unless you deliberately expose them.

## Status

Pre-release. The contracts are deployed and verified; the application and
engine are under active development. Nothing here is audited for
third-party production use yet.
