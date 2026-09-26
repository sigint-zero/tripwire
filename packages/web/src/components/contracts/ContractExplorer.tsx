import { useState } from "react";
import type { ContractSurface } from "../../lib/abi";

type Tab = "values" | "events" | "functions";

/** What a contract exposes: the values it can read, its events, its functions. */
export function ContractExplorer({ surface }: { surface: ContractSurface }) {
  const { reads, events, writes } = surface;
  const [tab, setTab] = useState<Tab>(reads.length ? "values" : "events");

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "values", label: "Values", count: reads.length },
    { id: "events", label: "Events", count: events.length },
    { id: "functions", label: "Functions", count: writes.length },
  ];

  return (
    <div className="bg-white/2">
      <div role="tablist" className="flex">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-baseline gap-2 border-b-2 px-4 py-3 text-[10px] font-bold tracking-[0.2em] uppercase transition-colors ${
              tab === t.id
                ? "border-emerald-400 text-emerald-400"
                : "border-transparent text-gray-500 hover:text-gray-300"
            }`}
          >
            {t.label}
            <span className="font-mono text-gray-600">{t.count}</span>
          </button>
        ))}
      </div>

      <ul className="scrollbar-subtle max-h-72 overflow-y-auto py-2 font-mono text-sm">
        {tab === "values" &&
          reads.map((read) => {
            const [name, output] = read.label.split(".");
            return (
              <li key={read.id} className={row}>
                <span>
                  <span className="text-white">{name}</span>
                  <span className={punct}>()</span>
                  {output && <span className="text-gray-300">.{output}</span>}
                </span>
                <span className={type}>
                  {returnType(read.method, read.returns)}
                </span>
              </li>
            );
          })}
        {tab === "events" &&
          events.map((event) => (
            <li key={event.signature} className={row}>
              <Signature
                name={event.name}
                params={eventParams(event.signature)}
              />
            </li>
          ))}
        {tab === "functions" &&
          writes.map((fn) => (
            <li key={fn.signature} className={row}>
              <Signature name={nameOf(fn.signature)} params={fn.inputs} />
              <span className="shrink-0 text-xs text-gray-600">
                {fn.selector}
              </span>
            </li>
          ))}
      </ul>
    </div>
  );
}

const row =
  "flex items-baseline justify-between gap-4 px-4 py-1.5 transition-colors hover:bg-white/3";
const punct = "text-gray-600";
const type = "text-sky-300/80";

/** A declaration set like code: name, then typed parameters. */
function Signature({
  name,
  params,
}: {
  name: string;
  params: { type: string; name: string; indexed?: boolean }[];
}) {
  return (
    <span className="min-w-0 break-words">
      <span className="text-white">{name}</span>
      <span className={punct}>(</span>
      {params.map((p, i) => (
        <span key={i}>
          {i > 0 && <span className={punct}>, </span>}
          <span className={type}>{p.type}</span>
          {p.indexed && <span className="text-violet-300/70"> indexed</span>}
          {p.name && <span className="text-gray-400"> {p.name}</span>}
        </span>
      ))}
      <span className={punct}>)</span>
    </span>
  );
}

const nameOf = (signature: string) =>
  signature.slice(0, signature.indexOf("("));

/** "Transfer(address indexed from, uint256 value)" as its parameters. */
function eventParams(signature: string) {
  const inner = signature.slice(signature.indexOf("(") + 1, -1);
  if (!inner) return [];
  return inner.split(", ").map((param) => {
    const words = param.split(" ");
    return {
      type: words[0] ?? "",
      name: words.at(-1) ?? "",
      indexed: words.includes("indexed"),
    };
  });
}

/** The type a read gives: "uint112" from "getReserves() returns (uint112,…)". */
function returnType(method: string, returns = 0) {
  const types = method.slice(method.indexOf("returns (") + 9, -1).split(",");
  return types[returns] ?? "";
}
