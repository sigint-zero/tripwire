import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../lib/api";
import { shortAddress } from "../lib/format";
import { neededSentence } from "./Keys";

/**
 * On every page while the signing key is locked and rules would sign with
 * it: a trip then cannot respond, which nobody should find out from a
 * failed response.
 */
export function LockedKeyBanner() {
  const { data } = useQuery({
    queryKey: ["keys"],
    queryFn: ({ signal }) => api.keys(signal),
    // An engine restart locks every key without passing through here.
    refetchInterval: 30_000,
  });
  const key = data?.keys.find((k) => !k.unlocked && k.neededBy > 0);
  if (!key) return null;
  return (
    <Link
      to="/settings"
      hash="keys"
      className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 border-l-2 border-red-500 bg-red-500/10 px-4 py-3 text-sm text-red-300 transition-colors hover:bg-red-500/15"
    >
      <span className="font-bold tracking-[0.2em] text-red-400 uppercase text-[10px]">
        Key locked
      </span>
      <span className="min-w-48 flex-1">
        {key.name ?? shortAddress(key.address)}: {neededSentence(key.neededBy)}{" "}
        Unlock it in Settings, Keys.
      </span>
    </Link>
  );
}
