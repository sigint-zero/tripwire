import { useQuery } from "@tanstack/react-query";

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
  const { dot, label } = states[status];

  return (
    <div className="flex items-center gap-2 px-3 text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase">
      <span className={`size-1.5 ${dot}`} />
      {label}
    </div>
  );
}
