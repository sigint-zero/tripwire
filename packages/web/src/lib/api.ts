import type {
  ContractAbi,
  Invariant,
  InvariantDraft,
  Rule,
  RulePreview,
} from "@tripwire/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: { path: string; message: string }[] = [],
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
    (T & { message?: string; issues?: ApiError["issues"] }) | null;
  if (!res.ok) {
    throw new ApiError(
      body?.message ?? `Request failed (${res.status})`,
      res.status,
      body?.issues,
    );
  }
  return body as T;
}

export const api = {
  abi: (chainId: number, address: string, signal?: AbortSignal) =>
    request<ContractAbi>(`/contracts/${chainId}/${address}/abi`, { signal }),
  preview: (rule: Rule, signal?: AbortSignal) =>
    request<RulePreview>("/invariants/preview", { json: rule, signal }),
  invariants: (signal?: AbortSignal) =>
    request<Invariant[]>("/invariants", { signal }),
  createInvariant: (draft: InvariantDraft) =>
    request<Invariant>("/invariants", { json: draft }),
};
