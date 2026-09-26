import { useQuery } from "@tanstack/react-query";
import { useLive } from "../lib/live";

async function fetchHealth(signal: AbortSignal): Promise<{ status: string }> {
  // A server that accepts the connection but never answers counts as down.
  const res = await fetch("/api/v1/health", {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
  });
  if (!res.ok) throw new Error(`health check failed: ${res.status}`);
  return (await res.json()) as { status: string };
}

const states = {
  pending: { dot: "bg-gray-600", label: "Checking server…" },
  success: {
    dot: "animate-pulse bg-emerald-500 motion-reduce:animate-none",
    label: "Server connected",
  },
  error: { dot: "bg-red-500", label: "Server unreachable" },
};

export function ServerStatus() {
  const { status } = useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => fetchHealth(signal),
    refetchInterval: 10_000,
    retry: false,
  });
  const { paused } = useLive();
  const { dot, label } = states[status];

  return (
    <div className="space-y-2 px-3 text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase">
      <p className="flex items-center gap-2">
        <span className={`size-1.5 ${dot}`} />
        {label}
      </p>
      {/* Unreachable already says it; this is the stream alone dropping. */}
      {paused && status === "success" && (
        <p
          className="flex items-center gap-2 text-amber-400/80"
          title="Pages refresh once a minute until the live connection is back"
        >
          <span className="size-1.5 bg-amber-400/80" />
          Reconnecting, updates paused
        </p>
      )}
    </div>
  );
}
