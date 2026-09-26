# Contracts

How a person registers the contracts Tripwire watches, and manages them
once registered. `HIGH-LEVEL-SPEC.md` places the area; `DATABASE.md`
specifies what the application keeps about contracts; the engine owns
the contracts themselves. Rules on a contract are created in the rule
wizard (`RULE-WIZARD.md`).

## Terms

| Term | Meaning |
|-|-|
| registered contract | a contract Tripwire watches: an address, a name people recognise, and its ABI. Every rule belongs to one |
| disabled | a registered contract whose rules a person switched off together, to be switched back on together |

An installation watches one chain (`DATABASE.md`, DB9), so a contract
is known by its address alone, kept in lowercase.

## Registering

Registering is where a person decides what Tripwire watches. One form
does it, in two places: at the top of the Contracts page, and inline in
the rule wizard's Contract section, so a rule can be started for a
contract that is not registered yet without leaving the wizard.

1. **Address.** As soon as it is valid, the contract's verified ABI is
   looked up on the engine's chain (`RULE-WIZARD.md`, ABI lookup). A
   status line names the contract, whether it is a proxy and which
   implementation it points to, and how many values, events and
   functions rules can use. When there is no verified source, the ABI
   can be pasted instead.
2. **Name.** Pre-filled from the verified source's contract name and
   editable, up to 80 characters: what the team calls it, such as
   "Treasury vault". A pasted ABI carries no name, so one is typed.
3. **Register.** The contract is stored with its ABI. From the
   Contracts page the new contract's page opens; in the wizard it
   becomes the chosen contract.

An address that is already registered is not offered for registering
again; the form names the registered contract and offers to open it
(or, in the wizard, to use it).

While no contract is registered, the Contracts page shows the form
straight away, as the wizard does.

## The list

The Contracts page lists registered contracts by name. Each row shows
the name, the address, its rules ("No rules yet", "3 rules", or "3
rules, 1 on" when some are off), where its ABI came from (verified,
proxy, pasted) and, when it is disabled, that it is. A row opens the
contract's page.

## A contract's page

At `/contracts/:address`:

- the name, the full address, the chain, where the ABI came from and,
  for a proxy, its implementation;
- **Disable** or **Enable**, and **New rule**, which opens the rule
  wizard with this contract chosen;
- its rules, each with the engine's sentence, severity, action, and
  whether it is off;
- what it exposes: the values rules can read, its events and its
  functions, as in the wizard.

## Disabling and enabling

Disabling switches off, in one step, every rule on the contract that is
on, and remembers exactly which rules those were. Enabling switches
those rules back on, and only those: a rule that was already off before
stays off, which is the point of remembering the set (`DATABASE.md`,
Disabling rules and contracts).

While a contract is disabled:

- it shows as disabled in the list, on its page and in the wizard;
- a rule added to it starts off, so the contract stays quiet until a
  person enables it, and the wizard's review says so before it is
  created;
- its trip state keeps being mirrored, because that is an on-chain
  fact, not an evaluation.

Disabling is reversible and asks for no confirmation.

## Not built yet

Nothing below waits on the engine any more; what is missing is the
page.

| What | Notes |
|-|-|
| rename | the server route exists (`PATCH /contracts/:address`); the page does not offer it yet |
| remove | the server route exists (`DELETE /contracts/:address`): the engine removes the contract with its rules and their history, and the application forgets what it kept about them. The page will ask for confirmation, naming how many rules and violations go with it (CT3) |
| verified source files | kept by the application when a contract is added (`app.contract_sources`), for agents and the contract's page |
| live values | the engine reads values at the current block; the values tab can show them |
| trip state | what is paused on the contract right now, by the controller or by a rule's confirmed call; the panel is specified in `ACTIVITY.md` |
| response readiness | whether Tripwire's key can make the calls the contract's rules would make, and, for a contract that uses the optional TripwireController, whether it is set up there; specified in `RESPONSES.md` |
| pause and unpause | a person pausing or unpausing the contract by hand during an incident; specified in `RESPONSES.md` |

## API

All under `/api/v1`, requiring a session (`AUTHENTICATION.md`), with
the API's error envelope.

| Method | Path | Purpose |
|-|-|-|
| GET | `/contracts` | registered contracts by name: `{ id, address, name, active, ruleCount, enabledCount, source, implementation, createdAt }` |
| GET | `/contracts/:address` | one contract, plus its `abi`; `404 not_found` |
| POST | `/contracts` | `{ address, name, abi? }`. Without `abi` the verified ABI is looked up. `201` with the contract; `400 invalid_contract` with issues, `409 already_registered`, `404 not_verified`, `502 lookup_failed` |
| PATCH | `/contracts/:address` | `{ name }`; returns the contract |
| DELETE | `/contracts/:address` | removes the contract, its rules and their history; `204` |
| POST | `/contracts/:address/disable` | switches its rules off, remembering which; returns the contract |
| POST | `/contracts/:address/enable` | switches the remembered rules back on; returns the contract |
| GET | `/rules?contract=:address` | one contract's rules |

`active` is false while the contract is disabled. `source` is
`verified` or `pasted`.

## Engine boundary

Registering sends the address, name and ABI to the engine, which keeps
the ABI with the contract for decoding and authoring (`DATABASE.md`,
DB6). The list and a contract's page read the engine's `contracts` view,
which carries the rule counts, joined with what the application keeps.
Disabling and enabling are one batch call each to the engine, all or
nothing, plus the application's record of which rules were switched
(`app.contract_disables`). In development the stand-in
(`ENGINE.md`) answers in the engine's place with the same shapes.

## Decisions

| # | Decision | Recommendation and reason |
|-|-|-|
| CT1 | Where contracts are registered | One form, on the Contracts page and inline in the rule wizard. Sending the user away mid-wizard to register loses their place |
| CT2 | Name | Required, pre-filled from the verified source. Lists and alerts read better with a name the team uses than with a compiler's |
| CT3 | Confirming | Disabling is undone by enabling, so it asks nothing. Removing destroys history, so it will ask |
| CT4 | Key | The address, lowercase. One chain per installation makes it unique |
