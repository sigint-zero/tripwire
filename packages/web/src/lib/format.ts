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
