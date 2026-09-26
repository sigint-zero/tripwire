import type { ViolationKind } from "@tripwire/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { PageHeader } from "../components/PageHeader";
import { Button, choice, EmptyState, track } from "../components/ui";
import { ViolationList } from "../components/ViolationList";
import { api } from "../lib/api";

const PAGE = 200;

/** What the list shows, kept in the URL so a view can be linked. */
export interface ViolationFilter {
  /** Acknowledged ones too; left out, only open ones. */
  all?: boolean;
  kind?: ViolationKind;
  contract?: string;
  rule?: string;
}

const KINDS: ViolationKind[] = ["tripped", "evaluation_error", "pending"];

/** Reads a filter from the URL, dropping anything malformed. */
export function readFilter(search: Record<string, unknown>): ViolationFilter {
  const filter: ViolationFilter = {};
  if (search.all === true) filter.all = true;
  if (KINDS.includes(search.kind as ViolationKind)) {
    filter.kind = search.kind as ViolationKind;
  }
  if (
    typeof search.contract === "string" &&
    /^0x[0-9a-fA-F]{40}$/.test(search.contract)
  ) {
    filter.contract = search.contract.toLowerCase();
  }
  if (typeof search.rule === "string" && /^\d+$/.test(search.rule)) {
    filter.rule = search.rule;
  }
  return filter;
}

const views = [
  { all: false, title: "Open", hint: "Not acknowledged yet" },
  { all: true, title: "All", hint: "Including acknowledged" },
];

const kinds: { kind?: ViolationKind; title: string; hint: string }[] = [
  { title: "Any kind", hint: "Every kind of violation" },
  { kind: "tripped", title: "Tripped", hint: "The condition held on chain" },
  {
    kind: "evaluation_error",
    title: "Error",
    hint: "The rule could not be evaluated",
  },
  { kind: "pending", title: "Pending", hint: "Seen in the mempool" },
];

const select =
  "cursor-pointer bg-white/3 px-3 py-2.5 text-xs text-gray-300 transition-colors hover:bg-white/5 focus:bg-white/5 focus:outline-none";

export function ViolationsPage({
  filter,
  onFilter,
}: {
  filter: ViolationFilter;
  onFilter: (next: ViolationFilter) => void;
}) {
  const { all = false, kind, contract, rule } = filter;
  const open = !all;
  const violations = useInfiniteQuery({
    queryKey: ["violations", { open, kind, contract, rule }],
    queryFn: ({ pageParam, signal }) =>
      api.violations(
        { open, kind, contract, rule, before: pageParam, limit: PAGE },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) =>
      last.length === PAGE ? last.at(-1)?.id : undefined,
  });
  const { data: contracts } = useQuery({
    queryKey: ["contracts"],
    queryFn: ({ signal }) => api.contracts(signal),
  });
  const { data: rules } = useQuery({
    queryKey: ["rules"],
    queryFn: ({ signal }) => api.rules(undefined, signal),
  });
  const list = violations.data?.pages.flat();
  const set = (change: Partial<ViolationFilter>) =>
    onFilter({ ...filter, ...change });
  const narrowed = kind !== undefined || contract || rule;
  const choosable = rules?.filter(
    (r) => !contract || r.rule.contract.toLowerCase() === contract,
  );

  return (
    <div>
      <PageHeader
        title="Violations"
        description="Every time a rule tripped, with what the engine saw."
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className={track}>
          {views.map((view) => (
            <button
              key={view.title}
              type="button"
              title={view.hint}
              onClick={() => set({ all: view.all || undefined })}
              className={choice(all === view.all)}
            >
              {view.title}
            </button>
          ))}
        </div>
        <div className={track}>
          {kinds.map((k) => (
            <button
              key={k.title}
              type="button"
              title={k.hint}
              onClick={() => set({ kind: k.kind })}
              className={choice(kind === k.kind)}
            >
              {k.title}
            </button>
          ))}
        </div>
        <select
          aria-label="Contract"
          value={contract ?? ""}
          onChange={(e) =>
            set({ contract: e.target.value || undefined, rule: undefined })
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
        <select
          aria-label="Rule"
          value={rule ?? ""}
          onChange={(e) => set({ rule: e.target.value || undefined })}
          className={select}
        >
          <option value="">Every rule</option>
          {choosable?.map((r) => (
            <option key={r.id} value={r.id}>
              {r.rule.name}
            </option>
          ))}
        </select>
        {narrowed && (
          <button
            type="button"
            onClick={() => onFilter({ all: filter.all })}
            className="cursor-pointer text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-gray-300"
          >
            Clear
          </button>
        )}
      </div>

      {violations.error && (
        <p className="text-sm text-red-400">{violations.error.message}</p>
      )}

      {list?.length === 0 && (
        <EmptyState
          title={
            narrowed
              ? "Nothing matches"
              : open
                ? "Nothing open"
                : "No violations yet"
          }
          hint={
            narrowed
              ? "No violation fits these filters."
              : open
                ? "Every violation has been acknowledged."
                : "When a rule trips, it shows up here."
          }
        />
      )}

      {list && list.length > 0 && (
        <>
          <ViolationList
            violations={list}
            contracts={contracts ?? []}
            rules={rules}
          />
          {violations.hasNextPage && (
            <div className="mt-6 flex justify-center">
              <Button
                variant="ghost"
                disabled={violations.isFetchingNextPage}
                onClick={() => void violations.fetchNextPage()}
              >
                Older
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
