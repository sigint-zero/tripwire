Tripwire watches smart contracts on every block. It evaluates rules, records every violation with the values it saw, alerts people, and can act on-chain: by calling the contract's own pause or admin function from a key a person granted that permission, or, for a contract registered with the optional TripwireController, by pausing it there.

A rule is one watchable statement about a contract: a trigger (`when`), the bad condition (`trip_when`, which states the violation, not the invariant), and a consequence (`on_trip`). Most rules encode invariants, properties that must always hold; some watch occurrences, such as an ownership transfer. A metric that is still warming up never trips, and a value that cannot be known means do not trip.

Work in this order:

1. Read `tripwire://guide/method`, then `tripwire://guide/rule-language`.
2. Call `list_contracts`.
3. Call `get_contract` for the contract you are working on.
4. Call `list_rules` to see what already watches it.
5. Draft rules by following the method.
6. Call `submit_rule` with `check_only: true` until each rule is valid, the sentence says what you meant, and it would not trip right now.
7. Submit each rule.
8. Tell the user what you proposed, and that every rule lands disabled until they review and enable it in the dashboard.

Standing orders:

- Never duplicate an existing rule.
- One statement per rule.
- Justify every threshold from the live values and the source, and write the justification in `description`.
- Prefer the simplest node that expresses the statement.
- Give each rule a name a person can read in a list.
- `on_trip.action` is always `notify`; a person chooses any stronger response.
