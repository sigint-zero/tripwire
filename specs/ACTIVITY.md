# Activity and trip state

What has happened on chain around the contracts Tripwire watches, and
what is paused right now. `HIGH-LEVEL-SPEC.md` places the area;
`RESPONSES.md` covers the controller, operators and the responses that
pause things; `CONTRACTS.md` and `OVERVIEW.md` host the trip state
shown here; `LIVE-UPDATES.md` keeps both current.

## Terms

| Term | Meaning |
|-|-|
| controller | the TripwireController deployed on the installation's chain: a registry of guarded contracts, each with a guardian, operators, and two kinds of pause (`RESPONSES.md`) |
| guarded contract | a contract registered with the controller. It registered itself, naming its guardian |
| trip | a pause: of one function (by its 4-byte selector) or of the whole contract (global) |
| reset | lifting a trip |
| trip state | what is paused right now, whichever mechanism paused it |

## Where it comes from

The engine mirrors the controller into two views, and the application
reads both:

- `api_v1.controller_events`: every event the controller has emitted
  since its deployment, in block order, with the block, transaction,
  log index, event name and decoded arguments. Events from a newer
  controller than the engine knows are kept undecoded, with their raw
  topics.
- `api_v1.trip_state`: the current pause state, one row per contract,
  selector and source. The global row has selector `''`. Source
  `controller` rows are the mirror of the controller; source `verify`
  rows come from rules whose `call` action carries a confirmation
  (`RULE-WIZARD.md`): the engine checks the confirmation every block
  and the row is tripped while it holds, with the called function's
  selector.

Both are reorg-consistent: a trip on a block that is later rewound
disappears from both, and the dashboard follows the views rather than
remembering anything itself.

## Scope

The controller is shared by every guarded contract on the chain, so
most of its events concern other people's contracts. The application
shows only:

- events whose target is a registered contract;
- operator events (`OperatorAdded`, `OperatorRemoved`) naming one of
  this installation's operator keys, whatever the target, so a key
  authorised on a contract that is not registered here is still seen;
- undecoded events, only when one of their indexed topics is a
  registered contract's address or one of the keys, padded to 32
  bytes; they show as "Unrecognised controller event" with the
  transaction, and the Activity page suggests updating Tripwire.

Trip state is limited the same way: rows for registered contracts
only.

## The timeline

At `/activity`, newest first. Each event is one line: a sentence, the
contract's name, the block and, once the view carries it (ask T1), the
time; the transaction links to the chain's block explorer for the
installation's chain (the shared chain list gains an explorer URL per
chain; a chain without one shows the hash unlinked).

| Event | Sentence |
|-|-|
| `FunctionTripped` | Treasury vault: `withdraw()` paused by *actor* |
| `FunctionReset` | Treasury vault: `withdraw()` unpaused by *actor* |
| `GlobalTripped` | Treasury vault: every function paused by *actor* |
| `GlobalReset` | Treasury vault: global pause lifted by *actor*; function pauses stay |
| `Registered` | Treasury vault registered with the controller; guardian *address* |
| `OperatorAdded` | *operator* authorised as operator on Treasury vault by the guardian |
| `OperatorRemoved` | *operator* removed as operator on Treasury vault by the guardian |
| `GuardianshipProposed` | the guardian proposed *address* as the new guardian of Treasury vault |
| `GuardianshipProposalCancelled` | the guardian cancelled the proposal to hand Treasury vault to *address* |
| `GuardianshipTransferred` | *address* is now the guardian of Treasury vault, replacing *address* |

The `GlobalReset` sentence says that function pauses stay because
that is how the controller behaves, and people reliably expect the
opposite.

**Function names.** A selector is resolved to the function's name
through the contract's ABI as the engine stores it (for a proxy, the
implementation's functions are included): the server computes each
function's selector from its canonical signature and matches. A
selector with no match shows as its hex.

**Actors.** The address that acted is named by what it is, in this
order:

1. **Tripwire, responding to a rule**: the transaction hash equals the
   hash of a response's transaction or of any of its attempts
   (`api_v1.responses`); the sentence names the rule and links to the
   response.
2. **Tripwire, by hand**: the hash matches a manual pause or unpause
   (`RESPONSES.md`, ask R4).
3. **This installation's operator key**, otherwise: the address is one
   of the keys (`RESPONSES.md`) but no Tripwire record matches, for
   example a transaction sent with the same key from other tooling.
4. **The guardian**: the address is the target's guardian at that
   block, known from the `Registered` and `GuardianshipTransferred`
   events before it.
5. **Another operator**, or the plain address when it is none of the
   above.

Addresses show shortened, with the full address on hover and a copy
button, and the installation's keys and registered contracts by name.

**Filters**, kept in the URL: contract, and kind of event: pauses
(`FunctionTripped`, `GlobalTripped`), unpauses (`FunctionReset`,
`GlobalReset`), roles (registration, operators, guardianship), and
unrecognised.

**Paging** is by id, 100 events at a time, with **Older**. Ids follow
block order: the engine scans the controller's history before it
follows new blocks, and a reorg removes every event above the common
ancestor before the replacement blocks add theirs, so a newer id is
never an older block. After a reorg, ids have gaps; the page does not
care.

Controller events raise no notifications. A pause by the guardian or
another operator shows here and in trip state; tripping and failing
responses notify through `NOTIFICATIONS.md` as they already do.

## Trip state

"Paused now" is the set of `api_v1.trip_state` rows that are tripped,
for registered contracts. It is one component, shown in three places:

| Where | Shows |
|-|-|
| Overview | the list of everything paused now, first on the page when not empty (`OVERVIEW.md`) |
| Contracts list | a **Paused** tag on a contract with a global pause, else **2 functions paused** |
| A contract's page | a pause panel: the global row, then each paused function |

