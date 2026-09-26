# Responses

How Tripwire acts on-chain when a rule trips, from the application's
seat: how far it may go on its own, the calls it makes, the keys it
signs with, the checklist that gets a contract ready, the queue where
a person approves what will be sent, and the optional TripwireController
for contracts that want it.
`HIGH-LEVEL-SPEC.md` places the area; `RULE-WIZARD.md` covers the
action a rule carries; `ENGINE.md` covers how configuration reaches
the engine; `NOTIFICATIONS.md` covers the alerts a response raises;
`ACTIVITY.md` covers what is paused and the history of pauses.

The engine builds, signs, submits and watches every transaction. The
application never holds key material and never talks to the chain: it
chooses the policy, shows what the engine prepared, and carries a
person's approval.

## Terms

| Term | Meaning |
|-|-|
| response | what the engine does about one violation whose rule carries an on-chain action: a transaction built, perhaps held, sent and watched to a final status |
| response mode | how far the engine goes on its own, for the whole installation: `notify`, `prepare` or `send` |
| key | a key the engine holds and signs responses with. Its on-chain power is whatever the owner granted it: normally a role on the contract that allows pausing |
| controller | optional: the TripwireController, a deployed circuit breaker shared by every contract that chooses to use it (below) |
| guardian | for a contract on the controller: the owner's own wallet, which authorises keys there and can pause and unpause. Tripwire never holds it |

## The mode ladder

| Mode | On a violation whose rule has an on-chain action |
|-|-|
| `notify` | record and alert only; nothing is built (the default) |
| `prepare` | build and sign, hold it in the queue, send when a person approves |
| `send` | build, sign and send at once |

The ladder is the one people climb: watch first, approve for a while,
then automate. The mode belongs to the installation, not to a rule: a
rule says what to do (`RULE-WIZARD.md`, Response), the mode says whether
a person stands in between. This settles the wizard's open question on
where the mode is read from: the application's own configuration,
which it writes into the engine's (`ENGINE.md`), and which
`GET /api/v1/engine` reports as `responseMode`.

Rules whose action is notify-only are unaffected by the mode.

### Changing the mode

In Settings, Response. The mode lives in `config.json` under
`response.mode` and reaches the engine by restart, like every engine
setting: validate, write, restart, wait for ready, roll back with the
engine's own message if it refuses (`ENGINE.md`). Evaluation pauses for
the few seconds of the restart and resumes from the engine's cursor.

| Move | What the application requires first |
|-|-|
| to `notify` | nothing |
| to `prepare` | at least one key exists. It may be locked: the engine starts and warns, responses wait at `pending` with the problem recorded, and the dashboard asks for an unlock |
| to `send` | the account's password, entered again; `TRIPWIRE_KEYS_PASSPHRASE` set in the application's environment; the signing key (below) exists |

`send` needs a signer the moment the engine starts, and the engine
refuses to start in `send` without one. After any restart, planned or
not, keys are locked unless the passphrase is in the environment, so
the application refuses the switch without it and names the variable.
If the passphrase does not open the signing key, the engine refuses the
configuration, the application restores the previous mode, and the
engine's message is shown.

A mode change governs new violations only. Responses already in the
queue keep their status; the queue shows them as the engine has them,
and approve and reject pass through to the engine whatever the mode.

Where the mode is shown: the Response section of Settings, the header
of the Responses page, and the rule wizard's Response section when an
on-chain action is chosen.

## Response settings

Also in Settings, Response, in `config.json` under `response`, applied
by restart:

| Setting | Values | Meaning |
|-|-|-|
| signing key | one of the keys; empty means the only key | the address every response is signed with |
| maximum fee | gwei, empty for the engine's default | cap on the fee per gas a response may pay |
| maximum priority fee | gwei, empty for the engine's default | cap on the tip |
| replace after | blocks, 1 to 50, default 5 | a transaction not included within this many blocks is resent with a higher fee, same nonce |
| attempts | 1 to 10, default 3 | fee escalations before the response is `failed` |
| submission | `private` (default), `private_strict`, `public` | how the signed transaction reaches the chain, below |
| private endpoints | list of URLs, empty for the engine's built-in set | replaces the endpoints private submission sends to |
| controller address | address, empty for the known deployment | overrides the known controller for this chain (stored as `chain.controllerAddress`, with its deployment block) |

