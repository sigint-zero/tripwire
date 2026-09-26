import { chains } from "@tripwire/shared";
import { shortAddress } from "../../lib/format";
import type { useContract } from "./useContract";

const input =
  "w-full border border-white/10 bg-canvas px-3 py-2.5 font-mono text-sm text-white placeholder:text-gray-600 focus:border-emerald-500/60 focus:outline-none";
const label =
  "mb-2 block text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase";

export function ContractStep({
  chainId,
  address,
  pasted,
  pasteOpen,
  state,
  onChainId,
  onAddress,
  onPasted,
  onPasteOpen,
}: {
  chainId: number;
  address: string;
  pasted: string;
  pasteOpen: boolean;
  state: ReturnType<typeof useContract>;
  onChainId: (id: number) => void;
  onAddress: (address: string) => void;
  onPasted: (text: string) => void;
  onPasteOpen: (open: boolean) => void;
}) {
  const { contract } = state;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
        <label>
          <span className={label}>Chain</span>
          <select
            className={input}
            value={chainId}
            onChange={(e) => onChainId(Number(e.target.value))}
          >
            {chains.map((chain) => (
              <option key={chain.id} value={chain.id}>
                {chain.name}
              </option>
            ))}
          </select>
        </label>
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
      </div>

      <LookupStatus state={state} address={address} />

      {contract && (
        <div className="grid grid-cols-3 gap-px bg-white/5">
          <Stat value={contract.surface.reads.length} label="values to watch" />
          <Stat value={contract.surface.events.length} label="events" />
          <Stat value={contract.surface.writes.length} label="functions" />
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={() => onPasteOpen(!pasteOpen)}
          className="text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-emerald-400"
        >
          {pasteOpen ? "− Use the verified ABI" : "+ Paste an ABI instead"}
        </button>
        {pasteOpen && (
          <div className="mt-3 space-y-2">
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
      </div>
    </div>
  );
}

function LookupStatus({
  state,
  address,
}: {
  state: ReturnType<typeof useContract>;
  address: string;
}) {
  const { contract, looking, lookupError, valid } = state;
  if (!address) {
    return (
      <p className="text-sm text-gray-500">
        Paste the address of a verified contract and its ABI is fetched
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
        {lookupError.message} Paste the ABI below to continue.
      </p>
    );
  }
  if (!contract) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-l-2 border-emerald-500 bg-emerald-500/5 px-4 py-3 text-sm">
      <span className="font-bold text-white">
        {contract.name ?? shortAddress(contract.address)}
      </span>
      <span className="text-gray-400">
        {contract.source === "verified" ? "verified source" : "pasted ABI"}
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

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="bg-panel px-4 py-3">
      <div className="font-display text-2xl font-bold text-white">{value}</div>
      <div className="text-[10px] tracking-[0.2em] text-gray-500 uppercase">
        {label}
      </div>
    </div>
  );
}
