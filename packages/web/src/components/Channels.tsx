import {
  channelFields,
  channelTypes,
  defaultKinds,
  notificationKinds,
  type Channel,
  type ChannelInput,
  type ChannelTest,
  type ChannelType,
  type NotificationKind,
  type Severity,
} from "@tripwire/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  Button,
  choice,
  fieldClass,
  labelClass,
  Plus,
  Switch,
  Tag,
  track,
} from "./ui";

const typeNames: Record<ChannelType, string> = {
  webhook: "Webhook",
  slack: "Slack",
  discord: "Discord",
  telegram: "Telegram",
  email: "Email",
};

const kindNames: Record<NotificationKind, { title: string; hint: string }> = {
  violation: { title: "Violations", hint: "A rule tripped" },
  evaluation_error: {
    title: "Errors",
    hint: "A rule could not be evaluated; repeats every block until fixed",
  },
  response: {
    title: "Responses",
    hint: "An on-chain response waits, lands or fails",
  },
  health: { title: "Engine", hint: "The engine falls behind or recovers" },
  system: {
    title: "Tripwire",
    hint: "Tripwire itself: its engine and channels",
  },
};

const severities: { severity: Severity; title: string }[] = [
  { severity: "info", title: "Info and up" },
  { severity: "warning", title: "Warning and up" },
  { severity: "critical", title: "Critical only" },
];

const quietLink =
  "cursor-pointer text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-gray-200";