Submission, explained where it is chosen:

| Value | Behaviour |
|-|-|
| `private` | sent to private submission endpoints that do not broadcast to the public mempool, so the pause cannot be seen and raced before it lands. If every attempt fails to be included, one last attempt goes public, with an alert saying so |
| `private_strict` | private only; never public. A chain with no private endpoints refuses to start in this setting |
| `public` | through the configured RPC endpoint, visible to everyone the moment it is sent |

Whether a transaction seen in the mempool may start a response is a
detection setting (`SETTINGS.md`, Detection).

## Keys

In Settings, Keys. The engine keeps keys as standard encrypted keystore
files in `TRIPWIRE_HOME/engine/keys/`, one per key; any standard
Ethereum tool opens them, and a keystore made elsewhere can be
imported.

The list shows each key's address, whether it is unlocked, its balance
(requirement R1), whether it is the signing key and, for contracts
that use the controller, the ones it is an authorised operator on (from
the controller's events, below). A zero balance is flagged: a key that
cannot pay for gas cannot respond.

| Action | Does |
|-|-|
| **Create** | a passphrase, typed twice, 12 characters or more. The engine generates the key and returns its address. The dialog then says where the file is and that the passphrase cannot be recovered |
| **Import** | a keystore file (JSON, up to 64 KB) and its passphrase. The engine checks it opens before storing it |
| **Unlock** | the passphrase; the key signs until it is locked or the engine restarts |
| **Lock** | the key stops signing at once; responses wait at `pending` with the reason |

There is no delete and no export. The file is the key: backing it up
is copying the file, whose path the dashboard shows, and removing a
key is deleting its file while Tripwire is stopped, a deliberate act
outside the dashboard.

### Passphrases

A passphrase passes through the server to the engine and nowhere else.
The server validates the request, forwards it, and drops it. It is
never stored, never returned, and never logged: the key routes are
excluded from request body logging, and an error names what failed
("wrong passphrase") without echoing anything. It does sit in the
server's memory as a string for the length of the request; the
engine, which holds the unlocked key, is where memory is locked and
wiped.

Unlocking is limited to five attempts per key per minute; the engine's
answer to a wrong passphrase says nothing more than that.

For unattended restarts the passphrase comes only from
`TRIPWIRE_KEYS_PASSPHRASE` in the application's environment, which the
application passes to the engine's environment and names in
`engine.toml` in the `env:` form (`ENGINE.md`). It is never written to
`config.json` or any other file the application creates. Settings says
whether it is set, never what it is.

## What a response calls

By default a response is a call to the protected contract itself: its
own `pause()`, or whichever function the rule names, sent from the
signing key (the rule's `call` action, `RULE-WIZARD.md`). This needs
nothing deployed and nothing registered; it needs the key to hold
whatever permission that function checks, which the owner grants on
the contract in the usual way (a pauser role, a guardian slot, an
allow-list).

**Least power.** Tripwire can do only what its key is allowed to do, so
the key should be allowed to pause and nothing more. Before a contract
is marked ready, the server reads, through the engine's live read, the
common ownership views the contract exposes (`owner()`, and
`hasRole(DEFAULT_ADMIN_ROLE, key)` where the contract has roles) and
warns when the signing key is the owner or an admin: such a key could
also upgrade the contract, change its settings or move funds. The
warning says what to grant instead. It is a warning, not a refusal:
the owner decides.

A contract with no pause-only permission to grant can use the
controller instead, below: there the key Tripwire holds can pause and
unpause and nothing else.

## The controller (optional)

The TripwireController is an optional integration for contracts built
to use it. It is one contract per chain. Every contract that uses it
has, on the controller, a guardian, a set of operators, a global pause
flag and a pause flag per function. The contract itself checks the
flags (a function asks whether it, or the whole contract, is paused)
and refuses to run while paused.

| Call | Who may make it |
|-|-|
| `register(target, guardian)` | the target contract itself, once |
| `addOperator(target, operator)`, `removeOperator` | the guardian |
| `trip(target, selector)`, `tripGlobal(target)`, `reset(target, selector)`, `resetGlobal(target)` | the guardian or an operator |

Pauses and resets are idempotent. `resetGlobal` lifts only the global
pause; function pauses stay until reset one by one.

### Known deployments

The application ships a table of known controller deployments, as
data, with the address and the block it was deployed at:

| Chain | Address | Deployed at block |
|-|-|-|
| Ethereum (1) | `0x328aED8F7a01f45A959c187F3cb97eC508064854` | from the deployment record |

`chain.controllerAddress` empty means this table's entry for the
installation's chain. A chain with no entry and no configured address
runs with no controller: everything works through `call` actions, and
the wizard does not offer the controller's pause actions.

### Registration

Registration is done by the guarded contract, never by a person or by
Tripwire: the controller only accepts `register` from the target
itself, normally in its constructor through the controller's mixin,
or in an upgrade. The application can only observe it: a `Registered`
event for the contract's address in `api_v1.controller_events`, which
names the guardian. Later guardianship transfers update who the
guardian is.

A contract that did not register simply does not use the controller;
its rules call its own functions, as above.

## Readiness

Each contract's page has a **Response readiness** checklist, and the
Responses page summarises it across contracts. It is computed by the
server from the keys, the configuration, the rules and, for contracts
on the controller, its mirrored events:

| Step | Done when | Otherwise |
|-|-|-|
| signing key | a key exists, is unlocked and has a balance | links to Keys |
| rules that act | at least one enabled rule on the contract has an on-chain action | links to the rule wizard |
| permission | **Test the response** passed for each of those rules: the key can make the call | shows the revert reason, which usually names the missing role |
| least power | the key is not the contract's owner or admin (above) | a warning with what to grant instead; does not block |
| mode | not `notify` | links to Settings, Response |

For a contract whose rules use the controller's pause actions, two
steps join the list before **permission**:

| Step | Done when | Otherwise |
|-|-|-|
| registered | a `Registered` event exists for the contract; the guardian is shown | explains that registration is done by the contract itself, and that calling its own functions needs none |
| operator authorised | an `OperatorAdded` for this contract and the signing key, with no later `OperatorRemoved` | shows the guardian call, below |

**The guardian call.** When the operator is not authorised, the step
shows exactly what to send from the guardian wallet: the controller's
address as the recipient, value zero, and the calldata, which is the
selector `0x8a1af4c4` of `addOperator(address,address)` followed by the
contract's address and the key's address, each padded to 32 bytes.
Each has a copy button, and the step says which wallet must send it
(the guardian's address). The step ticks by itself once the
`OperatorAdded` event appears: while the checklist is open it re-reads
on every `block` event (`LIVE-UPDATES.md`).

**Test the response.** For a chosen rule with an on-chain action, the
engine builds that rule's action from the signing key and simulates it
at the current block, sending nothing (requirement R2). A pass shows
the gas it would use and the most it could cost at the configured
caps, and compares that with the key's balance. A failure shows the
revert reason, for example that the key lacks the role the call
needs, or is not an operator on the controller. The last result per rule
is kept in memory by the server and shown until the next test or
restart.

## The Responses page

At `/responses`. The header shows the mode; in `notify` a banner says
that violations alert only and nothing is built, with a link to
change it.

Three tabs, each newest first, with counts; the navigation shows the
waiting count:

| Tab | Statuses |
|-|-|
| Waiting | `awaiting_approval` |
| In flight | `pending`, `approved`, `submitted` |
| History | `confirmed`, `failed`, `abandoned` |

Every row shows the rule and its contract (each a link), the action in
words ("pause the contract", "pause `withdraw(uint256)`", "call
`pause()`"), the status, the violation that caused it (a link, with its
block, and "seen in the mempool" for a pending-transaction violation),
and its age.

A waiting row opens to show exactly what would be sent, from the
engine's prepared transaction (requirement R3):

- to: the controller or the contract, by name and address;
- the function and its decoded arguments, with a selector shown as
  the function it names in the contract's ABI;
- value, nonce and the signing key;
- gas limit, maximum fee and priority fee, and the most it can cost;
- the transaction hash;
- a note when the engine rebuilt and re-signed it because the chain
  moved (nonce used, fees stale).

An in-flight row adds any problem the engine recorded (a locked key,
with an **Unlock** link) and, once submitted, each attempt with its
hash and fees. A history row adds the reason for `failed` or
`abandoned` (for example, already paused), and for `confirmed` the
block and gas used.

### Approving and rejecting

**Approve** opens a confirmation that names what will be sent:
"Send `tripGlobal(Treasury vault)` to the controller from `0x1a2b…`,
paying at most 0.0042 ETH." Confirming passes the approval to the
engine, which re-checks its preconditions, rebuilds if the chain moved,
and sends. The row moves to In flight. If the engine instead abandons
it (the pause is already in place), the row says so.

**Reject** takes an optional reason, up to 500 characters, and the
response becomes `abandoned`.

Any account may approve or reject, as accounts are equal
(`AUTHENTICATION.md`); both are logged at info with the username. When
someone else decided first, the engine answers `409` and the dashboard
says what happened ("already approved") and refreshes the row.

### No resend

A `failed` response is final, as the engine keeps it. The row says
why, and that the rule's next violation after its quiet period stages
a new response. To act sooner, a person pauses by hand, below.

## Pausing and unpausing by hand

During an incident a person may need to pause before, or instead of,
a rule. On a contract's page, a **Pause** control offers the calls the
contract's rules would make (its `pause()`, say) and any other function
of the contract a person picks, with its arguments, such as
`unpause()` afterwards. Each opens a confirmation naming the call. The
engine sends it from the signing key through the same path as a
response: pre-flight simulation, the fee caps, the one nonce lane, the
receipt watch (requirement R4). The mode does not gate it, since a
person is acting, not a rule.

For a contract on the controller, where the signing key is an
authorised operator, the control also offers the controller's pause of
the contract or of one function, and unpause for whatever the mirror
shows paused. Unpausing there says what it lifts: unpausing the
contract leaves paused functions paused.

Until the engine offers manual actions, the control shows the call to
make from a wallet instead: for the contract's own functions, the
contract's address and the calldata; for the controller, the
controller's address, value zero and the calldata for `tripGlobal`
(`0x51dd019f`), `trip` (`0xe5ba719d`), `resetGlobal` (`0x326a8018`) or
`reset` (`0x2de63ca2`) with the contract's address and, for a
function, its selector.

## Notifications

A response raises notifications through the engine's record
(`NOTIFICATIONS.md`): waiting for approval, which is the moment a
person must act (requirement N1 there), confirmed, failed and
abandoned. A locked signing key makes the engine degraded, which is a
`health` notification naming the missing signer. Each message links to
the response on this page. The page itself refreshes on the `response`
stream event (`LIVE-UPDATES.md`).

## API

All under `/api/v1`, requiring a session (`AUTHENTICATION.md`), with
the API's error envelope. No MCP tool reads or changes any of it.

| Method | Path | Purpose |
|-|-|-|
| GET | `/settings/response` | `{ mode, key, maxFeeGwei, maxPriorityFeeGwei, replacementBlocks, maxAttempts, submission, privateEndpoints, controller: { address, deployedBlock, known }, passphraseSet }` |
| PUT | `/settings/response` | same shape without the read-only fields, plus `password` when the mode becomes `send`. Returns once the engine is back: `{ applied: true }`; `400 invalid_settings` with issues, `400 send_needs_passphrase`, `403 reauth_failed`, `409 settings_rejected` with the engine's message |
| GET | `/responses` | `?status=waiting\|in_flight\|history&contract&before&limit`; items `{ id, status, action, mode, rule: { id, name }, contract: { address, name }, violation: { id, kind, blockNumber }, tx, error, createdAt, updatedAt }` |
| GET | `/responses/counts` | `{ waiting, inFlight }` for the navigation |
| GET | `/responses/:id` | one response, with `tx` in full: `{ to, function, args, value, nonce, gasLimit, maxFeeGwei, maxPriorityFeeGwei, maxCostWei, hash, rebuilt, attempts }` |
| POST | `/responses/:id/approve` | the resulting response; `409 not_waiting` |
| POST | `/responses/:id/reject` | `{ reason? }`; the resulting response; `409 not_waiting` |
| GET | `/keys` | `[{ address, unlocked, balanceWei, signing, operatorOn: [address] }]` and `directory` |
| POST | `/keys` | `{ passphrase }`; `201 { address, file }` |
| POST | `/keys/import` | `{ keystore, passphrase }`; `201 { address, file }`; `400 invalid_keystore`, `400 wrong_passphrase`, `409 key_exists` |
| POST | `/keys/:address/unlock` | `{ passphrase }`; the key; `400 wrong_passphrase`, `429 too_many_attempts` |
| POST | `/keys/:address/lock` | the key |
| GET | `/readiness` | per contract: `{ address, name, steps: [{ step, state: done\|todo\|not_applicable, detail }], guardianCall? }` |
| POST | `/readiness/:ruleId/test` | `{ ok, revertReason?, gasEstimate, maxCostWei, balanceWei }` |
| POST | `/contracts/:address/actions` | `{ call: { function, args, value? } }` for one of the contract's own functions, or `{ controller: pause\|unpause, scope: contract\|function, selector? }` for a contract on the controller; the recorded action; `501 not_available` until the engine offers it |

Key, approval, rejection, manual action and mode changes are logged at
info with the username; passphrases and passwords never are.

## Command line

`tripwire keys` manages keys from the host, for servers where the
dashboard is not at hand. The commands need the engine running. They
reach it directly over its control interface, reading its address from
`engine.toml` and its interface secret from `TRIPWIRE_HOME/engine/`,
rather than through the server: the CLI has no session, and whoever
can read `TRIPWIRE_HOME` already holds everything a session would
grant, which is the same reasoning as `tripwire user` working on
`users.json` directly (`AUTHENTICATION.md`). They do what the dashboard
does, through the same engine endpoints.

| Command | Does |
|-|-|
| `tripwire keys list` | address, locked or unlocked, balance, and which is the signing key |
| `tripwire keys create` | prompts for a passphrase twice, creates the key, prints its address and file |
| `tripwire keys import <keystore file>` | prompts for the passphrase, imports the keystore |
| `tripwire keys unlock <address>` | prompts for the passphrase; the key signs until it is locked or the engine restarts |
| `tripwire keys lock <address>` | stops the key signing at once |

Passphrases are read from the terminal with echo off, or from
`TRIPWIRE_KEYS_PASSPHRASE` for scripted installs, never from an
argument where they would land in shell history. With the engine
stopped, each command says so and exits non-zero.

## What the application requires of the engine

| # | Requirement | Why |
|-|-|-|
| R1 | `GET /v1/keys` includes each key's native balance at the current block, in wei as a decimal string | the dashboard warns that a key cannot pay for gas without talking to the chain itself |
| R2 | `POST /v1/responses/dry-run { rule_id }`: builds the rule's on-chain action from the signing key and simulates it at the current block, sending nothing, returning `{ ok, revert_reason?, gas_estimate, preview }` | **Test the response** in the readiness checklist: a missing operator grant or role shows before an incident, not during one |
| R3 | The view reference documents the `responses.tx` object: target, function signature, decoded arguments, value, nonce, gas limit, maximum fee, maximum priority fee, hash, the attempts (each with hash, fees and the block it was submitted at) and whether approval rebuilt it | a person approves exactly what will be sent, and the application's types are generated from that file |
| R4 | `POST /v1/actions { action: call \| trip_function \| trip_global \| reset_function \| reset_global, target, call?, selector?, note? }`, where `call` has the shape of a rule's call action, going through the same pre-flight, signing, submission and receipt watch as a response, with a record of its own in a view and a notification at its final status | pausing and unpausing from the dashboard during an incident, attributed to the person through `note` |

## Decisions

| # | Decision | Recommendation and reason |
|-|-|-|
| RS1 | Where the mode lives | The installation, in the application's configuration, applied by restart. A per-rule mode would make "is anything sending on its own?" a question with a hundred answers |
| RS2 | Guarding `send` | The account password again, and the passphrase in the environment. `send` is the one setting that lets Tripwire spend and act with no person in between, and without the passphrase it would stop protecting at the first restart |
| RS3 | Passphrase for unattended starts | Environment only, never a file the application writes. A passphrase stored beside the keystore would make the encryption decorative |
| RS4 | Readiness source | For the call a rule makes, a simulation from the key (R2): it answers "can this key do this?" for any permission scheme without the application knowing the scheme. For the controller steps, its mirrored events, which are reorg-consistent and carry who did what |
| RS5 | Getting the operator authorised | Show the guardian call with its calldata; no wallet connection in the dashboard. Connecting a wallet would put chain access and a large dependency in the application for one call a person makes once per contract |
| RS6 | Resending a failed response | Not offered. The engine keeps `failed` final; a person who needs to act now pauses by hand, which is the clearer action |
| RS7 | Manual pause and unpause | Through the engine (R4), in any mode, behind a confirmation; the call to make from a wallet until then. It is a person's decision, and the dashboard is where they are during an incident |
| RS8 | Controller address | Known deployments shipped as data, overridable in Settings, for contracts that use the controller |
| RS9 | Deleting and exporting keys | Neither, in the dashboard. The file is the key; a delete button next to the only copy of a funded key is a trap |
| RS10 | Who may approve | Any account, logged with the username. Accounts are equal; a two-person rule can come later if owners ask |
| RS11 | Default response | A call to the protected contract's own function from a key granted permission on it. It works with any contract that can be paused today, with nothing to deploy or register; the controller stays an option for contracts built for it |
| RS12 | A key with too much power | Warned, not refused. The owner may have reasons, and a refusal would push them to work around it; the warning names the risk and what to grant instead |

## Checkpoint

Responses are done when, provably and repeatably, against the engine
on a public testnet, with one pausable contract that grants a pauser
role and one contract that uses the controller:

1. From `notify`, a key is created and funded; before the role is
   granted, **Test the response** for a rule calling `pause()` fails
   naming the missing role, and passes once the owner grants it.
2. Made the contract's owner instead, the key is ready but carries the
   least-power warning.
3. On the controller contract, the checklist shows the guardian call;
   sending it from the guardian wallet ticks the step with no reload,
   and the test for a controller pause rule then passes.
4. Switching to `send` without `TRIPWIRE_KEYS_PASSPHRASE` is refused
   naming the variable; with a wrong password it is refused; with a
   passphrase that does not open the key, the engine refuses, the
   previous mode is restored, and the engine's message is shown.
5. In `prepare`, an induced violation appears under Waiting with the
   decoded call, the key and the maximum cost; approving it confirms
   on chain, and the row moves through In flight to History.
6. Two sessions approve the same response; one succeeds and the other
   is told it was already approved.
7. A rejected response is `abandoned` with its reason, and nothing is
   sent.
8. A locked signing key leaves a new response in In flight with the
   problem and an **Unlock** link; unlocking lets it proceed.
9. No passphrase appears in any log line, response body or file under
   `TRIPWIRE_HOME` other than the engine's keystores, checked by a test
   that unlocks with a known passphrase and searches for it.
10. With manual actions available, calling the contract's `pause()`
   from its page confirms on chain and shows in the pause state and
   the Activity page; without them, the control shows the call to
   make from a wallet instead.
