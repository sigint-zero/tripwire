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
}: {
  contracts: Contract[];
  selected: string | null;
  loaded: LoadedContract | null;
  chain: string | null;
  onSelect: (address: string) => void;
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
          {contracts.map((contract) => {
            const active = contract.address === selected && !adding;
            return (
              <button
                key={contract.address}
                type="button"
                aria-pressed={active}
                onClick={() => choose(contract.address)}
                className={`flex flex-col gap-2 p-4 text-left transition-colors ${
                  active ? "bg-emerald-500/10" : "bg-white/3 hover:bg-white/5"
                }`}
              >
                <span className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-bold tracking-wider text-white uppercase">
                    {contract.name}
                  </span>
                  {!contract.active && (
                    <span className="text-[9px] font-bold tracking-[0.2em] text-amber-400 uppercase">
                      Disabled
                    </span>
                  )}
                </span>
                <span className="font-mono text-xs text-gray-500">
                  {shortAddress(contract.address)} · {rulesLabel(contract)}
                </span>
              </button>
            );
          })}
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
            <span aria-hidden className="text-sm leading-none">
              +
            </span>
            Add a contract
          </button>
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
            {!loaded.active && (
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
