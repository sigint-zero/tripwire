import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { PageHeader } from "../components/PageHeader";
import {
  Button,
  choice,
  fieldClass,
  labelClass,
  Tag,
  track,
} from "../components/ui";
import { auth } from "../lib/api";
import { timeAgo } from "../lib/format";

const heading =
  "mb-4 text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase";

export function SettingsPage() {
  return (
    <div>
      <PageHeader
        title="Settings"
        description="Your account, who else can log in, and the AI agents that can reach Tripwire."
      />
      <div className="space-y-14">
        <Account />
        <Accounts />
        <AgentTokens />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className={heading}>{title}</h2>
      {children}
    </section>
  );
}

function Row({ children }: { children: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-4 bg-white/3 px-5 py-3.5">
      {children}
    </li>
  );
}

/** Who is logged in, their sessions, and their password. */
function Account() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: session } = useQuery({
    queryKey: ["auth", "session"],
    queryFn: ({ signal }) => auth.session(signal),
  });
  const { data: sessions } = useQuery({
    queryKey: ["auth", "sessions"],
    queryFn: ({ signal }) => auth.sessions(signal),
  });
  const logout = useMutation({
    mutationFn: auth.logout,
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ to: "/login" });
    },
  });
  const revoke = useMutation({
    mutationFn: auth.revokeSession,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["auth", "sessions"] }),
  });

  return (
    <Section title="Your account">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 bg-white/3 px-5 py-4">
        <p className="text-sm text-gray-300">
          Logged in as{" "}
          <span className="font-mono text-white">{session?.user.username}</span>
          {session && (
            <span
              className="text-gray-500"
              title="Sessions last a day from login"
            >
              {" "}
              · until{" "}
              {new Date(session.expiresAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          )}
        </p>
        <Button
          variant="ghost"
          disabled={logout.isPending}
          onClick={() => logout.mutate()}
        >
          Log out
        </Button>
      </div>

      <ul className="mb-8 space-y-2">
        {sessions?.map((s) => (
          <Row key={s.id}>
            <span className="min-w-0 text-sm">
              <span className="text-gray-300">
                {s.userAgent ? browserOf(s.userAgent) : "Unknown client"}
              </span>
              <span className="font-mono text-xs text-gray-500">
                {" "}
                · {s.address} · {timeAgo(s.lastSeenAt)}
              </span>
            </span>
            {s.current ? (
              <Tag tone="text-emerald-400">This one</Tag>
            ) : (
              <Button
                variant="ghost"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(s.id)}
              >
                End
              </Button>
            )}
          </Row>
        ))}
      </ul>

      <PasswordForm />
    </Section>
  );
}

/** A browser's name from its user agent, roughly. */
function browserOf(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : userAgent.split(/[ /]/)[0] || "Unknown client";
  const system = /Windows/.test(userAgent)
    ? "Windows"
    : /Mac OS X/.test(userAgent)
      ? "macOS"
      : /Android/.test(userAgent)
        ? "Android"
        : /iPhone|iPad/.test(userAgent)
          ? "iOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "";
  return system ? `${browser} on ${system}` : browser;
}

function PasswordForm() {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm !== "" && confirm !== next;
  const change = useMutation({
    mutationFn: () => auth.changePassword(current, next),
    onSuccess: async () => {
      setCurrent("");
      setNext("");
      setConfirm("");
      await queryClient.invalidateQueries({ queryKey: ["auth"] });
    },
  });
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!mismatch) change.mutate();
      }}
    >
      <label className="w-56">
        <span className={labelClass}>Current password</span>
        <input
          className={fieldClass}
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      <label className="w-56">
        <span className={labelClass}>New password</span>
        <input
          className={fieldClass}
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
          minLength={12}
          placeholder="12 characters or more"
          required
        />
      </label>
      <label className="w-56">
        <span className={labelClass}>Confirm new password</span>
        <input
          className={fieldClass}
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
        />
      </label>
      <Button
        type="submit"
        variant="ghost"
        disabled={mismatch || change.isPending}
        title="Ends your other sessions"
      >
        Change password
      </Button>
      {mismatch && (
        <p className="w-full text-xs text-amber-400">
          The passwords do not match.
        </p>
      )}
      {change.isSuccess && (
        <p className="w-full text-xs text-emerald-400">
          Changed. Your other sessions have ended.
        </p>
      )}
      {change.error && (
        <p className="w-full text-xs text-red-400">{change.error.message}</p>
      )}
    </form>
  );
}

