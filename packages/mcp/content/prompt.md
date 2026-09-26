Propose the rules Tripwire should watch on the contract "{{contract}}".

1. Read `tripwire://guide/method` and `tripwire://guide/rule-language` if you have not already.
2. Call `get_contract` for "{{contract}}" and `list_rules` for it. Note what the contract holds, who can move it, what it trusts and what it promises.
3. Ask the five questions from the method of this contract, then of each linked address from this contract's point of view.
4. Draft each rule with a threshold justified by the live values and the source, and write that justification in its `description`.
5. Check every draft with `submit_rule` and `check_only: true`. Fix it until it is valid, its sentence says what you meant, it is not a duplicate, and it would not trip right now (or you can say why the contract is already in violation).
6. Submit the rules that pass.

Then present your proposals to the user grouped by the five questions (conserved, bounded, slow-moving, fresh or alive, never happens). For each rule give its English sentence and why its threshold is what it is. Say which questions produced nothing for this contract, and that every submitted rule is disabled until the user enables it in the dashboard.
