import type { ContractAbi } from "@tripwire/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { isAddress } from "viem";
import { describeAbi, parseAbiText, type ContractSurface } from "../../lib/abi";
import { api } from "../../lib/api";

export interface LoadedContract {
  chainId: number;
  address: string;
  name: string | null;
  implementation: ContractAbi["implementation"];
  surface: ContractSurface;
  source: "verified" | "pasted";
}

/** Resolves a contract's ABI: looked up by address, or pasted by the user. */
export function useContract(chainId: number, address: string, pasted: string) {
  const valid = isAddress(address, { strict: false });
  const usePasted = pasted.trim() !== "";

  const lookup = useQuery({
    queryKey: ["abi", chainId, address.toLowerCase()],
    queryFn: ({ signal }) => api.abi(chainId, address, signal),
    enabled: valid && !usePasted,
    retry: false,
    staleTime: Infinity,
  });

  const pastedAbi = useMemo(() => {
    if (!usePasted) return null;
    try {
      return { surface: describeAbi(parseAbiText(pasted)), error: null };
    } catch (error) {
      return {
        surface: null,
        error: error instanceof Error ? error.message : "Invalid ABI",
      };
    }
  }, [pasted, usePasted]);

  const verifiedSurface = useMemo(
    () => (lookup.data ? describeAbi(lookup.data.abi) : null),
    [lookup.data],
  );

  let contract: LoadedContract | null = null;
  if (valid && pastedAbi?.surface) {
    contract = {
      chainId,
      address,
      name: null,
      implementation: null,
      surface: pastedAbi.surface,
      source: "pasted",
    };
  } else if (valid && !usePasted && lookup.data && verifiedSurface) {
    contract = {
      chainId,
      address,
      name: lookup.data.name,
      implementation: lookup.data.implementation,
      surface: verifiedSurface,
      source: "verified",
    };
  }

  return {
    valid,
    contract,
    looking: valid && !usePasted && lookup.isFetching,
    lookupError: usePasted ? null : lookup.error,
    pasteError: pastedAbi?.error ?? null,
  };
}
