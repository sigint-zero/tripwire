import { chainName } from "@tripwire/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/** The chain Tripwire watches. */
export function ChainBadge() {
  const { data: engine } = useQuery({
    queryKey: ["engine"],
    queryFn: ({ signal }) => api.engine(signal),
    staleTime: Infinity,
  });
  if (!engine) return null;
  return (
    <span
      className="flex h-9 items-center bg-white/3 px-3 text-[10px] font-bold tracking-[0.2em] text-gray-400 uppercase"
      title={`Chain ${engine.chainId}`}
    >
      {chainName(engine.chainId)}
    </span>
  );
}
