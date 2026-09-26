import type {
  ResponseItem,
  ResponseStatus,
  ResponseTab,
  SavedRule,
} from "@tripwire/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { PageHeader } from "../components/PageHeader";
import {
  Button,
  choice,
  EmptyState,
  fieldClass,
  Tag,
  track,
} from "../components/ui";
import { responseModes } from "../components/wizard/ResponseStep";
import { api } from "../lib/api";
import { formatBig, formatUnits, shortAddress, timeAgo } from "../lib/format";
import { responseStatuses } from "../lib/responses";

/** Which tab, and which response is open, kept in the URL. */
export interface ResponsesSearch {
  tab?: ResponseTab;
  open?: string;
}

const TABS: { tab: ResponseTab; title: string; statuses: ResponseStatus[] }[] =
  [
    { tab: "waiting", title: "Waiting", statuses: ["awaiting_approval"] },
    {
      tab: "in_flight",
      title: "In flight",
      statuses: ["pending", "approved", "submitted"],
    },
    {
      tab: "history",
      title: "History",
      statuses: ["confirmed", "failed", "abandoned"],
    },
  ];

export function readResponsesSearch(
  search: Record<string, unknown>,
): ResponsesSearch {
  const out: ResponsesSearch = {};
  if (TABS.some((t) => t.tab === search.tab)) {
    out.tab = search.tab as ResponseTab;
  }
  if (typeof search.open === "string" && /^\d+$/.test(search.open)) {
    out.open = search.open;
  }
  return out;
}

const tabOf = (status: ResponseStatus) =>
  TABS.find((t) => t.statuses.includes(status))!.tab;

const empty: Record<ResponseTab, { title: string; hint: string }> = {
  waiting: {
    title: "Nothing waiting",
    hint: "When a rule that acts on chain trips, its transaction waits here for you.",
  },
  in_flight: {
    title: "Nothing in flight",
    hint: "Approved responses show here until they confirm.",
  },
  history: {
    title: "No history yet",
    hint: "Confirmed, failed and rejected responses stay here.",
  },
};

/** The action in words: what the transaction does. */
function actionWords(item: ResponseItem, rule?: SavedRule): ReactNode {
  const onTrip = rule?.rule.on_trip;
  switch (item.action) {
    case "trip_global":
      return "Pause the contract";
    case "trip_function":
      return (
        <>
          Pause{" "}
          <code className="font-mono">
            {onTrip?.action === "trip_function"
              ? onTrip.function
              : (item.tx?.args[1] ?? "a function")}
          </code>
        </>
      );
    case "call":
      return (
        <>
          Call{" "}
          <code className="font-mono">{item.tx?.function ?? "a function"}</code>
        </>
      );
  }
}

/** An address as a name where one is known. */
function named(address: string, item: ResponseItem) {
  if (address.toLowerCase() === item.contract.address) {
    return item.contract.name ?? shortAddress(address);
  }
  return shortAddress(address);
}

/**
 * The function a controller pause names by its selector, as the rule that
 * asked for it wrote it.
 */
function pausedFunction(item: ResponseItem, rule?: SavedRule) {
  const onTrip = rule?.rule.on_trip;
  return item.action === "trip_function" && onTrip?.action === "trip_function"
    ? onTrip.function
    : null;
}

const eth = (wei: string | null) =>
  wei === null ? "–" : `${formatUnits(wei, 18)} ETH`;

