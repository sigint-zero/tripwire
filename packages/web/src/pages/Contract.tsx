import { chainName } from "@tripwire/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ContractExplorer } from "../components/contracts/ContractExplorer";
import { PausePanel } from "../components/contracts/PausePanel";
import { Readiness } from "../components/contracts/Readiness";
import { useRegisteredContract } from "../components/contracts/useRegisteredContract";
import { RuleList } from "../components/RuleList";
import { buttonClass, EmptyState, Plus, Switch, Tag } from "../components/ui";
import { api } from "../lib/api";
import { shortAddress } from "../lib/format";

const heading =
  "mb-4 text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase";

/** One registered contract: its rules, what it exposes, and its switch. */
export function ContractPage({ address }: { address: string }) {
  const key = address.toLowerCase();
  const queryClient = useQueryClient();
  const { contract, error } = useRegisteredContract(key);
  const { data: rules } = useQuery({
    queryKey: ["rules", key],
    queryFn: ({ signal }) => api.rules(key, signal),
  });
  const { data: engine } = useQuery({
    queryKey: ["engine"],
    queryFn: ({ signal }) => api.engine(signal),
    staleTime: Infinity,
  });

  const toggle = useMutation({
    mutationFn: (active: boolean) => api.setContractActive(key, active),
    onSuccess: async (updated) => {
      queryClient.setQueryData(["contract", key], updated);
      await queryClient.invalidateQueries({ queryKey: ["contracts"] });
      await queryClient.invalidateQueries({ queryKey: ["rules"] });
    },
  });

  const back = (
    <Link
      to="/contracts"
      className="text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-emerald-400"
    >
      ← Contracts
    </Link>
  );

  const hasRules = rules !== undefined && rules.length > 0;
  const newRule = (label: string) => (
    <Link to="/rules/new" search={{ contract: key }} className={buttonClass()}>
      <Plus />
      {label}
    </Link>
  );

  if (error) {
    return (
      <div className="space-y-4">
        {back}
        <p className="text-sm text-gray-400">{error.message}</p>
      </div>
    );
  }
  if (!contract) return back;

  return (
    <div>
      {back}
      <header className="mt-4 mb-10 flex items-start justify-between gap-6">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <h1 className="font-display text-3xl font-bold tracking-tighter text-white uppercase md:text-4xl">
              {contract.name}
            </h1>
            <Switch
              on={contract.active}
              onChange={(active) => toggle.mutate(active)}
              label={contract.active ? "Watching" : "Disabled"}
              disabled={toggle.isPending}
              title={
                contract.active
                  ? "Switch its rules off together"
                  : "Switch its rules back on"
              }
            />
          </div>
          <p className="mt-3 font-mono text-sm break-all text-gray-400">
            {contract.address}
          </p>
          <p className="mt-3 flex flex-wrap gap-2">
            <Tag>
              {contract.source === "verified" ? "Verified" : "Pasted ABI"}
            </Tag>
            {engine && <Tag>{chainName(engine.chainId)}</Tag>}
            {contract.implementation && (
              <Tag>
                Proxy → {contract.implementation.name ?? "implementation"} at{" "}
                {shortAddress(contract.implementation.address)}
              </Tag>
            )}
          </p>
        </div>
        {hasRules && <div className="shrink-0">{newRule("New rule")}</div>}
      </header>

      {!contract.active && (
        <p className="mb-10 bg-amber-400/10 px-4 py-3 text-sm text-amber-300">
          Its rules were switched off together, and a rule added now starts off.
          Enabling the contract switches the same rules back on.
        </p>
      )}
      {toggle.error && (
        <p className="mb-10 text-sm text-red-400">{toggle.error.message}</p>
      )}

      <section className="mb-12">
        <h2 className={heading}>Paused now</h2>
        <PausePanel contract={contract} rules={rules} />
      </section>

      <section className="mb-12">
        <h2 className={heading}>Rules</h2>
        {hasRules ? (
          <RuleList rules={rules} />
        ) : (
          rules && (
            <EmptyState
              compact
              title="No rules yet"
              hint="Add one and Tripwire starts watching this contract."
            >
              {newRule("Create the first rule")}
            </EmptyState>
          )
        )}
      </section>

      <section className="mb-12">
        <h2 className={heading}>Response readiness</h2>
        <Readiness address={key} />
      </section>

      <section>
        <h2 className={heading}>What it exposes</h2>
        <ContractExplorer surface={contract.surface} />
      </section>
    </div>
  );
}
