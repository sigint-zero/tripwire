// Durations as a person types them: a whole number and a unit. Rules store
// seconds; blocks are a way of entering them, converted with the chain's
// block time.

export type Unit = "blocks" | "seconds" | "minutes" | "hours" | "days";

const SIZES: Record<Exclude<Unit, "blocks">, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3_600,
  days: 86_400,
};

/** Largest first, for reading seconds back in the roundest unit. */
const LARGEST_FIRST = ["days", "hours", "minutes", "seconds"] as const;

/** Seconds per block on chains with a steady block time; others offer no blocks. */
const BLOCK_SECONDS: Record<number, number> = {
  1: 12,
  11155111: 12,
  8453: 2,
  84532: 2,
  10: 2,
  137: 2,
  42161: 0.25,
};

export function blockSeconds(chainId: number | undefined): number | null {
  return chainId === undefined ? null : (BLOCK_SECONDS[chainId] ?? null);
}

/** The bounds the engine sets on a window. */
export const MIN_SECONDS = 60;
export const MAX_SECONDS = 2_592_000;

export function toSeconds(
  amount: number,
  unit: Unit,
  perBlock: number | null,
): number | null {
  if (unit !== "blocks") return amount * SIZES[unit];
  return perBlock === null ? null : Math.round(amount * perBlock);
}

/** Seconds in the roundest unit that holds them whole: 5400 → 90 minutes. */
export function fromSeconds(seconds: number): { amount: number; unit: Unit } {
  const unit = LARGEST_FIRST.find((u) => seconds % SIZES[u] === 0) ?? "seconds";
  return { amount: seconds / SIZES[unit], unit };
}

/** "1 hour", "90 minutes", "2 days". */
export function humanDuration(seconds: number): string {
  const { amount, unit } = fromSeconds(seconds);
  return `${amount} ${amount === 1 ? unit.slice(0, -1) : unit}`;
}

/** Why a duration cannot be used, or null. */
export function durationProblem(seconds: number | null): string | null {
  if (seconds === null) return "This chain's block time is not known.";
  if (seconds < MIN_SECONDS) return "At least 1 minute.";
  if (seconds > MAX_SECONDS) return "At most 30 days.";
  return null;
}
