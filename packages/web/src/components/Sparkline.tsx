import type { SeriesBucket } from "@tripwire/shared";

/**
 * A day of a value at a glance: the line through each stretch's last
 * value, with its low-to-high range faint behind it, so a spike shows.
 */
export function Sparkline({
  buckets,
  alert = false,
  className = "h-7 w-28",
}: {
  buckets: SeriesBucket[];
  alert?: boolean;
  className?: string;
}) {
  if (buckets.length < 2) return <span className={className} />;
  const times = buckets.map((b) => Date.parse(b.start));
  const lows = buckets.map((b) => Number(b.min));
  const highs = buckets.map((b) => Number(b.max));
  const t0 = times[0]!;
  const span = times.at(-1)! - t0 || 1;
  const low = Math.min(...lows);
  const range = Math.max(...highs) - low || 1;
  const W = 100;
  const H = 24;
  const x = (t: number) => ((t - t0) / span) * W;
  // Values become numbers only to be placed.
  const y = (v: number) => H - 1 - ((v - low) / range) * (H - 2);
  const line = buckets
    .map((b, i) => `${i ? "L" : "M"}${x(times[i]!)},${y(Number(b.last))}`)
    .join("");
  const upper = times
    .map((t, i) => `${i ? "L" : "M"}${x(t)},${y(highs[i]!)}`)
    .join("");
  const lower = times
    .map((t, i) => `L${x(t)},${y(lows[i]!)}`)
    .reverse()
    .join("");
  const band = `${upper}${lower}Z`;
  const tone = alert ? "text-red-400" : "text-emerald-400";

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className={`${tone} ${className}`}
    >
      <path d={band} fill="currentColor" opacity={0.12} />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
