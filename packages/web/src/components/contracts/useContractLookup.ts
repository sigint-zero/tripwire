import type { ContractAbi } from "@tripwire/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { isAddress } from "viem";
import { describeAbi, parseAbiText, type ContractSurface } from "../../lib/abi";
import { api } from "../../lib/api";

/** A contract seen before it is registered. */
export interface ContractPreview {
  address: string;
  name: string | null;
  implementation: ContractAbi["implementation"];
  surface: ContractSurface;
  source: "verified" | "pasted";
  /** The pasted ABI, which registering sends along; a verified one is looked up again. */
  abi: unknown[] | null;
}

/** Resolves a contract's ABI: looked up by address, or pasted by the user. */
export function useContractLookup(address: string, pasted: string) {
  const valid = isAddress(address, { strict: false });
  const usePasted = pasted.trim() !== "";

  const lookup = useQuery({
    queryKey: ["abi", address.toLowerCase()],
    queryFn: ({ signal }) => api.abi(address, signal),
    enabled: valid && !usePasted,
    retry: false,
    staleTime: Infinity,
  });

  const pastedAbi = useMemo(() => {
    if (!usePasted) return null;
    try {
      const abi = parseAbiText(pasted);
      return { abi, surface: describeAbi(abi), error: null };
    } catch (error) {
      return {
        abi: null,
        surface: null,
        error: error instanceof Error ? error.message : "Invalid ABI",
      };
    }
  }, [pasted, usePasted]);

  const verifiedSurface = useMemo(
    () => (lookup.data ? describeAbi(lookup.data.abi) : null),
    [lookup.data],
  );

  let preview: ContractPreview | null = null;
  if (valid && pastedAbi?.surface) {
    preview = {
      address,
      name: null,
      implementation: null,
      surface: pastedAbi.surface,
      source: "pasted",
      abi: pastedAbi.abi,
    };
  } else if (valid && !usePasted && lookup.data && verifiedSurface) {
    preview = {
      address,
      name: lookup.data.name,
      implementation: lookup.data.implementation,
      surface: verifiedSurface,
      source: "verified",
      abi: null,
    };
  }

  return {
    valid,
    preview,
    looking: valid && !usePasted && lookup.isFetching,
    lookupError: usePasted ? null : lookup.error,
    pasteError: pastedAbi?.error ?? null,
  };
}
