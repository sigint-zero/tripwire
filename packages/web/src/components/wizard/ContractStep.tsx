import { shortAddress } from "../../lib/format";
import { ContractExplorer } from "./ContractExplorer";
import type { useContract } from "./useContract";

const input =
  "w-full bg-white/4 px-3 py-2.5 font-mono text-sm text-white transition-colors placeholder:text-gray-600 hover:bg-white/6 focus:bg-white/6";
const label =
  "mb-2 block text-[10px] font-bold tracking-[0.2em] whitespace-nowrap text-gray-500 uppercase";

export function ContractStep({
  chain,
  address,
  pasted,
  pasteOpen,
  state,
  onAddress,
  onPasted,
  onPasteOpen,
}: {
  /** The chain the engine watches; an installation watches one. */
  chain: string | null;
  address: string;
  pasted: string;
  pasteOpen: boolean;
  state: ReturnType<typeof useContract>;
  onAddress: (address: string) => void;
  onPasted: (text: string) => void;
  onPasteOpen: (open: boolean) => void;
}) {
  const { contract } = state;
  return (
    <div className="space-y-6">
      <div className="grid items-end gap-4 sm:grid-cols-[1fr_auto]">
        <label>
          <span className={label}>Contract address</span>
          <input
            className={input}
            value={address}
            onChange={(e) => onAddress(e.target.value.trim())}
            placeholder="0x…"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <button
          type="button"
          onClick={() => onPasteOpen(!pasteOpen)}
          aria-expanded={pasteOpen}
          className={`inline-flex h-10 items-center justify-center gap-2 px-4 text-[10px] font-bold tracking-[0.2em] whitespace-nowrap uppercase transition-colors ${
            pasteOpen
              ? "bg-emerald-500/10 text-emerald-400"
              : "bg-white/4 text-gray-400 hover:bg-white/6 hover:text-emerald-400"
          }`}
        >
          <svg viewBox="0 0 16 16" aria-hidden className="size-3">
            {pasteOpen ? (
              <path
                d="M4 4 L12 12 M12 4 L4 12"
                className="fill-none stroke-current stroke-2"
              />
            ) : (
              <path
                d="M6 3 H4 V13 H6 M10 3 H12 V13 H10"
                className="fill-none stroke-current stroke-[1.5]"
              />
            )}
          </svg>
          Paste ABI
        </button>
      </div>

      {pasteOpen && (
        <div className="space-y-2">
          <textarea
            aria-label="Contract ABI"
            className={`${input} h-40 resize-y text-xs`}
            value={pasted}
            onChange={(e) => onPasted(e.target.value)}
            placeholder='[{"type":"function","name":"totalAssets", …}]'
            spellCheck={false}
          />
          {state.pasteError && (
            <p className="text-xs text-red-400">{state.pasteError}</p>
          )}
        </div>
      )}

      <LookupStatus state={state} address={address} chain={chain} />

      {contract && <ContractExplorer contract={contract} />}
    </div>
  );
}

function LookupStatus({
  state,
  address,
  chain,
}: {
  state: ReturnType<typeof useContract>;
  address: string;
  chain: string | null;
}) {
  const on = chain ? ` on ${chain}` : "";
  const { contract, looking, lookupError, valid } = state;
  if (!address) {
    return (
      <p className="text-sm text-gray-500">
        Paste the address of a verified contract{on} and its ABI is fetched
        automatically.
      </p>
    );
  }
  if (!valid) {
    return (
      <p className="text-sm text-amber-400">That is not a valid address yet.</p>
    );
  }
  if (looking) {
    return (
      <p className="flex items-center gap-2 text-sm text-gray-400">
        <span className="size-1.5 animate-pulse bg-emerald-500" />
        Looking up the verified source…
      </p>
    );
  }
  if (lookupError) {
    return (
      <p className="text-sm text-amber-400">
        {lookupError.message} Paste its ABI to continue.
      </p>
    );
  }
  if (!contract) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="size-1.5 bg-emerald-500" />
      <span className="font-bold text-white">
        {contract.name ?? shortAddress(contract.address)}
      </span>
      <span className="text-gray-400">
        {contract.source === "verified" ? "verified source" : "pasted ABI"}
        {on}
      </span>
      {contract.implementation && (
        <span className="text-gray-500">
          proxy → {contract.implementation.name ?? "implementation"} at{" "}
          {shortAddress(contract.implementation.address)}
        </span>
      )}
    </div>
  );
}
