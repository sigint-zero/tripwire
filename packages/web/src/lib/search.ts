import type {
  Contract,
  ResponseItem,
  SavedRule,
  Violation,
} from "@tripwire/shared";
import { statusLabel } from "../components/RuleStatus";
import { actions } from "../components/wizard/ResponseStep";
import { sourceLabel } from "./format";
import { responseStatuses } from "./responses";

/**
 * Whether every word of the query appears somewhere in the texts, ignoring
 * case: "vault pause" finds a rule on "Treasury vault" that pauses the
 * contract. Each list matches the words its rows show as well as the values
 * behind them. An empty query matches everything.
 */
export function matches(query: string, texts: (string | null | undefined)[]) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = texts.filter(Boolean).join("\n").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** The query as kept in the URL, absent when blank, at most 200 characters. */
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
    statusLabel(rule.status),
    rule.enabled ? null : "off",
    on_trip.action.replace("_", " "),
    actions.find((a) => a.action === on_trip.action)?.title,
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
    sourceLabel(contract),
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
    violation.kind === "evaluation_error" ? "error" : null,
    violation.acknowledged ? "acknowledged" : "open",
    violation.severity,
    String(violation.blockNumber),
    violation.txHash,
    violation.acknowledged?.by,
    violation.acknowledged?.note,
  ];
}

/** What a response is found by: its rule, contract, call, status and transaction. */
export function responseText(item: ResponseItem, rule?: SavedRule) {
  const onTrip = rule?.rule.on_trip;
  return [
    responseStatuses[item.status].label,
    item.action === "trip_global"
      ? "Pause the contract"
      : item.action === "trip_function"
        ? `Pause ${onTrip?.action === "trip_function" ? onTrip.function : ""}`
        : `Call ${item.tx?.function ?? ""}`,
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