/** Where alerts go beyond the dashboard, and how each is doing. */
export function AlertChannels() {
  const queryClient = useQueryClient();
  const { data: channels } = useQuery({
    queryKey: ["channels"],
    queryFn: ({ signal }) => api.channels(signal),
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["channels"] });
  const [editing, setEditing] = useState<Channel | "new" | null>(null);
  const [signingKey, setSigningKey] = useState<{
    name: string;
    key: string;
  } | null>(null);
  const [deleting, setDeleting] = useState<Channel | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteChannel(id),
    onSuccess: async () => {
      setDeleting(null);
      await refresh();
    },
  });

  return (
    <div>
      {signingKey && (
        <div className="mb-6 space-y-3 bg-emerald-500/6 px-5 py-5">
          <p className="text-sm text-emerald-300">
            Signing key for “{signingKey.name}”. Your receiver checks each
            message with it. Copy it now: it is not shown again.
          </p>
          <pre className="scrollbar-subtle overflow-x-auto bg-black/40 p-3 font-mono text-xs text-emerald-300">
            {signingKey.key}
          </pre>
          <Button variant="ghost" onClick={() => setSigningKey(null)}>
            Done
          </Button>
        </div>
      )}

      <ul className="mb-6 space-y-2">
        {channels?.length === 0 && editing !== "new" && (
          <li className="bg-white/2 px-5 py-4 text-sm text-gray-500">
            No channels yet. The Notifications page keeps every alert without
            one.
          </li>
        )}
        {channels?.map((c) =>
          editing !== "new" && editing?.id === c.id ? (
            <li key={c.id}>
              <ChannelForm
                existing={c}
                onDone={() => {
                  setEditing(null);
                  void refresh();
                }}
              />
            </li>
          ) : (
            <ChannelRow
              key={c.id}
              channel={c}
              onEdit={() => setEditing(c)}
              onDelete={() => setDeleting(c)}
            />
          ),
        )}
      </ul>

      {editing === "new" ? (
        <ChannelForm
          onDone={(created) => {
            setEditing(null);
            if (created?.signingKey) {
              setSigningKey({ name: created.name, key: created.signingKey });
            }
            void refresh();
          }}
        />
      ) : (
        <Button onClick={() => setEditing("new")}>
          <Plus />
          Add channel
        </Button>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this channel?"
        confirm="Delete channel"
        pending={remove.isPending}
        error={remove.error?.message}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        onClose={() => {
          setDeleting(null);
          remove.reset();
        }}
      >
        <span className="text-white">{deleting?.name}</span> stops receiving
        alerts
        {deleting && deleting.state.backlog > 0
          ? `, and the ${deleting.state.backlog} it has not received yet are dropped`
          : ""}
        . The Notifications page keeps them all.
      </ConfirmDialog>
    </div>
  );
}

function ChannelRow({
  channel,
  onEdit,
  onDelete,
}: {
  channel: Channel;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const queryClient = useQueryClient();
  const [log, setLog] = useState(false);
  const [tested, setTested] = useState<ChannelTest | null>(null);
  const test = useMutation({
    mutationFn: () => api.testChannel(channel.id),
    onSuccess: setTested,
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api.updateChannel(channel.id, { ...inputOf(channel), enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["channels"] }),
  });
  const { state } = channel;
  const failing = state.failingSince !== null;

  return (
    <li className="bg-white/3">
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-3.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span
            aria-hidden
            className={`size-1.5 shrink-0 ${!channel.enabled ? "bg-gray-600" : failing ? "bg-red-400" : "bg-emerald-400"}`}
          />
          <span className="text-white">{channel.name}</span>
          <Tag>{typeNames[channel.type]}</Tag>
          {failing && (
            <span
              className="text-xs text-red-400"
              title={state.lastError ?? undefined}
            >
              Failing since {timeAgo(state.failingSince!)}
            </span>
          )}
          {state.backlog > 0 && (
            <span
              className="font-mono text-xs text-gray-500"
              title={
                state.oldestPendingAt
                  ? `Oldest waiting since ${new Date(state.oldestPendingAt).toLocaleString()}`
                  : undefined
              }
            >
              {state.backlog} waiting
            </span>
          )}
          {!failing && state.lastDeliveredAt && (
            <span className="text-xs text-gray-500">
              last sent {timeAgo(state.lastDeliveredAt)}
            </span>
          )}
        </span>
        <span className="flex flex-wrap items-center gap-4">
          {tested && (
            <span
              className={`max-w-64 truncate text-xs ${tested.delivered ? "text-emerald-400" : "text-red-400"}`}
              title={tested.error ?? undefined}
            >
              {tested.delivered ? "Test sent" : tested.error}
            </span>
          )}
          <button
            type="button"
            className={quietLink}
            disabled={test.isPending}
            onClick={() => {
              setTested(null);
              test.mutate();
            }}
          >
            {test.isPending ? "Sending…" : "Send a test"}
          </button>
          <button
            type="button"
            className={quietLink}
            aria-expanded={log}
            onClick={() => setLog(!log)}
          >
            Log
          </button>
          <button type="button" className={quietLink} onClick={onEdit}>
            Edit
          </button>
          <Switch
            on={channel.enabled}
            label={channel.enabled ? "On" : "Off"}
            disabled={toggle.isPending}
            title={
              channel.enabled
                ? "Turn off: it keeps what it has not received for when it is back on"
                : "Turn on"
            }
            onChange={(on) => toggle.mutate(on)}
          />
          <Button variant="danger" onClick={onDelete}>
            Delete
          </Button>
        </span>
      </div>
      {log && <DeliveryLog channelId={channel.id} />}
    </li>
  );
}

function DeliveryLog({ channelId }: { channelId: string }) {
  const { data } = useQuery({
    queryKey: ["channels", channelId, "deliveries"],
    queryFn: ({ signal }) => api.channelDeliveries(channelId, signal),
  });
  if (!data) return null;
  if (data.items.length === 0) {
    return <p className="px-5 pb-4 text-xs text-gray-500">Nothing sent yet.</p>;
  }
  return (
    <ul className="space-y-1 px-5 pb-4 font-mono text-xs">
      {data.items.map((d) => (
        <li key={d.id} className="flex items-baseline gap-4">
          <span className="w-16 shrink-0 text-gray-500">
            {timeAgo(d.createdAt)}
          </span>
          <span className="min-w-0 flex-1 truncate text-gray-300">
            {d.title ?? d.notificationId}
          </span>
          <span
            className={`shrink-0 ${d.deliveredAt ? "text-gray-500" : d.lastError ? "text-red-400" : "text-gray-400"}`}
            title={d.lastError ?? undefined}
          >
            {d.deliveredAt
              ? d.digestId
                ? "in a digest"
                : "sent"
              : d.attempts > 0
                ? `failed ×${d.attempts}, retrying`
                : "waiting"}
          </span>
        </li>
      ))}
    </ul>
  );
}

function inputOf(channel: Channel): ChannelInput {
  return {
    name: channel.name,
    type: channel.type,
    enabled: channel.enabled,
    kinds: channel.kinds,
    minSeverity: channel.minSeverity,
    stormLimit: channel.stormLimit,
    settings: channel.settings,
    secrets: {},
  };
}

function ChannelForm({
  existing,
  onDone,
}: {
  existing?: Channel;
  onDone: (created?: Channel & { signingKey?: string }) => void;
}) {
  const [type, setType] = useState<ChannelType>(existing?.type ?? "slack");
  const [name, setName] = useState(existing?.name ?? "");
  const [kinds, setKinds] = useState<NotificationKind[]>(
    existing?.kinds ?? defaultKinds,
  );
  const [minSeverity, setMinSeverity] = useState<Severity>(
    existing?.minSeverity ?? "info",
  );
  const [stormLimit, setStormLimit] = useState<string>(
    existing ? String(existing.stormLimit) : "",
  );
  const [values, setValues] = useState<Record<string, string>>(
    existing?.settings ?? {},
  );
  const fields = channelFields[type];
  const save = useMutation({
    mutationFn: () => {
      const input: ChannelInput = {
        name: name.trim(),
        type,
        enabled: existing?.enabled ?? true,
        kinds,
        minSeverity,
        // Left empty, the type's default: every message for a webhook, ten a minute for people.
        stormLimit:
          stormLimit === ""
            ? type === "webhook"
              ? 0
              : 10
            : Number(stormLimit),
        settings: Object.fromEntries(
          fields
            .filter((f) => !f.secret && values[f.key]?.trim())
            .map((f) => [f.key, values[f.key]!.trim()]),
        ),
        secrets: Object.fromEntries(
          fields
            .filter((f) => f.secret && values[f.key]?.trim())
            .map((f) => [f.key, values[f.key]!.trim()]),
        ),
      };
      return existing
        ? api.updateChannel(existing.id, input)
        : api.createChannel(input);
    },
    onSuccess: (saved) => onDone(existing ? undefined : saved),
  });
  const toggleKind = (kind: NotificationKind) =>
    setKinds(
      kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind],
    );

  return (
    <form
      className="space-y-5 bg-white/3 px-5 py-5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {!existing && (
        <div>
          <span className={labelClass}>Type</span>
          <div className={`${track} flex-wrap`}>
            {channelTypes.map((t) => (
              <button
                key={t}
                type="button"
                className={choice(type === t)}
                onClick={() => {
                  setType(t);
                  setValues({});
                }}
              >
                {typeNames[t]}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <label>
          <span className={labelClass}>Name</span>
          <input
            className={fieldClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`${typeNames[type]} for on-call`}
            maxLength={60}
            required
          />
        </label>
        {fields.map((f) => {
          const set = existing?.secretsSet.includes(f.key);
          return (
            <label key={f.key}>
              <span className={labelClass}>
                {f.label}
                {!f.required && " (optional)"}
              </span>
              <input
                className={`${fieldClass} font-mono`}
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                value={values[f.key] ?? ""}
                onChange={(e) =>
                  setValues({ ...values, [f.key]: e.target.value })
                }
                placeholder={
                  f.secret && set
                    ? "Set. Leave empty to keep it"
                    : (f.placeholder ?? (f.secret ? "or env:NAME" : undefined))
                }
                required={f.required && !(f.secret && set)}
                title={
                  f.secret
                    ? "Kept in a file only the server can read, never in the database. env:NAME reads it from the server's environment."
                    : undefined
                }
              />
            </label>
          );
        })}
      </div>

      <div>
        <span className={labelClass}>Sends</span>
        <div className={`${track} flex-wrap`}>
          {notificationKinds.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kinds.includes(k)}
              title={kindNames[k].hint}
              className={choice(kinds.includes(k))}
              onClick={() => toggleKind(k)}
            >
              {kindNames[k].title}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-6">
        <div>
          <span className={labelClass}>Severity</span>
          <div className={track}>
            {severities.map((s) => (
              <button
                key={s.severity}
                type="button"
                className={choice(minSeverity === s.severity)}
                onClick={() => setMinSeverity(s.severity)}
              >
                {s.title}
              </button>
            ))}
          </div>
        </div>
        <label className="w-40">
          <span className={labelClass}>Digest after</span>
          <input
            className={`${fieldClass} font-mono`}
            inputMode="numeric"
            value={stormLimit}
            onChange={(e) => setStormLimit(e.target.value.replace(/\D/g, ""))}
            placeholder={type === "webhook" ? "0" : "10"}
            title="Messages a minute before the rest of that minute comes as one digest. 0 sends every message."
          />
        </label>
      </div>

      {save.error && (
        <p className="text-xs text-red-400">{save.error.message}</p>
      )}
      <div className="flex gap-3">
        <Button type="submit" disabled={save.isPending || kinds.length === 0}>
          {existing ? (
            "Save"
          ) : (
            <>
              <Plus />
              Add channel
            </>
          )}
        </Button>
        <Button variant="quiet" onClick={() => onDone()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Where messages link to, and the heartbeat that covers a dead machine. */
export function MessageLinks() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["notification-settings"],
    queryFn: ({ signal }) => api.notificationSettings(signal),
  });
  const [draft, setDraft] = useState<{
    dashboardUrl: string;
    heartbeatUrl: string;
  } | null>(null);
  const shown = draft ?? {
    dashboardUrl: data?.dashboardUrl ?? "",
    heartbeatUrl: data?.heartbeatUrl ?? "",
  };
  const save = useMutation({
    mutationFn: () =>
      api.setNotificationSettings({
        dashboardUrl: shown.dashboardUrl.trim() || null,
        heartbeatUrl: shown.heartbeatUrl.trim() || null,
      }),
    onSuccess: async () => {
      setDraft(null);
      await queryClient.invalidateQueries({
        queryKey: ["notification-settings"],
      });
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label>
          <span className={labelClass}>Dashboard address</span>
          <input
            className={`${fieldClass} font-mono`}
            value={shown.dashboardUrl}
            onChange={(e) =>
              setDraft({ ...shown, dashboardUrl: e.target.value })
            }
            placeholder="https://tripwire.example"
            spellCheck={false}
          />
          <span className="mt-1.5 block text-xs text-gray-500">
            {data?.dashboardUrl
              ? "Messages link to the page that shows what happened."
              : "Messages carry no link until this is set."}
          </span>
        </label>
        <label>
          <span className={labelClass}>Heartbeat (optional)</span>
          <input
            className={`${fieldClass} font-mono`}
            value={shown.heartbeatUrl}
            onChange={(e) =>
              setDraft({ ...shown, heartbeatUrl: e.target.value })
            }
            placeholder="https://hc-ping.com/…"
            spellCheck={false}
          />
          <span className="mt-1.5 block text-xs text-gray-500">
            Requested every minute while the engine is watching. Point it at a
            dead-man&apos;s switch to hear when this machine goes quiet.
          </span>
        </label>
      </div>
      {save.error && (
        <p className="text-xs text-red-400">{save.error.message}</p>
      )}
      {draft && (
        <div className="flex gap-3">
          <Button type="submit" disabled={save.isPending}>
            Save
          </Button>
          <Button variant="quiet" onClick={() => setDraft(null)}>
            Cancel
          </Button>
        </div>
      )}
    </form>
  );
}