Each paused row shows:

- what is paused: every function, or the function's name resolved as
  above;
- how: **controller**, or **the contract's own pause**, naming the
  rule or rules whose confirmation reads true (enabled rules on that
  contract with a `call` action whose function has that selector);
- since which block, with how long ago once block times are available;
- for a controller row, the transaction that paused it, attributed as
  in the timeline.

A `verify` row is current state only: the engine keeps no history of
when a confirmation started or stopped holding, so the timeline has no
line for it. The response that made the call is on the Responses page;
a pause made by other means shows up in trip state and nowhere else.

The contract page's panel also hosts **Pause** and **Unpause**
(`RESPONSES.md`, manual actions), which live there because this is
where a person looks during an incident.

## Without a controller

When the installation's chain has no known controller deployment and
none is configured (`ENGINE.md`), the Activity page explains that
pausing through the controller is not available on this chain and that
rules can still pause a contract through its own function
(`RULE-WIZARD.md`, the `call` action). Trip state then holds only
`verify` rows. While the engine has not caught up with the
controller's history (reported in its health), the page says the
history is still being read.

## API

All under `/api/v1`, requiring a session (`AUTHENTICATION.md`), with
the API's error envelope. No MCP tool reads either.

| Method | Path | Purpose |
|-|-|-|
| GET | `/activity` | newest first: `?contract&kind&before&limit`; `kind` one of `pause`, `unpause`, `role`, `unrecognised`; `limit` 1 to 500, default 100; `before` an id |
| GET | `/trip-state` | the tripped rows for registered contracts |

An activity item:

```json
{
  "id": "5521",
  "event": "FunctionTripped",
  "blockNumber": 21000003,
  "blockTime": null,
  "txHash": "0x…",
  "contract": { "address": "0x…", "name": "Treasury vault" },
  "selector": "0x2e1a7d4d",
  "function": "withdraw(uint256)",
  "actor": {
    "address": "0x…",
    "is": "tripwire_response",
    "responseId": "7",
    "rule": { "id": "12", "name": "Assets cover supply" }
  },
  "subject": null,
  "sentence": "Treasury vault: withdraw(uint256) paused by Tripwire, responding to Assets cover supply"
}
```

`actor.is` is one of `tripwire_response`, `tripwire_manual`, `key`,
`guardian`, `operator`, `unknown`. `subject` is the other address an
event names: the operator added or removed, or the proposed or new
guardian. `blockTime` is `null` until the view carries it (T1).

A trip-state item:

```json
{
  "contract": { "address": "0x…", "name": "Treasury vault" },
  "scope": "function",
  "selector": "0x2e1a7d4d",
  "function": "withdraw(uint256)",
  "source": "controller",
  "sinceBlock": 21000003,
  "sinceTime": null,
  "txHash": "0x…",
  "actor": {
    "address": "0x…",
    "is": "tripwire_response",
    "responseId": "7",
    "rule": { "id": "12", "name": "Assets cover supply" }
  },
  "rules": []
}
```

`scope` is `global` or `function`. `actor` is the tripping
transaction's sender, attributed exactly as on the timeline, so the
Overview's Tripped now can say "Tripwire" and link the response
(`OVERVIEW.md`). `sinceTime` is the block's time once the view
carries it (T1). For `source: "verify"`, `txHash` and `actor` are
`null` and `rules` lists the ids and names of the rules whose
confirmation reads true.

Both lists are read with bounded queries and a statement timeout, per
`DATABASE.md`.

## What the application requires of the engine

| # | Requirement | Why |
|-|-|-|
| T1 | `api_v1.controller_events` carries `block_time`, and its target address as a column, indexed, so the application can filter by the registered contracts without scanning every guarded contract's history | the controller is shared by the whole chain; a timeline needs times, and filtering in jsonb over the chain's full history does not stay inside a few seconds |

## Decisions

| # | Decision | Recommendation and reason |
|-|-|-|
| AC1 | Which events to show | The registered contracts', and operator events naming this installation's keys. Everything else on the shared controller is someone else's business and would drown the page |
| AC2 | Attributing a pause to Tripwire | By transaction hash against responses and their attempts, not by sender. The same operator key can be used by other tooling; only a hash match proves Tripwire sent it |
| AC3 | Notifications for controller events | None for now. Tripwire's own pauses already notify through their responses, and a pause by someone else is visible here and on the Overview. Revisit once teams ask for it |
| AC4 | History of confirmation pauses | Current state only, stated on the page. The engine keeps none, and inventing history from polling would disagree with the chain after a reorg |
| AC5 | Function names | Resolved by the server from the stored ABI, so the dashboard, scripts and alerts all say `withdraw(uint256)` rather than a selector |

## Checkpoint

Activity and trip state are done when, provably and repeatably, against
a controller on a public testnet:

1. A function pause and a global pause sent by the guardian appear in
   the timeline with the right sentences and the guardian named as
   such, and in trip state on the Overview, the Contracts list and
   the contract's page, within seconds, with no reload.
2. `resetGlobal` shows the global pause lifted and the function pause
   still in place, in both the timeline and trip state.
3. A pause sent by a response in `prepare` mode is attributed to
   Tripwire and names its rule; the same key sending the same call
   from other tooling is attributed to the key, not to a response.
4. Events for a guarded contract that is not registered here never
   appear; `OperatorAdded` for this installation's key on such a
   contract does.
5. A rule with a `call` action and a confirmation shows a pause
   "through the contract's own pause" once the call lands, naming the
   rule, and the row goes when the contract is unpaused.
6. A reorg that removes a pause removes it from the timeline and from
   trip state, with no reload.
7. On a chain with no controller, the page explains and trip state
   shows confirmation rows only.