export function ResponsesPage({
  search,
  onSearch,
}: {
  search: ResponsesSearch;
  onSearch: (next: ResponsesSearch) => void;
}) {
  const { data: engine } = useQuery({
    queryKey: ["engine"],
    queryFn: ({ signal }) => api.engine(signal),
    staleTime: Infinity,
  });
  const { data: counts } = useQuery({
    queryKey: ["responses", "counts"],
    queryFn: ({ signal }) => api.responseCounts(signal),
  });
  const { data: opened } = useQuery({
    queryKey: ["response", search.open],
    queryFn: ({ signal }) => api.response(search.open!, signal),
    enabled: search.open !== undefined && search.tab === undefined,
  });
  const tab =
    search.tab ?? (opened ? tabOf(opened.status) : undefined) ?? "waiting";
  const { data: items, error } = useQuery({
    queryKey: ["responses", tab],
    queryFn: ({ signal }) => api.responses(tab, signal),
  });
  const { data: rules } = useQuery({
    queryKey: ["rules"],
    queryFn: ({ signal }) => api.rules(undefined, signal),
  });

  const count = (t: ResponseTab) =>
    t === "waiting"
      ? counts?.waiting
      : t === "in_flight"
        ? counts?.inFlight
        : undefined;

  return (
    <div>
      <PageHeader
        title="Responses"
        description="What Tripwire does on chain when a rule trips, and what waits for you."
        action={
          engine && (
            <span title={responseModes[engine.responseMode]}>
              <Tag>
                <span className="mr-2 text-gray-600">Mode</span>
                {engine.responseMode}
              </Tag>
            </span>
          )
        }
      />

      {engine?.responseMode === "notify" && (
        <p className="mb-8 bg-white/3 px-5 py-4 text-sm text-gray-400">
          Violations alert only, and nothing is built.{" "}
          <Link
            to="/settings"
            className="text-emerald-400 transition-colors hover:text-emerald-300"
          >
            Change the mode
          </Link>
        </p>
      )}

      <div className={`mb-6 ${track}`}>
        {TABS.map((t) => (
          <button
            key={t.tab}
            type="button"
            onClick={() => onSearch({ tab: t.tab })}
            className={choice(tab === t.tab)}
          >
            {t.title}
            {count(t.tab) !== undefined && (
              <span
                className={`font-mono tabular-nums ${
                  t.tab === "waiting" && count(t.tab)! > 0
                    ? "text-amber-400"
                    : "text-gray-500"
                }`}
              >
                {count(t.tab)}
              </span>
            )}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-red-400">{error.message}</p>}
      {items?.length === 0 && <EmptyState {...empty[tab]} />}
      {items && items.length > 0 && (
        <ul className="space-y-2">
          {items.map((item) => (
            <ResponseRow
              key={item.id}
              item={item}
              rule={rules?.find((r) => r.id === item.rule.id)}
              expanded={search.open === item.id}
              onToggle={() =>
                onSearch({
                  tab: search.tab,
                  open: search.open === item.id ? undefined : item.id,
                })
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ResponseRow({
  item,
  rule,
  expanded,
  onToggle,
}: {
  item: ResponseItem;
  rule?: SavedRule;
  expanded: boolean;
  onToggle: () => void;
}) {
  const status = responseStatuses[item.status];
  return (
    <li className="bg-white/3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full cursor-pointer items-center justify-between gap-6 px-5 py-4 text-left transition-colors hover:bg-white/2"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-3">
            <span className="truncate text-sm font-bold tracking-wider text-white uppercase">
              {item.rule.name}
            </span>
            <span className="shrink-0 whitespace-nowrap">
              <Tag tone={status.tone}>{status.label}</Tag>
            </span>
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-gray-400">
            <span>{actionWords(item, rule)}</span>
            <span className="font-mono text-gray-500">
              {item.contract.name ?? shortAddress(item.contract.address)}
            </span>
          </span>
        </span>
        <span
          className="shrink-0 text-xs text-gray-500 tabular-nums"
          title={new Date(item.createdAt).toLocaleString()}
        >
          {timeAgo(item.createdAt)}
        </span>
      </button>
      {expanded && <ResponseDetail item={item} rule={rule} />}
    </li>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-4 py-1.5">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="min-w-0 font-mono text-xs break-all text-gray-200">
        {children}
      </dd>
    </div>
  );
}

const linkClass =
  "text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-emerald-400";

function ResponseDetail({
  item,
  rule,
}: {
  item: ResponseItem;
  rule?: SavedRule;
}) {
  const { tx } = item;
  const controller =
    item.action === "trip_global" || item.action === "trip_function";

  return (
    <div className="space-y-5 px-5 pt-1 pb-5">
      {tx && (
        <dl className="bg-black/30 px-4 py-3">
          <Fact label="To">
            {controller ? "Tripwire controller" : named(tx.to ?? "", item)}{" "}
            <span className="text-gray-500">{tx.to}</span>
          </Fact>
          <Fact label="Function">
            {tx.function ?? "–"}
            {tx.args.length > 0 && (
              <ol className="mt-1 space-y-0.5 text-gray-400">
                {tx.args.map((arg, i) => (
                  <li key={i}>
                    <span className="text-gray-600">{i}:</span> {arg}
                    {arg.toLowerCase() === item.contract.address &&
                      item.contract.name && (
                        <span className="text-gray-500">
                          {" "}
                          ({item.contract.name})
                        </span>
                      )}
                    {i === 1 && pausedFunction(item, rule) && (
                      <span className="text-gray-500">
                        {" "}
                        ({pausedFunction(item, rule)})
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Fact>
          <Fact label="Value">{eth(tx.value)}</Fact>
          <Fact label="Signing key">{tx.from ?? "–"}</Fact>
          <Fact label="Nonce">{tx.nonce ?? "–"}</Fact>
          <Fact label="Gas limit">
            {tx.gasLimit ? formatBig(tx.gasLimit) : "–"}
          </Fact>
          <Fact label="Fees">
            {tx.maxFeeGwei ?? "–"} gwei at most, {tx.maxPriorityFeeGwei ?? "–"}{" "}
            gwei tip
          </Fact>
          <Fact label="Most it can cost">{eth(tx.maxCostWei)}</Fact>
          {tx.hash && <Fact label="Hash">{tx.hash}</Fact>}
          {tx.rebuilt && (
            <p className="mt-2 text-xs text-amber-400/80">
              Rebuilt and signed again at approval, because the chain moved.
            </p>
          )}
        </dl>
      )}

      {tx && tx.attempts.length > 0 && (
        <div>
          <p className="mb-2 text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase">
            Sent
          </p>
          <ul className="space-y-1 font-mono text-xs text-gray-400">
            {tx.attempts.map((a) => (
              <li key={a.hash + String(a.block)}>
                {a.block !== null && <>Block {formatBig(String(a.block))} · </>}
                {a.maxFeeGwei ?? "–"} gwei · {shortAddress(a.hash)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {item.status === "confirmed" && tx?.block !== null && tx?.block && (
        <p className="text-sm text-emerald-400">
          Confirmed at block {formatBig(String(tx.block))}
          {tx.gasUsed && <>, using {formatBig(tx.gasUsed)} gas</>}.
        </p>
      )}
      {item.error && (
        <p
          className={`text-sm ${item.status === "failed" ? "text-red-400" : "text-gray-400"}`}
        >
          {item.error}
        </p>
      )}
      {item.status === "failed" && (
        <p className="text-xs text-gray-500">
          A failed response is final. The rule's next violation after its quiet
          period stages a new one.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-4">
        <span className="flex flex-wrap gap-5">
          <Link
            to="/rules/$id"
            params={{ id: item.rule.id }}
            className={linkClass}
          >
            The rule →
          </Link>
          <Link
            to="/contracts/$address"
            params={{ address: item.contract.address }}
            className={linkClass}
          >
            The contract →
          </Link>
          {item.violation && (
            <Link
              to="/violations"
              search={{ rule: item.rule.id, all: true }}
              className={linkClass}
            >
              {item.violation.kind === "pending"
                ? "Seen in the mempool"
                : `Violation at block ${formatBig(String(item.violation.blockNumber))}`}{" "}
              →
            </Link>
          )}
        </span>
        {item.status === "awaiting_approval" && (
          <Decide item={item} rule={rule} />
        )}
      </div>
    </div>
  );
}

/** Approve or reject: each asks first, naming what it does. */
function Decide({ item, rule }: { item: ResponseItem; rule?: SavedRule }) {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState<"approve" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["responses"] }),
      queryClient.invalidateQueries({ queryKey: ["response"] }),
      queryClient.invalidateQueries({ queryKey: ["violations"] }),
    ]);
  const decide = useMutation({
    mutationFn: () =>
      asking === "approve"
        ? api.approveResponse(item.id)
        : api.rejectResponse(item.id, reason.trim()),
    onSuccess: async () => {
      setAsking(null);
      await refresh();
    },
    // Someone may have decided first: show what happened, and refresh.
    onError: () => void refresh(),
  });
  const close = () => {
    setAsking(null);
    decide.reset();
  };
  const { tx } = item;
  const call = tx?.function
    ? `${tx.function.split("(")[0]}(${tx.args
        .map((a, i) =>
          i === 1 && pausedFunction(item, rule)
            ? pausedFunction(item, rule)
            : named(a, item),
        )
        .join(", ")})`
    : "the transaction";
  const recipient =
    item.action === "call" ? named(tx?.to ?? "", item) : "the controller";

  return (
    <span className="flex gap-3">
      <Button variant="danger" onClick={() => setAsking("reject")}>
        Reject
      </Button>
      <Button onClick={() => setAsking("approve")}>Approve</Button>
      <ConfirmDialog
        open={asking === "approve"}
        title="Send this response?"
        confirm="Send it"
        tone="go"
        pending={decide.isPending}
        error={decide.error?.message}
        onConfirm={() => decide.mutate()}
        onClose={close}
      >
        Send <code className="font-mono text-white">{call}</code> to {recipient}
        {tx?.from && (
          <>
            {" "}
            from{" "}
            <code className="font-mono text-white">
              {shortAddress(tx.from)}
            </code>
          </>
        )}
        , paying at most{" "}
        <span className="font-mono text-white">
          {eth(tx?.maxCostWei ?? null)}
        </span>
        .
        {rule && (
          <span className="mt-3 block text-gray-500">
            {actionWords(item, rule)} on{" "}
            {item.contract.name ?? shortAddress(item.contract.address)}.
          </span>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={asking === "reject"}
        title="Reject this response?"
        confirm="Reject it"
        pending={decide.isPending}
        error={decide.error?.message}
        onConfirm={() => decide.mutate()}
        onClose={close}
      >
        Nothing is sent, and the response is abandoned. The rule's next
        violation after its quiet period stages a new one.
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          rows={3}
          placeholder="Reason (optional)"
          className={`mt-4 resize-none ${fieldClass}`}
        />
      </ConfirmDialog>
    </span>
  );
}
