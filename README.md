# Tripwire

**A circuit breaker for smart contracts.** Tripwire watches your on-chain
contracts in real time, evaluates safety rules you define, alerts you the
moment one breaks, and can pause the affected contract before an exploit
drains it. It runs entirely on your own machine or server: your RPC, your
database, your keys.

## What it does

Tripwire continuously re-checks a set of **rules**, statements about
your protocol that should always hold and things that should never
happen:

E.g.

- "the vault's exchange rate never deviates more than 5% from its own
  20-minute average"
- "totalAssets never drops below totalSupply"
- "no more than 5% of supply is minted within 24 hours"
- "this oracle updates at least every hour"
- "this event never appears in a transaction touching our pool"

When a rule trips, Tripwire:

1. **Records it** with full evidence: the values, the block, the
   transaction that caused it.
2. **Alerts you** on your channels: chat, paging, or your own systems.
3. **Optionally responds on-chain**: it can call your contract's own
   pause function, or any admin function you choose, with a key you
   give it, before the damage is done. Each rule chooses its on-chain
   action, and the installation runs in one of three modes: alert
   only, hold for your approval, or fully autonomous.

Between violations you get a live dashboard: current values, historical
charts, which rules are currently tripped, and the health of the monitor
itself.

## How it is put together

- **This repo** is the application: the command line, the dashboard, and
  a local HTTP API your own tools can use.
- **The engine** is the detection and response core. It ships as a signed
  native binary that is installed into the application.
- **The contracts** are an optional on-chain circuit breaker, the
  TripwireController, for contracts that want pause-only power they can
  hand to Tripwire. Tripwire works without them.

The application talks to the engine over a local connection.

See [specs/HIGH-LEVEL-SPEC.md](specs/HIGH-LEVEL-SPEC.md) for the application's
components and design.

## Getting started

Setup is a guided install: point Tripwire at an RPC endpoint, open the
dashboard, add a contract, and create your first rule from a starting point.
Monitoring needs no keys and no on-chain changes.

On-chain response is a separate, deliberate step: you create a key in
Tripwire, grant it the permission your contract's pause function needs,
and choose the call each rule makes when it trips.

Full installation instructions will land here with the first release.

### Running from source against the engine

`tripwire start` runs the engine release it pins (`packages/cli/engine.json`),
checking its signature, checksum and version before starting it. Until
it downloads the release itself, put the release in place by hand:

```sh
pnpm install && pnpm build

v=0.1.0
dir=~/.tripwire/engine/bin/$v
mkdir -p $dir
gh release download engine-v$v -R sigint-zero/tripwire -D $dir \
  -p SHA256SUMS -p SHA256SUMS.minisig -p tripwire-engine-$v-x86_64-unknown-linux-musl
mv $dir/tripwire-engine-$v-x86_64-unknown-linux-musl $dir/tripwire-engine
chmod +x $dir/tripwire-engine

TRIPWIRE_RPC_HTTP=https://your-node pnpm start
```

On ARM64 Linux use `aarch64-unknown-linux-musl`. `TRIPWIRE_RPC_WS` adds
mempool watching. Without the release in place, `tripwire start` prints
these steps; `TRIPWIRE_ENGINE=stand-in` runs on simulated data instead.

## Security model

- **Notify-only by default.** Tripwire holds no keys until you create one.
- **Give it the least power that works.** Tripwire can do on-chain only
  what its key is allowed to do. Grant a role that can pause and
  nothing more, never an owner or admin key that could also upgrade
  the contract or move funds; the dashboard warns when a key holds
  more. A contract with no pause-only role can use the
  TripwireController, where the key you hand Tripwire can pause and
  un-pause and nothing else.
- **Local by default.** The dashboard and interface are only reachable
  from your machine unless you deliberately expose them, and every
  request needs a login even then.

## Status

Pre-release. The application and engine are under active development;
the optional contracts are deployed and verified. Nothing here is audited for
third-party production use yet.
