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
refuses to start in `send` when no key at all is unlocked. After any
restart, planned or not, keys are locked unless the passphrase is in
the environment, so the application refuses the switch without it and
names the variable. The engine's check is only that some key opened:
with several keys, the passphrase may open another key and not the
signing key. So once the engine is back, the application reads
`GET /v1/keys` and requires the signing key to be unlocked; if it is
not, or the engine refused to start, the application restores the
previous mode and says why ("the passphrase does not open the signing
key", or the engine's message).

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
| maximum fee | whole gwei, 1 or more; empty for the engine's default of 100 | hard cap on the fee per gas a response may pay, escalations included |
| starting priority fee | whole gwei, 0 up to the maximum fee; empty for the engine's default of 2 | the tip offered on the first attempt; each replacement raises it, never past the maximum fee |
| replace after | blocks, 1 to 50, default 5 | a transaction not included within this many blocks is resent with a higher fee, same nonce |
| attempts | 1 to 10, default 3 | fee escalations before the response is `failed` |
| submission | `private` (default), `private_strict`, `public` | how the signed transaction reaches the chain, below |
| private endpoints | list of `http` or `https` URLs, empty for the engine's built-in set | replaces the endpoints private submission sends to. The application never writes an empty list: to the engine an empty list is a set with nothing in it |
| controller address | address, empty for the known deployment | overrides the known controller for this chain (stored as `chain.controllerAddress`, with its deployment block) |

Submission, explained where it is chosen:

| Value | Behaviour |
|-|-|
| `private` | sent to private submission endpoints that do not broadcast to the public mempool, so the pause cannot be seen and raced before it lands. If every attempt fails to be included, one last attempt goes public, with an alert saying so. On a chain with no built-in endpoints and none configured, every attempt goes public; the engine warns at start and Settings says so beside the choice |
| `private_strict` | private only; never public. A chain with no private endpoints refuses to start in this setting |
| `public` | through the configured RPC endpoint, visible to everyone the moment it is sent |

Whether a transaction seen in the mempool may start a response is a
detection setting (`SETTINGS.md`, Detection).

## Keys

In Settings, Keys. The engine keeps keys as standard encrypted keystore
files in `TRIPWIRE_HOME/engine/keys/`, one per key; any standard
Ethereum tool opens them, and a keystore made elsewhere can be
imported.

The list shows each key's name when it has one, its address, whether
it is unlocked, its native balance at the current block (the engine
reports it with each key) in the chain's currency, whether it is the
signing key and, for contracts that use the controller, the ones it is
an authorised operator on (from the controller's events, below). A zero
balance is flagged: a key that cannot pay for gas cannot respond.

**One key, for now.** The engine signs with the key named as the
signing key in the response settings, or else with the only key; with
several keys and none named, it cannot tell which signs, and every
response waits. Until the signing key can be chosen in the dashboard,
Tripwire holds one key: **Create** and **Import** are offered only
while there is none, the server refuses a second with `409 one_key`,
and the section says there is no adding another. Keystore files put in
the keys directory by hand still count; when that leaves several keys
and none is named to sign, the list says so in red above the keys, with
what to do (keep one; remove the others' files while Tripwire is
stopped).

**A locked key that rules need is shown in red.** A key's `neededBy` is
the number of enabled rules whose trip sends a transaction (any action
but `notify`), counted for the signing key while the response mode is
`prepare` or `send`, since `notify` builds nothing. While that key is
locked and `neededBy` is above zero:

- its row in Keys is tinted red, its "Locked" is red, and a line under
  it says how many rules sign with it and to unlock it;
- every page of the dashboard shows a red **Key locked** banner under
  the top bar, naming the key and the count and linking to Settings,
  Keys. It reads the keys every 30 seconds as well as after any change
  made here, because an engine restart locks every key without passing
  through the dashboard.

**Details** on a key opens it in place:

| Part | Shows |
|-|-|
| Name | what people call the key ("Pauser", "Hot wallet"), up to 60 characters, saved by the application in `app.key_names`; empty forgets it. The engine never sees it |
| Address and file | each with a copy button; how to fund the key (send the chain's currency to the address: every transaction it sends pays gas) and a link to the address on the chain's block explorer, for chains with a known one |
| What it may do | for each registered contract, whether the key is its `owner()` or holds `DEFAULT_ADMIN_ROLE` (read at the current block through the engine, one batch, only for contracts whose ABI has those views), and the contracts the controller names it an operator on. Owner and admin are shown as warnings, as in the least-power check (Readiness, below); a read that fails says so and still shows the operator grants |
| Sent from it | the transactions the engine sent from the key, newest first: responses (linked to the response, with the rule's name) and actions by hand (linked to the contract's page, with the note). Each shows the call and the contract, its status, the gas it used once confirmed, and its hash, linked to the explorer. Built transactions that were never sent are left out |

A transaction belongs to a key by the sender its `tx` names. A
transaction that names none was sent by the only key when there is one
key, because the engine signs with that key alone. With several keys
such a transaction cannot be placed: the list leaves it out and counts
it below the list ("2 more transactions do not name the key that sent
them").

| Action | Does |
|-|-|
| **Create** | a passphrase, typed twice, 12 characters or more. The engine generates the key and returns its address; the new key starts unlocked. The dialog then says where the file is and that the passphrase cannot be recovered |
| **Import** | a keystore file (JSON, up to 64 KB) and its passphrase. The engine checks it opens before storing it; the imported key starts locked, so the dialog offers **Unlock** next. When several keys are allowed again, the server must refuse a keystore whose address is already in the list before forwarding it: the engine would replace a key it already holds |
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

Unlocking through the dashboard is limited to five attempts per key
per minute, a limit the server keeps; the engine's answer to a wrong
passphrase says nothing more than that. The command line reaches the
engine directly (below) and is not under this limit: whoever can run
it already holds the keystore files.

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
| least power | the key is not the contract's owner and does not hold `DEFAULT_ADMIN_ROLE` (above); not applicable when the ABI has neither `owner()` nor `hasRole(bytes32,address)` | a warning with what to grant instead; does not block |
| mode | not `notify` | links to Settings, Response |

For a contract whose enabled rules use the controller's pause actions,
two steps join the list before **permission**:

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
at the current block, sending nothing (`POST /v1/responses/dry-run`). A
pass shows the call as the engine built it, the key it would be sent
from, the gas it would use and the most it could cost (the gas times
the maximum fee), compared with the key's balance. A failure shows the
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
engine's prepared transaction (the `tx` object of `api_v1.responses`,
documented in the engine's view reference):

- to: the controller or the contract, by name and address;
- the function and its decoded arguments, with a selector shown as
  the function it names in the contract's ABI;
- value, nonce and the signing key;
- gas limit, maximum fee and priority fee, and the most it can cost;
- the transaction hash;
- a note when the engine rebuilt and re-signed it because the chain
  moved (nonce used, fees stale).

An in-flight row adds any problem the engine recorded (a locked key
parks the response at `pending` with the problem, shown with an
**Unlock** link) and, once submitted, each attempt with its
hash and fees. A history row adds the reason for `failed` or
`abandoned` (for example, already paused), and for `confirmed` the
block and gas used.

### Approving and rejecting

**Approve** opens a confirmation that names what will be sent:
"Send `pause()` to Treasury vault from `0x1a2b…`, paying at most
0.0042 ETH." Confirming passes the approval to the
engine, which re-checks its preconditions, rebuilds if the chain moved,
and sends. The row moves to In flight. If the engine instead abandons
it (the pause is already in place), the row says so.

**Reject** takes an optional reason, up to 500 characters, and the
response becomes `abandoned`.

Any account may approve or reject, as accounts are equal
(`AUTHENTICATION.md`); both are logged at info with the username. The
engine refuses a decision two ways, and the server keeps them apart:

| Engine answer | Server answer | The dashboard says |
|-|-|-|
| `409 wrong_status` | `409 not_waiting` | what happened ("already approved", "already rejected") and refreshes the row |
| `409 busy` (approve only) | `409 busy` | another transaction is in flight on the signing key; the response stays waiting, try again once it settles |

### No resend

A `failed` response is final, as the engine keeps it. The row says
why, and that the rule's next violation after its quiet period stages
a new response. To act sooner, a person pauses by hand, below.

## Pausing and unpausing by hand

During an incident a person may need to pause before, or instead of,
a rule. On a contract's page, a **Pause** control offers the calls the
contract's rules would make (its `pause()`, say) and any other function
of the contract a person picks, with its arguments, such as
`unpause()` afterwards. Each opens a confirmation naming the call.
The confirmation also shows the encoded call (the contract's address
and the calldata, each with a copy button), so a person can send the
same call from a wallet of their own if Tripwire cannot.

The engine sends the call itself (`POST /v1/actions`, kind `call`,
with the function in signature form and its arguments as literal
strings, encoded exactly as a rule's call action) from the signing
key. A manual call carries no value.

For a contract on the controller, where the signing key is an
authorised operator, the control also offers the controller's pause of
the contract or of one function, and unpause for whatever the mirror
shows paused (kinds `trip_global`, `trip_function`, `reset_global`,
`reset_function`). A contract not registered with the controller is
refused before anything is sent.

Every kind goes through the same path as a response: pre-flight
simulation, which is the guard for a direct call, the fee caps, the one
nonce lane, the receipt watch. The mode does not gate them, since a
person is acting, not a rule, and a problem with the signing key fails
the request at once instead of parking it. Each is recorded in
`api_v1.actions` (with `function` and `args` for a call) with the
person's username and note, and notifies at its final status.
Unpausing says what it lifts: unpausing the contract through the
controller leaves paused functions paused.

## Notifications

A response raises notifications through the engine's record
(`NOTIFICATIONS.md`): confirmed, failed and abandoned, and waiting for
approval, which the engine records in the same transaction as the hold
because it is the moment a person must act. A response parked on a locked signing
key raises one `response` notification with status `pending` and the
problem. The engine itself becomes degraded, a `health` notification,
only when the mode is `send` and no key at all is unlocked. A manual
action through the controller notifies at its final status the same
way. Each message links to the response on this page, or for a manual
action to Activity. The page itself refreshes on the `response` stream
event (`LIVE-UPDATES.md`).

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
| POST | `/responses/:id/approve` | the resulting response; `409 not_waiting`, `409 busy` |
| POST | `/responses/:id/reject` | `{ reason? }`; the resulting response; `409 not_waiting` |
| GET | `/keys` | `{ keys: [{ address, name, unlocked, balanceWei, signing, neededBy, operatorOn: [address], file }], directory }` |
| GET | `/keys/:address` | `{ key, powers: [{ contract: { address, name }, power: owner\|admin\|operator }], powersProblem, transactions: [{ kind: response\|action, id, reason, call, contract: { address, name }, status, hash, block, gasUsed, createdAt }], unattributed }`; `404 not_found` for a key the engine does not hold |
| PUT | `/keys/:address/name` | `{ name }`, trimmed; empty or `null` forgets it: `{ address, name }`; `400 invalid_name` over 60 characters, `404 not_found` |
| POST | `/keys` | `{ passphrase }`; `201 { address, file }`; `409 one_key` while a key exists |
| POST | `/keys/import` | `{ keystore, passphrase }`; `201 { address, file }`; `400 invalid_keystore`, `400 wrong_passphrase`, `409 one_key` while a key exists |
| POST | `/keys/:address/unlock` | `{ passphrase }`; the key; `400 wrong_passphrase`, `429 too_many_attempts` |
| POST | `/keys/:address/lock` | the key |
| GET | `/readiness` | `?contract`; per contract: `{ address, name, steps: [{ step, state: done\|todo\|not_applicable, detail }], guardianCall: { to, value, data, from } \| null, rules: [{ id, name, action, test }] }`; `step` one of `signing_key`, `rules`, `registered`, `operator`, `permission`, `least_power`, `mode` |
| POST | `/readiness/:ruleId/test` | `{ ok, revertReason, gasEstimate, sender, balanceWei, function, args, testedAt }` |
| POST | `/contracts/:address/actions` | `{ call: { function, args }, note? }` for one of the contract's own functions, or `{ controller: pause\|unpause, scope: contract\|function, selector?, note? }` for the controller: `201` the recorded action `{ id, kind, target, selector, function, args, note, status, error, txHash, createdAt }`; `409 not_on_controller` when a controller action names a contract not registered with it; the engine's refusal (a failed pre-flight, no usable signing key) passed through with its message; `400 invalid_action` for a malformed request or a function selector missing |

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

While Tripwire holds one key (Keys, above), `create` and `import` refuse
when a key exists, as the dashboard does.

Passphrases are read from the terminal with echo off, or from
`TRIPWIRE_KEYS_PASSPHRASE` for scripted installs, never from an
argument where they would land in shell history. With the engine
stopped, each command says so and exits non-zero.

## What the application requires of the engine

The engine's published interface carries everything this
spec needs: each key's native balance at the current block in
`GET /v1/keys` (field `balance`, wei as a decimal string), the
simulation behind **Test the response** in
`POST /v1/responses/dry-run { rule_id }` (`{ ok, revert_reason,
gas_estimate, preview }`), the `responses.tx` object documented in the
view reference, and actions by hand in `POST /v1/actions`, recorded
in `api_v1.actions`: the controller's pauses and unpauses, and a `call`
of any declared function on a watched contract, whether or not it is
on the controller.

One requirement is open:

| # | Requirement | Why |
|-|-|-|
| R5 | `responses.tx` and `actions.tx` name the sending key, as `from` (lowercase `0x` address) | a key's history in Keys is placed by sender. Without it, a transaction can be placed only while one key exists, and adding a second key hides every earlier transaction from the first key's list. The application already reads `from` when present |

## Decisions

| # | Decision | Recommendation and reason |
|-|-|-|
| RS1 | Where the mode lives | The installation, in the application's configuration, applied by restart. A per-rule mode would make "is anything sending on its own?" a question with a hundred answers |
| RS2 | Guarding `send` | The account password again, and the passphrase in the environment. `send` is the one setting that lets Tripwire spend and act with no person in between, and without the passphrase it would stop protecting at the first restart |
| RS3 | Passphrase for unattended starts | Environment only, never a file the application writes. A passphrase stored beside the keystore would make the encryption decorative |
| RS4 | Readiness source | For the call a rule makes, a simulation from the key (the engine's response dry run): it answers "can this key do this?" for any permission scheme without the application knowing the scheme. For the controller steps, its mirrored events, which are reorg-consistent and carry who did what |
| RS5 | Getting the operator authorised | Show the guardian call with its calldata; no wallet connection in the dashboard. Connecting a wallet would put chain access and a large dependency in the application for one call a person makes once per contract |
| RS6 | Resending a failed response | Not offered. The engine keeps `failed` final; a person who needs to act now pauses by hand, which is the clearer action |
| RS7 | Manual pause and unpause | Through the engine, in any mode, behind a confirmation: a contract's own functions by default, the controller's pauses for a contract registered with it, and the encoded call shown alongside in case a person must send it from a wallet. It is a person's decision, and the dashboard is where they are during an incident |
| RS8 | Controller address | Known deployments shipped as data, overridable in Settings, for contracts that use the controller |
| RS9 | Deleting and exporting keys | Neither, in the dashboard. The file is the key; a delete button next to the only copy of a funded key is a trap |
| RS10 | Who may approve | Any account, logged with the username. Accounts are equal; a two-person rule can come later if owners ask |
| RS11 | Default response | A call to the protected contract's own function from a key granted permission on it. It works with any contract that can be paused today, with nothing to deploy or register; the controller stays an option for contracts built for it |
| RS12 | A key with too much power | Warned, not refused. The owner may have reasons, and a refusal would push them to work around it; the warning names the risk and what to grant instead |
| RS13 | Key names | Kept by the application, not the engine. A name is a label for people; the keystore file stays the standard format any tool opens, and the engine's interface does not grow for it |
| RS14 | One key until the signing key can be chosen | Refuse a second key rather than warn about it. With two keys and none named, every response waits, and the dashboard cannot name one yet; a second key has no use until it can |

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
   passphrase that opens no key, the engine refuses to start; with
   two keys and a passphrase that opens only the other one, the
   application finds the signing key locked after the restart. In both
   cases the previous mode is restored and the reason is shown.
5. In `prepare`, an induced violation appears under Waiting with the
   decoded call, the key and the maximum cost; approving it confirms
   on chain, and the row moves through In flight to History.
6. Two sessions approve the same response; one succeeds and the other
   is told it was already approved. Approving while another
   transaction is in flight on the key says so, and the response stays
   waiting.
7. A rejected response is `abandoned` with its reason, and nothing is
   sent.
8. A locked signing key leaves a new response in In flight with the
   problem and an **Unlock** link, and raises one notification saying
   so; unlocking lets it proceed.
9. No passphrase appears in any log line, response body or file under
   `TRIPWIRE_HOME` other than the engine's keystores, checked by a test
   that unlocks with a known passphrase and searches for it.
10. On the controller contract, a pause by hand from its page
   confirms on chain and shows in trip state and on Activity, naming
   the person; on a contract not registered with the controller the
   same request is refused. On the pausable contract, the **Pause**
   control for `pause()` sends it from the signing key, confirms on
   chain and shows on Activity naming the person; with the key locked
   the request fails at once, and the confirmation's calldata sent from
   the wallet that holds the role pauses it instead.
