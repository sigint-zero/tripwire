import { chainName } from "@tripwire/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AddContract } from "../components/contracts/AddContract";
import { PageHeader } from "../components/PageHeader";
import { Button, Eyebrow, Plus, Tag } from "../components/ui";
import { api } from "../lib/api";
import { sourceLabel } from "../lib/format";

export function ContractsPage() {
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
  const none = contracts?.length === 0;
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
              variant={adding ? "ghost" : "primary"}
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
        <ul className="space-y-2">
          {contracts.map((contract) => (
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
