import type {
  Contract,
  ResponseItem,
  SavedRule,
  Violation,
} from "@tripwire/shared";

/**
 * Whether every word of the query appears somewhere in the texts, ignoring
 * case: "vault pause" finds a rule on "Treasury vault" that pauses. An empty
 * query matches everything.
 */
export function matches(query: string, texts: (string | null | undefined)[]) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = texts.filter(Boolean).join("\n").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** The query as kept in the URL: trimmed, and absent when empty. */
export function readQuery(search: Record<string, unknown>) {
  return typeof search.q === "string" && search.q.trim()
    ? search.q.slice(0, 200)
    : undefined;
}

/** A contract's name by its address, for the lists that only hold the address. */
export function contractNames(contracts: Contract[] | undefined) {
  return new Map(
    (contracts ?? []).map((c) => [c.address.toLowerCase(), c.name]),
  );
}

/** What a rule is found by: its name, description, sentence, contract and action. */
export function ruleText(rule: SavedRule, names: Map<string, string>) {
  const { name, description, contract, severity, on_trip } = rule.rule;
  return [
    name,
    description,
    rule.sentence,
    contract,
    names.get(contract.toLowerCase()),
    severity,
    rule.status,
    on_trip.action.replace("_", " "),
    on_trip.action === "trip_function" ? on_trip.function : null,
    on_trip.action === "call" ? on_trip.call.function : null,
  ];
}

/** What a contract is found by: its name, address, implementation and ABI source. */
export function contractText(contract: Contract) {
  return [
    contract.name,
    contract.address,
    contract.source,
    contract.implementation?.address,
    contract.implementation?.name,
    contract.active ? null : "disabled",
  ];
}

/** What a violation is found by: its rule, contract, kind, block and transaction. */
export function violationText(
  violation: Violation,
  names: Map<string, string>,
) {
  return [
    violation.ruleName,
    violation.contractAddress,
    names.get(violation.contractAddress.toLowerCase()),
    violation.kind.replace("_", " "),
    violation.severity,
    String(violation.blockNumber),
    violation.txHash,
    violation.acknowledged?.by,
    violation.acknowledged?.note,
  ];
}

/** What a response is found by: its rule, contract, call, status and transaction. */
export function responseText(item: ResponseItem) {
  return [
    item.rule.name,
    item.contract.name,
    item.contract.address,
    item.action.replace("_", " "),
    item.status.replace("_", " "),
    item.tx?.function,
    ...(item.tx?.args ?? []),
    item.tx?.hash,
    item.error,
  ];
}
