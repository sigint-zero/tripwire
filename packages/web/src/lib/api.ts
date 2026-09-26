import type {
  Contract,
  ContractAbi,
  ContractDetail,
  ContractRegistration,
  EngineInfo,
  Issue,
  Rule,
  RuleCheck,
  SavedRule,
  StoredRuleCheck,
} from "@tripwire/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
    readonly issues: Issue[] = [],
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(`/api/v1${path}`, {
    ...rest,
    ...(json === undefined
      ? {}
      : {
          method: rest.method ?? "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(json),
        }),
  });
  const body = (await res.json().catch(() => null)) as
    (T & { message?: string; code?: string; issues?: Issue[] }) | null;
  if (!res.ok) {
    throw new ApiError(
      body?.message ?? `Request failed (${res.status})`,
      res.status,
      body?.code,
      body?.issues,
    );
  }
  return body as T;
}

export const api = {
  engine: (signal?: AbortSignal) => request<EngineInfo>("/engine", { signal }),
  abi: (address: string, signal?: AbortSignal) =>
    request<ContractAbi>(`/contracts/${address}/abi`, { signal }),
  contracts: (signal?: AbortSignal) =>
    request<Contract[]>("/contracts", { signal }),
  contract: (address: string, signal?: AbortSignal) =>
    request<ContractDetail>(`/contracts/${address}`, { signal }),
  registerContract: (registration: ContractRegistration) =>
    request<ContractDetail>("/contracts", { json: registration }),
  setContractActive: (address: string, active: boolean) =>
    request<ContractDetail>(
      `/contracts/${address}/${active ? "enable" : "disable"}`,
      { method: "POST" },
    ),
  rules: (contract?: string, signal?: AbortSignal) =>
    request<SavedRule[]>(contract ? `/rules?contract=${contract}` : "/rules", {
      signal,
    }),
  checkRule: (rule: Rule, signal?: AbortSignal) =>
    request<RuleCheck>("/rules", { json: { rule, checkOnly: true }, signal }),
  createRule: (rule: Rule) =>
    request<StoredRuleCheck>("/rules", { json: { rule } }),
};
