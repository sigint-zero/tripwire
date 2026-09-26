import type { TripStateItem } from "@tripwire/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../lib/api";
import { shortAddress, timeAgo } from "../lib/format";
import { EmptyState } from "./ui";

const heading =
  "mb-4 text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase";
const tag =
  "bg-white/5 px-2 py-0.5 text-[10px] font-bold tracking-[0.15em] text-gray-400 uppercase";

/** "withdraw" for "withdraw(uint256)"; the selector when the ABI does not say. */
function what(item: TripStateItem): string {
  if (item.scope === "global") return "Whole contract";
  return item.function
    ? item.function.slice(0, item.function.indexOf("("))
    : (item.selector ?? "");
}

/** Everything paused at this moment, on contracts registered here. */
export function TrippedNow() {
  const { data: paused } = useQuery({
    queryKey: ["trip-state"],
    queryFn: ({ signal }) => api.tripState(signal),
  });

  return (
    <section className="mb-12">
      <h2 className={heading}>Tripped now</h2>
      {paused?.length === 0 && (
        <EmptyState
          compact
          title="Nothing paused"
          hint="No contract or function is paused right now."
        />
      )}
      {paused && paused.length > 0 && (
        <ul className="space-y-1">
          {paused.map((item) => (
            <Row
              key={`${item.contract.address}:${item.selector ?? ""}:${item.source}`}
              item={item}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({ item }: { item: TripStateItem }) {
  const confirmedCall = item.source === "verify";
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-red-500/10 px-5 py-3 text-xs">
      <span aria-hidden className="size-1.5 shrink-0 bg-red-400" />
      <Link
        to="/contracts/$address"
        params={{ address: item.contract.address }}
        className="min-w-0 flex-1 text-sm text-white transition-colors hover:text-red-300"
        title={item.function ?? undefined}
      >
        <span className="font-bold tracking-wider uppercase">
          {item.contract.name}
        </span>{" "}
        <span className="font-mono text-gray-400">{what(item)}</span>
      </Link>
      <span
        className={tag}
        title={
          confirmedCall
            ? `Its confirmation reads as in effect${item.rules.length ? `: ${item.rules.map((r) => r.name).join(", ")}` : ""}.`
            : "Paused through the Tripwire controller."
        }
      >
        {confirmedCall ? "Confirmed call" : "Controller"}
      </span>
      <span className="font-mono text-gray-400 tabular-nums">
        #{item.sinceBlock.toLocaleString("en-US")}
        {item.sinceTime && (
          <span className="text-gray-500"> · {timeAgo(item.sinceTime)}</span>
        )}
      </span>
      <By item={item} />
    </li>
  );
}

/** Who paused it: Tripwire's response, or the transaction that did. */
function By({ item }: { item: TripStateItem }) {
  if (item.actor) {
    return (
      <Link
        to="/responses"
        search={{ tab: "history", open: item.actor.responseId }}
        className="text-emerald-400 transition-colors hover:text-emerald-300"
        title={`The response to ${item.actor.rule.name}`}
      >
        Tripwire
      </Link>
    );
  }
  if (item.txHash) {
    return (
      <span className="font-mono text-gray-500" title={item.txHash}>
        {shortAddress(item.txHash)}
      </span>
    );
  }
  return null;
}
