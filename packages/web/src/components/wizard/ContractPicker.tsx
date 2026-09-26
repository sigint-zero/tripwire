import type { Contract } from "@tripwire/shared";
import { useState } from "react";
import { rulesLabel, shortAddress } from "../../lib/format";
import { AddContract } from "../contracts/AddContract";
import { ContractExplorer } from "../contracts/ContractExplorer";
import type { LoadedContract } from "../contracts/useRegisteredContract";

/**
 * The registered contracts to choose from, and a way to register another
 * without leaving the page. With none registered yet, registering is all
 * there is.
 */
export function ContractPicker({
  contracts,
  selected,
  loaded,
  chain,
  onSelect,
  locked = false,
}: {
  contracts: Contract[];
  selected: string | null;
  loaded: LoadedContract | null;
  chain: string | null;
  onSelect: (address: string) => void;
  /** Shows only the selected contract: a stored rule stays on its own. */
  locked?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const none = contracts.length === 0;
  const choose = (address: string) => {
    setAdding(false);
    onSelect(address);
  };

  return (
    <div className="space-y-8">
      {!none && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {(locked
            ? contracts.filter((c) => c.address === selected)
            : contracts
          ).map((contract) => {
            const active = contract.address === selected && !adding;
            return (
              <button
                key={contract.address}
                type="button"
                aria-pressed={active}
                disabled={locked}
                title={locked ? "A rule stays on its contract" : undefined}
                onClick={() => choose(contract.address)}
                className={`group relative flex flex-col gap-2 overflow-hidden p-4 text-left transition-colors ${
                  active ? "bg-emerald-500/10" : "bg-white/3 hover:bg-white/5"
                }`}
              >
                <ContractMark
                  className={`pointer-events-none absolute right-4 -bottom-7 size-24 transition-colors duration-500 ${
                    active
                      ? "text-emerald-500/[0.07]"
                      : "text-emerald-500/[0.04] group-hover:text-emerald-500/[0.07]"
                  }`}
                />
                <span className="relative flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-bold tracking-wider text-white uppercase">
                    {contract.name}
                  </span>
                  {!contract.active && (
                    <span className="text-[9px] font-bold tracking-[0.2em] text-amber-400 uppercase">
                      Disabled
                    </span>
                  )}
                </span>
                <span className="relative font-mono text-xs text-gray-500">
                  {shortAddress(contract.address)} · {rulesLabel(contract)}
                </span>
              </button>
            );
          })}
          {!locked && (
            <button
              type="button"
              aria-expanded={adding}
              onClick={() => setAdding(!adding)}
              className={`flex items-center justify-center gap-2 p-4 text-[10px] font-bold tracking-[0.2em] uppercase transition-colors ${
                adding
                  ? "bg-emerald-500/10 text-emerald-400"
                  : "bg-white/3 text-gray-500 hover:bg-white/5 hover:text-emerald-400"
              }`}
            >
              <span
                aria-hidden
                className="text-sm leading-none text-emerald-400"
              >
                +
              </span>
              Add a contract
            </button>
          )}
        </div>
      )}

      {adding || none ? (
        <AddContract
          chain={chain}
          registered={contracts}
          onRegistered={(contract) => choose(contract.address)}
          existing={{ label: "Use it", open: choose }}
        />
      ) : (
        loaded && (
          <div className="space-y-4">
            {!loaded.active && !locked && (
              <p className="text-xs text-amber-400">
                This contract is disabled, so a rule added to it starts disabled
                too.
              </p>
            )}
            <ContractExplorer surface={loaded.surface} />
          </div>
        )
      )}
    </div>
  );
}

/** A contract as a page with a folded corner, set large behind a tile. */
function ContractMark({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={`fill-current ${className}`}
    >
      <path
        fillRule="evenodd"
        d="M4 1 H13.5 V7.5 H20 V23 H4 Z M7 11 H17 V12.5 H7 Z M7 14.5 H17 V16 H7 Z M7 18 H13 V19.5 H7 Z"
      />
      <path d="M15 1 L20 6 H15 Z" />
    </svg>
  );
}
