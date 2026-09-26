import type {
  AccountSession,
  Channel,
  ChannelDelivery,
  ChannelInput,
  ChannelTest,
  NotificationKind,
  NotificationPage,
  NotificationSettings,
  AccountSummary,
  Contract,
  ContractAbi,
  ContractDetail,
  ContractRegistration,
  EngineStatus,
  Issue,
  KeyList,
  ManualAction,
  ManualActionItem,
  Readiness,
  ResponseTest,
  McpTokenSummary,
  NewKey,
  CheckNow,
  CurrentValue,
  ResponseCounts,
  ResponseItem,
  ResponseTab,
  Rule,
  RuleChange,
  RuleSeries,
  SeriesWindow,
  SetupState,
  Severity,
  Sparkline,
  TripStateItem,
  RuleCheck,
  SavedRule,
  SessionSummary,
  StoredRuleCheck,
  Violation,
  ViolationKind,
} from "@tripwire/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
    readonly issues: Issue[] = [],
    /** The whole refusal, for the fields some refusals carry. */
    readonly body: Record<string, unknown> = {},
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
      body ?? {},
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
  engine: (signal?: AbortSignal) =>
    request<EngineStatus>("/engine", { signal }),
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
  ruleSeries: (id: string, signal?: AbortSignal) =>
    request<RuleSeries[]>(`/rules/${id}/series`, { signal }),
  ruleCurrent: (id: string, signal?: AbortSignal) =>
    request<CurrentValue[]>(`/rules/${id}/current`, { signal }),
  checkNow: (id: string) =>
    request<CheckNow>(`/rules/${id}/check`, { method: "POST" }),
  seriesWindow: (
    id: string,
    window: { from: string; to: string; points?: number },
    signal?: AbortSignal,
  ) =>
    request<SeriesWindow>(
      `/series/${id}/points?${new URLSearchParams({
        from: window.from,
        to: window.to,
        ...(window.points ? { points: String(window.points) } : {}),
      }).toString()}`,
      { signal },
    ),
  sparklines: (ruleIds: string[], signal?: AbortSignal) =>
    request<Sparkline[]>(`/sparklines?rules=${ruleIds.join(",")}`, { signal }),
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
      kind?: ViolationKind;
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
  responses: (tab: ResponseTab, signal?: AbortSignal) =>
    request<ResponseItem[]>(`/responses?status=${tab}`, { signal }),
  notifications: (
    filter: {
      cursor?: string;
      kind?: NotificationKind;
      severity?: Severity;
      unread?: boolean;
    },
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    if (filter.cursor) query.set("cursor", filter.cursor);
    if (filter.kind) query.set("kind", filter.kind);
    if (filter.severity) query.set("severity", filter.severity);
    if (filter.unread) query.set("unread", "true");
    const qs = query.toString();
    return request<NotificationPage>(`/notifications${qs ? `?${qs}` : ""}`, {
      signal,
    });
  },
  unreadCount: (signal?: AbortSignal) =>
    request<{ count: number }>("/notifications/unread-count", { signal }),
  markRead: (read: { ids: string[] } | { all: true }) =>
    request<{ count: number }>("/notifications/read", { json: read }),
  notificationSettings: (signal?: AbortSignal) =>
    request<NotificationSettings>("/notification-settings", { signal }),
  setNotificationSettings: (settings: NotificationSettings) =>
    request<NotificationSettings>("/notification-settings", {
      method: "PUT",
      json: settings,
    }),
  channels: (signal?: AbortSignal) =>
    request<Channel[]>("/channels", { signal }),
  createChannel: (channel: ChannelInput) =>
    request<Channel & { signingKey?: string }>("/channels", { json: channel }),
  updateChannel: (id: string, channel: ChannelInput) =>
    request<Channel>(`/channels/${id}`, { method: "PUT", json: channel }),
  deleteChannel: (id: string) =>
    request<{ dropped: number }>(`/channels/${id}`, { method: "DELETE" }),
  testChannel: (id: string) =>
    request<ChannelTest>(`/channels/${id}/test`, { method: "POST" }),
  channelDeliveries: (id: string, signal?: AbortSignal) =>
    request<{ items: ChannelDelivery[]; nextCursor: string | null }>(
      `/channels/${id}/deliveries`,
      { signal },
    ),
  tripState: (signal?: AbortSignal) =>
    request<TripStateItem[]>("/trip-state", { signal }),
  setup: (signal?: AbortSignal) => request<SetupState>("/setup", { signal }),
  dismissSetup: () =>
    request<{ dismissed: true }>("/setup/dismiss", { method: "POST" }),
  responseCounts: (signal?: AbortSignal) =>
    request<ResponseCounts>("/responses/counts", { signal }),
  response: (id: string, signal?: AbortSignal) =>
    request<ResponseItem>(`/responses/${id}`, { signal }),
  approveResponse: (id: string) =>
    request<ResponseItem>(`/responses/${id}/approve`, { method: "POST" }),
  rejectResponse: (id: string, reason: string) =>
    request<ResponseItem>(`/responses/${id}/reject`, {
      json: { reason: reason || undefined },
    }),
  readiness: (contract: string, signal?: AbortSignal) =>
    request<Readiness[]>(`/readiness?contract=${contract}`, { signal }).then(
      (all) => all[0] ?? null,
    ),
  testResponse: (ruleId: string) =>
    request<ResponseTest>(`/readiness/${ruleId}/test`, { method: "POST" }),
  /** Sent through the engine from the signing key. */
  contractAction: (address: string, action: ManualAction) =>
    request<ManualActionItem>(`/contracts/${address}/actions`, {
      json: action,
    }),
  keys: (signal?: AbortSignal) => request<KeyList>("/keys", { signal }),
  createKey: (passphrase: string) =>
    request<NewKey>("/keys", { json: { passphrase } }),
  importKey: (keystore: string, passphrase: string) =>
    request<NewKey>("/keys/import", { json: { keystore, passphrase } }),
  unlockKey: (address: string, passphrase: string) =>
    request<{ address: string; unlocked: boolean }>(`/keys/${address}/unlock`, {
      json: { passphrase },
    }),
  lockKey: (address: string) =>
    request<{ address: string; unlocked: boolean }>(`/keys/${address}/lock`, {
      method: "POST",
    }),
};
