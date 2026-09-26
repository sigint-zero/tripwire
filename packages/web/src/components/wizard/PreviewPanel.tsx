import {
  chainName,
  comparedValues,
  describeRule,
  describeValue,
  type ReadNamer,
  type Rule,
  type RulePreview,
} from "@tripwire/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api } from "../../lib/api";
import { formatBig, shortAddress } from "../../lib/format";
import { CornerBrackets } from "../ui";
import type { LoadedContract } from "./useContract";

const HISTORY = 60;

interface PreviewData {
  preview: RulePreview;
  history: RulePreview[];
}

function usePreview(rule: Rule | null) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ["preview", rule],
    enabled: rule !== null,
    refetchInterval: 1_000,
    retry: false,
    queryFn: async ({ signal }): Promise<PreviewData> => {
      const preview = await api.preview(rule!, signal);
      const previous = queryClient.getQueryData<PreviewData>(["preview", rule]);
      return {
        preview,
        history: [...(previous?.history ?? []), preview].slice(-HISTORY),
      };
    },
  });
}

export function PreviewPanel({
  contract,
  sentence,
  rule,
}: {
  contract: LoadedContract | null;
  sentence: ReactNode;
  rule: Rule | null;
}) {
  const { data, error } = usePreview(rule);
  // Name reads the way the sentence does, from the ABI's output names.
  const name: ReadNamer | undefined = contract
    ? (method, index) =>
        contract.surface.reads.find(
          (r) => r.method === method && r.returnIndex === index,
        )?.label
    : undefined;
  const labels =
    rule?.kind === "expression"
      ? comparedValues(rule.condition).map((v) => describeValue(v, name))
      : [];
  const preview = data?.preview;
  const breaking = preview && !preview.holds;

  return (
    <aside className="relative min-w-0 border border-emerald-500/20 bg-panel p-6">
      <CornerBrackets />
      {preview?.simulated === false ? (
        <p className="mb-5 flex items-center gap-2 text-[10px] font-bold tracking-[0.2em] text-emerald-400 uppercase">
          <span className="size-1.5 bg-emerald-500" />
          Live preview
        </p>
      ) : (
        <p
          className="mb-5 flex items-center gap-2 text-[10px] font-bold tracking-[0.2em] text-amber-400 uppercase"
          title="Values are simulated until the engine is connected."
        >
          <span className="size-1.5 bg-amber-400" />
          Simulated preview
        </p>
      )}

      {contract ? (
        <p className="mb-4 font-mono text-xs text-gray-500">
          {contract.name ?? "Contract"} · {shortAddress(contract.address)} ·{" "}
          {chainName(contract.chainId)}
        </p>
      ) : (
        <p className="text-sm text-gray-600">Pick a contract to begin.</p>
      )}

      {sentence && <div className="mb-4">{sentence}</div>}

      {rule && (
        <p className="mb-6 border-l-2 border-emerald-500/40 pl-3 font-mono text-xs break-words text-gray-400">
          {describeRule(rule, name)}
        </p>
      )}

      {rule && preview && (
        <div className="space-y-5">
          {preview.terms.length === 2 && (
            <div className="grid grid-cols-2 gap-px bg-white/5">
              {preview.terms.map((term, i) => (
                <div key={i} className="bg-canvas px-3 py-3">
                  <div className="truncate text-[10px] tracking-[0.2em] text-gray-500 uppercase">
                    {labels[i] ?? term.label}
                  </div>
                  <div className="mt-1 font-mono text-base text-white tabular-nums">
                    {formatBig(term.value)}
                  </div>
                </div>
              ))}
            </div>
          )}
          {data.history.length > 1 && preview.terms.length === 2 && (
            <Sparkline history={data.history} breaking={!!breaking} />
          )}
          <div
            className={`flex items-center justify-between border px-4 py-3 ${
              breaking
                ? "border-red-500/50 bg-red-500/10"
                : "border-emerald-500/40 bg-emerald-500/5"
            }`}
          >
            <span
              className={`flex items-center gap-2 text-sm font-bold tracking-[0.2em] uppercase ${
                breaking ? "text-red-400" : "text-emerald-400"
              }`}
            >
              <span
                className={`size-2 animate-pulse motion-reduce:animate-none ${breaking ? "bg-red-500" : "bg-emerald-500"}`}
              />
              {breaking ? "Would trip" : "Holds"}
            </span>
            <span className="text-xs text-gray-400">{preview.detail}</span>
          </div>
        </div>
      )}

      {rule && error && (
        <p className="text-xs text-red-400">Preview failed: {error.message}</p>
      )}
    </aside>
  );
}

/** Both compared values over the last few previews. */
function Sparkline({
  history,
  breaking,
}: {
  history: RulePreview[];
  breaking: boolean;
}) {
  const series = [0, 1].map((i) =>
    history.map((p) => Number(BigInt(p.terms[i]?.value ?? "0"))),
  );
  const all = series.flat();
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const width = 300;
  const height = 64;
  const points = (values: number[]) =>
    values
      .map((v, i) => {
        const x = (i / Math.max(values.length - 1, 1)) * width;
        const y = height - 4 - ((v - min) / span) * (height - 8);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-16 w-full"
      preserveAspectRatio="none"
      aria-hidden
    >
      <polyline
        points={points(series[1] ?? [])}
        className="fill-none stroke-gray-500 [stroke-dasharray:4_4]"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
      <polyline
        points={points(series[0] ?? [])}
        className={`fill-none ${breaking ? "stroke-red-500" : "stroke-emerald-400"}`}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