/** Everyone who can log in; all accounts are equal. */
function Accounts() {
  const queryClient = useQueryClient();
  const { data: session } = useQuery({
    queryKey: ["auth", "session"],
    queryFn: ({ signal }) => auth.session(signal),
  });
  const { data: users } = useQuery({
    queryKey: ["auth", "users"],
    queryFn: ({ signal }) => auth.users(signal),
  });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm !== "" && confirm !== password;
  const [removing, setRemoving] = useState<string | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["auth", "users"] });
  const add = useMutation({
    mutationFn: () => auth.addUser(username, password),
    onSuccess: async () => {
      setUsername("");
      setPassword("");
      setConfirm("");
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: auth.removeUser,
    onSuccess: async () => {
      setRemoving(null);
      await refresh();
    },
  });

  return (
    <Section title="Accounts">
      <ul className="mb-6 space-y-2">
        {users?.map((u) => (
          <Row key={u.id}>
            <span className="text-sm">
              <span className="font-mono text-white">{u.username}</span>
              <span className="text-xs text-gray-500">
                {" "}
                · added {timeAgo(u.createdAt)}
              </span>
            </span>
            {u.id === session?.user.id ? (
              <Tag tone="text-emerald-400">You</Tag>
            ) : removing === u.id ? (
              <span className="flex gap-2">
                <Button
                  variant="ghost"
                  className="hover:border-red-500/40! hover:text-red-400!"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(u.id)}
                  title="Ends its sessions and revokes its MCP tokens"
                >
                  Remove it
                </Button>
                <Button variant="ghost" onClick={() => setRemoving(null)}>
                  Keep
                </Button>
              </span>
            ) : (
              <Button
                variant="ghost"
                disabled={users.length === 1}
                onClick={() => setRemoving(u.id)}
              >
                Remove
              </Button>
            )}
          </Row>
        ))}
      </ul>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!mismatch) add.mutate();
        }}
      >
        <label className="w-56">
          <span className={labelClass}>Username</span>
          <input
            className={fieldClass}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
            required
          />
        </label>
        <label className="w-56">
          <span className={labelClass}>Password</span>
          <input
            className={fieldClass}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={12}
            placeholder="12 characters or more"
            required
          />
        </label>
        <label className="w-56">
          <span className={labelClass}>Confirm password</span>
          <input
            className={fieldClass}
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        <Button
          type="submit"
          variant="ghost"
          disabled={mismatch || add.isPending}
        >
          Add account
        </Button>
        {mismatch && (
          <p className="w-full text-xs text-amber-400">
            The passwords do not match.
          </p>
        )}
        {(add.error ?? remove.error) && (
          <p className="w-full text-xs text-red-400">
            {(add.error ?? remove.error)!.message}
          </p>
        )}
      </form>
    </Section>
  );
}

const expiries = [
  { label: "Never", days: null },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
];

/** MCP tokens: each AI agent's whole identity, shown once when minted. */
function AgentTokens() {
  const queryClient = useQueryClient();
  const { data: tokens } = useQuery({
    queryKey: ["auth", "tokens"],
    queryFn: ({ signal }) => auth.tokens(signal),
  });
  const [label, setLabel] = useState("");
  const [days, setDays] = useState<number | null>(null);
  const [minted, setMinted] = useState<{ label: string; token: string } | null>(
    null,
  );
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["auth", "tokens"] });
  const create = useMutation({
    mutationFn: () =>
      auth.createToken(
        label,
        days ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
      ),
    onSuccess: async ({ token }) => {
      setMinted({ label, token });
      setLabel("");
      await refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: auth.revokeToken,
    onSuccess: refresh,
  });

  return (
    <Section title="AI agents">
      {minted && (
        <TokenOnce
          label={minted.label}
          token={minted.token}
          onDone={() => setMinted(null)}
        />
      )}
      <ul className="mb-6 space-y-2">
        {tokens?.length === 0 && (
          <li className="bg-white/2 px-5 py-4 text-sm text-gray-500">
            No agent can reach Tripwire yet.
          </li>
        )}
        {tokens?.map((t) => (
          <Row key={t.id}>
            <span className="min-w-0 text-sm">
              <span className="text-white">{t.label}</span>
              <span className="text-xs text-gray-500">
                {" "}
                · {t.owner
                  ? `by ${t.owner.username}`
                  : "from the command line"}{" "}
                ·{" "}
                {t.lastUsedAt ? `used ${timeAgo(t.lastUsedAt)}` : "never used"}
                {t.expiresAt &&
                  ` · until ${new Date(t.expiresAt).toLocaleDateString()}`}
              </span>
            </span>
            <Button
              variant="ghost"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(t.id)}
              title="The agent is refused from its next request"
            >
              Revoke
            </Button>
          </Row>
        ))}
      </ul>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label className="w-64">
          <span className={labelClass}>Agent</span>
          <input
            className={fieldClass}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Claude Code on my laptop"
            maxLength={64}
            required
          />
        </label>
        <div>
          <span className={labelClass}>Expires</span>
          <div className={track}>
            {expiries.map((e) => (
              <button
                key={e.label}
                type="button"
                className={choice(days === e.days)}
                onClick={() => setDays(e.days)}
              >
                {e.label}
              </button>
            ))}
          </div>
        </div>
        <Button
          type="submit"
          disabled={create.isPending}
          title="Agents propose rules; they land switched off for you to review"
        >
          Create token
        </Button>
        {create.error && (
          <p className="w-full text-xs text-red-400">{create.error.message}</p>
        )}
      </form>
    </Section>
  );
}

/** A new token, the only time it is shown, with how to use it. */
function TokenOnce({
  label,
  token,
  onDone,
}: {
  label: string;
  token: string;
  onDone: () => void;
}) {
  const url = `${window.location.origin}/mcp`;
  const [copied, setCopied] = useState<string | null>(null);
  const snippets = [
    {
      name: "Claude Code",
      text: `claude mcp add --transport http tripwire ${url} --header "Authorization: Bearer ${token}"`,
    },
    {
      name: "Other agents",
      text: JSON.stringify(
        {
          mcpServers: {
            tripwire: {
              type: "http",
              url,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        },
        null,
        2,
      ),
    },
  ];
  const copy = async (name: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(name);
  };
  return (
    <div className="mb-6 space-y-4 bg-emerald-500/6 px-5 py-5">
      <p className="text-sm text-emerald-300">
        Token for “{label}”. Copy it now: it is not shown again.
      </p>
      {snippets.map((s) => (
        <div key={s.name}>
          <div className="mb-1.5 flex items-center justify-between">
            <span className={labelClass}>{s.name}</span>
            <button
              type="button"
              onClick={() => void copy(s.name, s.text)}
              className="cursor-pointer text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-emerald-400"
            >
              {copied === s.name ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="scrollbar-subtle overflow-x-auto bg-black/40 p-3 font-mono text-xs text-emerald-300">
            {s.text}
          </pre>
        </div>
      ))}
      <Button variant="ghost" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
