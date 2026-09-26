import type { RuleStatus } from "@tripwire/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PageHeader } from "../components/PageHeader";
import { RuleList } from "../components/RuleList";
import { buttonClass, choice, EmptyState, Plus, track } from "../components/ui";
import { api } from "../lib/api";

/** What the list shows, kept in the URL so a view can be linked. */
export interface RulesSearch {
  created?: string;
  contract?: string;
  status?: RuleStatus;
}

const STATUSES: { status?: RuleStatus; title: string }[] = [
  { title: "All" },
  { status: "tripped", title: "Tripped" },
  { status: "error", title: "Error" },
  { status: "warming", title: "Warming up" },
  { status: "holding", title: "Holding" },
  { status: "off", title: "Off" },
];

export function readRulesSearch(search: Record<string, unknown>): RulesSearch {
  const out: RulesSearch = {};
  if (typeof search.created === "string") out.created = search.created;
  if (
    typeof search.contract === "string" &&
    /^0x[0-9a-fA-F]{40}$/.test(search.contract)
  ) {
    out.contract = search.contract.toLowerCase();
  }
  if (STATUSES.some((s) => s.status && s.status === search.status)) {
    out.status = search.status as RuleStatus;
  }
  return out;
}

const select =
  "cursor-pointer bg-white/3 px-3 py-2.5 text-xs text-gray-300 transition-colors hover:bg-white/5 focus:bg-white/5 focus:outline-none";

export function RulesPage({
  search,
  onSearch,
}: {
  search: RulesSearch;
  onSearch: (next: RulesSearch) => void;
}) {
  const { data: rules, error } = useQuery({
    queryKey: ["rules"],
    queryFn: ({ signal }) => api.rules(undefined, signal),
  });
  const { data: contracts } = useQuery({
    queryKey: ["contracts"],
    queryFn: ({ signal }) => api.contracts(signal),
  });
  const { contract, status } = search;
  const shown = rules?.filter(
    (r) =>
      (!contract || r.rule.contract.toLowerCase() === contract) &&
      (!status || r.status === status),
  );

  return (
    <div>
      <PageHeader
        title="Rules"
        description="Every rule with its current value and status."
        action={
          rules &&
          rules.length > 0 && (
            <Link to="/rules/new" className={buttonClass()}>
              <Plus />
              New rule
            </Link>
          )
        }
      />

      {error && <p className="text-sm text-red-400">{error.message}</p>}

      {rules?.length === 0 && (
        <EmptyState
          title="Nothing watched yet"
          hint="Pick a contract and a starting point, then fill in the blanks."
        >
          <Link to="/rules/new" className={buttonClass()}>
            <Plus />
            Create your first rule
          </Link>
        </EmptyState>
      )}

      {rules && rules.length > 0 && (
        <>
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <div className={track}>
              {STATUSES.map((s) => (
                <button
                  key={s.title}
                  type="button"
                  onClick={() => onSearch({ contract, status: s.status })}
                  className={choice(status === s.status)}
                >
                  {s.title}
                </button>
              ))}
            </div>
            <select
              aria-label="Contract"
              value={contract ?? ""}
              onChange={(e) =>
                onSearch({ status, contract: e.target.value || undefined })
              }
              className={select}
            >
              <option value="">Every contract</option>
              {contracts?.map((c) => (
                <option key={c.address} value={c.address}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          {shown?.length === 0 ? (
            <EmptyState
              title="Nothing matches"
              hint="No rule fits these filters."
            />
          ) : (
            <RuleList
              rules={shown ?? []}
              contracts={contracts ?? []}
              highlight={search.created}
            />
          )}
        </>
      )}
    </div>
  );
}
