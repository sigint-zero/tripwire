import type {
  AccountSession,
  AccountSummary,
  Contract,
  ContractAbi,
  ContractDetail,
  ContractRegistration,
  EngineInfo,
  Issue,
  McpTokenSummary,
  Rule,
  RuleChange,
  RuleCheck,
  SavedRule,
  SessionSummary,
  StoredRuleCheck,
  Violation,
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

/** A request refused because nobody is logged in. */
export const isLoggedOut = (error: unknown) =>
  error instanceof ApiError &&
  error.status === 401 &&
  error.code === "unauthenticated";

export const auth = {
  setup: (signal?: AbortSignal) =>
    request<{ required: boolean }>("/auth/setup", { signal }),
  createFirstAccount: (username: string, password: string) =>
    request<{ user: { id: string; username: string } }>("/auth/setup", {
      json: { username, password },
    }),
  login: (username: string, password: string) =>
    request<null>("/auth/login", { json: { username, password } }),
  logout: () => request<null>("/auth/logout", { method: "POST" }),
  session: (signal?: AbortSignal) =>
    request<AccountSession>("/auth/session", { signal }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<null>("/auth/password", {
      json: { currentPassword, newPassword },
    }),
  sessions: (signal?: AbortSignal) =>
    request<SessionSummary[]>("/auth/sessions", { signal }),
  revokeSession: (id: string) =>
    request<null>(`/auth/sessions/${id}`, { method: "DELETE" }),
  users: (signal?: AbortSignal) =>
    request<AccountSummary[]>("/auth/users", { signal }),
  addUser: (username: string, password: string) =>
    request<AccountSummary>("/auth/users", { json: { username, password } }),
  removeUser: (id: string) =>
    request<null>(`/auth/users/${id}`, { method: "DELETE" }),
  tokens: (signal?: AbortSignal) =>
    request<McpTokenSummary[]>("/auth/mcp-tokens", { signal }),
  createToken: (label: string, expiresAt: string | null) =>
    request<{ id: string; token: string }>("/auth/mcp-tokens", {
      json: { label, expiresAt },
    }),
  revokeToken: (id: string) =>
    request<null>(`/auth/mcp-tokens/${id}`, { method: "DELETE" }),
};

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
  renameContract: (address: string, name: string) =>
    request<ContractDetail>(`/contracts/${address}`, {
      method: "PATCH",
      json: { name },
    }),
  deleteContract: (address: string) =>
    request<null>(`/contracts/${address}`, { method: "DELETE" }),
  createRule: (rule: Rule) =>
    request<StoredRuleCheck>("/rules", { json: { rule } }),
  rule: (id: string, signal?: AbortSignal) =>
    request<SavedRule>(`/rules/${id}`, { signal }),
  checkReplacement: (id: string, rule: Rule, signal?: AbortSignal) =>
    request<RuleCheck>(`/rules/${id}`, {
      method: "PUT",
      json: { rule, checkOnly: true },
      signal,
    }),
  replaceRule: (id: string, rule: Rule) =>
    request<StoredRuleCheck>(`/rules/${id}`, {
      method: "PUT",
      json: { rule },
    }),
  changeRule: (id: string, change: RuleChange) =>
    request<SavedRule>(`/rules/${id}`, { method: "PATCH", json: change }),
  deleteRule: (id: string) =>
    request<null>(`/rules/${id}`, { method: "DELETE" }),
  pinnedRules: (signal?: AbortSignal) =>
    request<string[]>("/pinned-rules", { signal }),
  pinRules: (ruleIds: string[]) =>
    request<string[]>("/pinned-rules", { method: "PUT", json: { ruleIds } }),
  violations: (
    filter: {
      rule?: string;
      contract?: string;
      open?: boolean;
      before?: string;
      limit?: number;
    } = {},
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams(
      Object.entries(filter)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    return request<Violation[]>(`/violations${query ? `?${query}` : ""}`, {
      signal,
    });
  },
  violation: (id: string, signal?: AbortSignal) =>
    request<Violation>(`/violations/${id}`, { signal }),
  acknowledge: (ids: string[], note?: string) =>
    request<Violation[]>("/violations/acknowledge", { json: { ids, note } }),
};
