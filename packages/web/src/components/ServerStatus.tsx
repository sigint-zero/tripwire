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
  pending: { dot: "bg-neutral-300", label: "Checking server…" },
  success: { dot: "bg-emerald-500", label: "Server connected" },
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
    <div className="flex items-center gap-2 px-2 text-xs text-neutral-500">
      <span className={`size-2 rounded-full ${dot}`} />
      {label}
    </div>
  );
}
