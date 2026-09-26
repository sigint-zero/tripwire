import type { LoadedContract } from "../contracts/useRegisteredContract";

/**
 * Opens a cheat sheet of what the chosen contract exposes: the values,
 * events and functions its rules can use.
 */
export function ContractReference({
  contract,
  open,
  onToggle,
}: {
  contract: LoadedContract;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      title="The values, events and functions rules can use"
      className={`inline-flex h-9 items-center gap-3 px-4 transition-colors ${
        open
          ? "bg-emerald-500/10 text-emerald-400"
          : "bg-white/4 text-gray-400 hover:bg-white/6 hover:text-emerald-400"
      }`}
    >
      <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
        <path
          d="M5.5 3 C3.5 3 4 6.5 2.5 8 C4 9.5 3.5 13 5.5 13 M10.5 3 C12.5 3 12 6.5 13.5 8 C12 9.5 12.5 13 10.5 13"
          className="fill-none stroke-current stroke-[1.5]"
        />
      </svg>
      <span className="text-[10px] font-bold tracking-[0.2em] uppercase">
        {contract.name} contract reference
      </span>
      <span className="font-mono text-[11px] text-gray-600">
        {plural(contract.surface.reads.length, "value")} ·{" "}
        {plural(contract.surface.events.length, "event")} ·{" "}
        {plural(contract.surface.writes.length, "function")}
      </span>
      <svg
        viewBox="0 0 12 12"
        aria-hidden
        className={`size-2.5 transition-transform ${open ? "-rotate-90" : "rotate-90"}`}
      >
        <path
          d="M4 2 L8 6 L4 10"
          className="fill-none stroke-current stroke-[1.75]"
        />
      </svg>
    </button>
  );
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
