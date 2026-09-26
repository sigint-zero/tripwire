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

/** "just now", "5m ago", "3h ago", "2d ago", then the date. */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h ago`;
  if (seconds < 7 * 86_400) return `${Math.round(seconds / 86_400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * A raw integer read shifted by a token's decimals, with at most six
 * fraction digits: "1204551.25" for "1204551250000" at 6.
 */
export function formatUnits(raw: string, decimals: number): string {
  const negative = raw.startsWith("-");
  const digits = raw.replace(/^-/, "").padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits
    .slice(digits.length - decimals)
    .slice(0, 6)
    .replace(/0+$/, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}
