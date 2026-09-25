import { useQuery } from "@tanstack/react-query";

async function fetchHealth(): Promise<{ status: string }> {
  const res = await fetch("/api/v1/health");
  if (!res.ok) throw new Error(`health check failed: ${res.status}`);
  return res.json();
}

export function ServerStatus() {
  const { isSuccess } = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 10_000,
    retry: false,
  });

  return (
    <div className="flex items-center gap-2 px-2 text-xs text-neutral-500">
      <span
        className={`size-2 rounded-full ${isSuccess ? "bg-emerald-500" : "bg-red-500"}`}
      />
      {isSuccess ? "Server connected" : "Server unreachable"}
    </div>
  );
}
