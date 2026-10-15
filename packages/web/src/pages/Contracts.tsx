import { chainName, type TripStateItem } from "@tripwire/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AddContract } from "../components/contracts/AddContract";
import { PageHeader } from "../components/PageHeader";
import { SearchCount, SearchInput } from "../components/SearchInput";
import {
  Button,
  buttonClass,
  EmptyState,
  Eyebrow,
  Plus,
  Tag,
} from "../components/ui";
import { api } from "../lib/api";
import { sourceLabel } from "../lib/format";
import { contractText, matches, readQuery } from "../lib/search";

/** The search, kept in the URL so it can be linked. */
export interface ContractsSearch {
  q?: string;
}

export function readContractsSearch(
  search: Record<string, unknown>,
): ContractsSearch {
  const q = readQuery(search);
  return q ? { q } : {};
}

export function ContractsPage({
  search,
  onSearch,
}: {
  search: ContractsSearch;
  onSearch: (next: ContractsSearch) => void;
}) {
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const { data: contracts, error } = useQuery({
    queryKey: ["contracts"],
    queryFn: ({ signal }) => api.contracts(signal),
  });
  const { data: engine } = useQuery({
    queryKey: ["engine"],
    queryFn: ({ signal }) => api.engine(signal),
    staleTime: Infinity,
  });
  // What is paused now, by contract.
  const { data: paused } = useQuery({
    queryKey: ["trip-state"],
    queryFn: ({ signal }) => api.tripState(signal),
    select: (rows) => {
      const by = new Map<string, TripStateItem[]>();
      for (const row of rows) {
        const at = row.contract.address.toLowerCase();
        by.set(at, [...(by.get(at) ?? []), row]);
      }
      return by;
    },
  });
  const none = contracts?.length === 0;
  const { q } = search;
  const shown = contracts?.filter((c) => {
    const pausedNow = paused?.get(c.address.toLowerCase())?.length
      ? "paused"
      : null;
    return matches(q ?? "", [...contractText(c), pausedNow]);
  });
  const open = (address: string) =>
    void navigate({ to: "/contracts/$address", params: { address } });

  return (
    <div>
      <PageHeader
        title="Contracts"
        description="The contracts Tripwire watches, and the rules on each."
        action={
          !none && (
            <Button
              variant={adding ? "quiet" : "primary"}
              onClick={() => setAdding(!adding)}
            >
              {adding ? (
                "Cancel"
              ) : (
                <>
                  <Plus />
                  Add contract
                </>
              )}
            </Button>
          )
        }
      />

      {error && <p className="text-sm text-red-400">{error.message}</p>}

      {contracts && (adding || none) && (
        <section className="mb-12 space-y-6 bg-white/2 p-6 md:p-8">
          <Eyebrow>
            {none ? "Add your first contract" : "Add a contract"}
          </Eyebrow>
          <AddContract
            chain={engine ? chainName(engine.chainId) : null}
            registered={contracts}
            onRegistered={(contract) => open(contract.address)}
            existing={{ label: "Open it", open }}
          />
        </section>
      )}

      {contracts && contracts.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <SearchInput
            value={q}
            onChange={(next) => onSearch({ q: next })}
            label="Search contracts"
            placeholder="Search by name or address…"
          />
          <span className="ml-auto">
            <SearchCount
              query={q}
              shown={shown?.length ?? 0}
              total={contracts.length}
              noun={["contract", "contracts"]}
            />
          </span>
        </div>
      )}

      {contracts && contracts.length > 0 && shown?.length === 0 && (
        <EmptyState
          title="Nothing matches"
          hint={`No contract matches “${q}”.`}
        >
          <button
            type="button"
            onClick={() => onSearch({})}
            className={buttonClass("ghost")}
          >
            Clear search
          </button>
        </EmptyState>
      )}

      {shown && shown.length > 0 && (
        <ul className="space-y-2">
          {shown.map((contract) => (
            <li key={contract.address}>
              <Link
                to="/contracts/$address"
                params={{ address: contract.address }}
                className="grid gap-2 bg-white/3 px-5 py-4 transition-colors hover:bg-white/5 md:grid-cols-[1fr_auto] md:items-center"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-bold tracking-wider text-white uppercase">
                    <span
                      className={`size-1.5 ${contract.active ? "bg-emerald-500" : "bg-gray-600"}`}
                    />
                    {contract.name}
                    <Tag>{sourceLabel(contract)}</Tag>
                    {!contract.active && (
                      <span className="text-[10px] tracking-[0.2em] text-amber-400">
                        Disabled
                      </span>
                    )}
                    <PausedTag
                      rows={paused?.get(contract.address.toLowerCase())}
                    />
                  </p>
                  <p className="mt-1 truncate font-mono text-xs text-gray-500">
                    {contract.address}
                  </p>
                </div>
                <div className="flex items-center gap-6">
                  <span className="flex w-16 flex-col items-end">
                    <span
                      className={`font-mono text-3xl leading-none font-bold tabular-nums ${
                        contract.ruleCount ? "text-white" : "text-gray-600"
                      }`}
                    >
                      {contract.ruleCount}
                    </span>
                    <span className="mt-1 text-[10px] font-bold tracking-[0.2em] whitespace-nowrap text-gray-500 uppercase">
                      {contract.ruleCount === 1 ? "Rule" : "Rules"}
                      {contract.enabledCount < contract.ruleCount &&
                        ` · ${contract.enabledCount} on`}
                    </span>
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A pause on the contract: **Paused** for every function, else how many. */
function PausedTag({ rows }: { rows: TripStateItem[] | undefined }) {
  if (!rows?.length) return null;
  const functions = new Set(
    rows.filter((r) => r.scope === "function").map((r) => r.selector),
  ).size;
  return (
    <Tag tone="text-red-400">
      {rows.some((r) => r.scope === "global")
        ? "Paused"
        : `${functions} ${functions === 1 ? "function" : "functions"} paused`}
    </Tag>
  );
}
