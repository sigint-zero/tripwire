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

      <ul className="scrollbar-subtle max-h-72 overflow-y-auto py-2">
        {tab === "values" &&
          reads.map((read) => (
            <li
              key={read.id}
              className="px-4 py-1.5 font-mono text-sm text-white"
            >
              {read.label}
            </li>
          ))}
        {tab === "events" &&
          events.map((event) => (
            <li key={event.signature} className="px-4 py-1.5 font-mono text-sm">
              <span className="text-white">{event.name}</span>
              <span className="text-gray-500">
                {event.signature.slice(event.name.length)}
              </span>
            </li>
          ))}
        {tab === "functions" &&
          writes.map((fn) => (
            <li
              key={fn.signature}
              className="flex items-center justify-between gap-4 px-4 py-1.5 font-mono text-sm"
            >
              <span className="truncate text-white">{fn.signature}</span>
              <span className="text-xs text-gray-600">{fn.selector}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}
