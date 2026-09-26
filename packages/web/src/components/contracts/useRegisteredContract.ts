import type { Contract } from "@tripwire/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { describeAbi, type ContractSurface } from "../../lib/abi";
import { api } from "../../lib/api";

/** A registered contract, with what rules can use from its ABI. */
export interface LoadedContract extends Contract {
  surface: ContractSurface;
}

export function useRegisteredContract(address: string | null) {
  const query = useQuery({
    queryKey: ["contract", address],
    queryFn: ({ signal }) => api.contract(address!, signal),
    enabled: !!address,
  });
  const detail = query.data;
  const surface = useMemo(
    () => (detail ? describeAbi(detail.abi) : null),
    [detail],
  );
  const contract: LoadedContract | null =
    detail && surface ? { ...detail, surface } : null;
  return { contract, error: query.error };
}
