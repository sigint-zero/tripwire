import type { Contract, ContractDetail } from "@tripwire/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import { shortAddress } from "../../lib/format";
import { Button, Tag } from "../ui";
import { useContractLookup } from "./useContractLookup";

const input =
  "w-full bg-white/4 px-3 py-2.5 font-mono text-sm text-white transition-colors placeholder:text-gray-600 hover:bg-white/6 focus:bg-white/6";
const label =
  "mb-2 block text-[10px] font-bold tracking-[0.2em] whitespace-nowrap text-gray-500 uppercase";

/**
 * Registers a contract for Tripwire to watch: its address, its ABI (looked
 * up from the verified source, or pasted) and a name people will recognise.
 */
export function AddContract({
  chain,
  registered,
  onRegistered,
  existing,
}: {
  /** The chain the engine watches; an installation watches one. */
  chain: string | null;
  registered: Contract[];
  onRegistered: (contract: ContractDetail) => void;
  /** What to offer when the address is already registered. */
  existing?: { label: string; open: (address: string) => void };
}) {
  const queryClient = useQueryClient();
  const [address, setAddress] = useState("");
  const [pasted, setPasted] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [name, setName] = useState<string | null>(null);

  const state = useContractLookup(address, pasted);
  const { preview } = state;
  const already = registered.find(
    (c) => c.address === address.trim().toLowerCase(),
  );
  const finalName = name ?? preview?.name ?? "";

  const register = useMutation({
    mutationFn: () =>
      api.registerContract({
        address: preview!.address,
        name: finalName.trim(),
        ...(preview?.abi ? { abi: preview.abi } : {}),
      }),
    onSuccess: async (contract) => {
      queryClient.setQueryData(["contract", contract.address], contract);
      await queryClient.invalidateQueries({ queryKey: ["contracts"] });
      onRegistered(contract);
    },
  });

  return (
    <div className="space-y-5">
      <div className="grid items-end gap-4 sm:grid-cols-[1fr_auto]">
        <label>
          <span className={label}>Contract address</span>
          <input
            className={input}
            value={address}
            onChange={(e) => {
              setAddress(e.target.value.trim());
              setName(null);
            }}
            placeholder="0x…"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <button
          type="button"
          onClick={() => {
            setPasteOpen(!pasteOpen);
            if (pasteOpen) setPasted("");
          }}
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
            onChange={(e) => setPasted(e.target.value)}
            placeholder='[{"type":"function","name":"totalAssets", …}]'
            spellCheck={false}
          />
          {state.pasteError && (
            <p className="text-xs text-red-400">{state.pasteError}</p>
          )}
        </div>
      )}

      {already ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-400">
          Already registered as{" "}
          <span className="font-bold text-white">{already.name}</span>
          {existing && (
            <button
              type="button"
              onClick={() => existing.open(already.address)}
              className="text-[10px] font-bold tracking-[0.2em] text-emerald-400 uppercase hover:text-emerald-300"
            >
              {existing.label} →
            </button>
          )}
        </p>
      ) : (
        <LookupStatus state={state} address={address} chain={chain} />
      )}

      {preview && !already && (
        <div className="grid items-end gap-4 sm:grid-cols-[1fr_auto]">
          <label>
            <span className={label}>Name</span>
            <input
              className={input}
              value={finalName}
              maxLength={80}
              placeholder="What your team calls it, e.g. Treasury vault"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <Button
            disabled={!finalName.trim() || register.isPending}
            onClick={() => register.mutate()}
          >
            {register.isPending ? "Registering…" : "Register"}
          </Button>
        </div>
      )}
      {register.error && (
        <p className="text-sm text-red-400">{register.error.message}</p>
      )}
    </div>
  );
}

function LookupStatus({
  state,
  address,
  chain,
}: {
  state: ReturnType<typeof useContractLookup>;
  address: string;
  chain: string | null;
}) {
  const on = chain ? ` on ${chain}` : "";
  const { preview, looking, lookupError, valid } = state;
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
  if (!preview) return null;
  const { reads, events, writes } = preview.surface;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="font-bold text-white">
        {preview.name ?? shortAddress(preview.address)}
      </span>
      <Tag>{preview.source === "verified" ? "Verified" : "Pasted ABI"}</Tag>
      {chain && <Tag>{chain}</Tag>}
      {preview.implementation && (
        <Tag>Proxy → {preview.implementation.name ?? "implementation"}</Tag>
      )}
      <span className="text-gray-500">
        {reads.length} values · {events.length} events · {writes.length}{" "}
        functions
      </span>
    </div>
  );
}
