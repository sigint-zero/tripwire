import type { Contract } from "@tripwire/shared";

const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";

/** A big whole number, readable at a glance: "1,204,551" or "1.516 × 10²⁴". */
export function formatBig(value: string): string {
  const digits = BigInt(value).toString();
  if (digits.length <= 9) return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const exponent = [...String(digits.length - 1)]
    .map((d) => SUPERSCRIPT[Number(d)])
    .join("");
  return `${digits[0]}.${digits.slice(1, 4)} × 10${exponent}`;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** "No rules yet", "3 rules", or "3 rules, 1 on" when some are off. */
export function rulesLabel(contract: Contract): string {
  if (contract.ruleCount === 0) return "No rules yet";
  const rules = `${contract.ruleCount} rule${contract.ruleCount === 1 ? "" : "s"}`;
  return contract.enabledCount === contract.ruleCount
    ? rules
    : `${rules}, ${contract.enabledCount} on`;
}

/** Where a contract's ABI came from, in a word or two. */
export function sourceLabel(contract: Contract): string {
  if (contract.implementation) return "Proxy";
  return contract.source === "verified" ? "Verified" : "Pasted ABI";
}
