import { channelFields, type Severity } from "@tripwire/shared";
import type { EngineReads } from "../engine/types";
import type { EngineEvents, EngineListener } from "../events/types";
import { absolute, render } from "./render";
import type { ChannelSecrets } from "./secrets";
import { send as sendMessage, type Message, type Target } from "./send";
import type {
  ChannelRow,
  DeliveryRow,
  NoticeRow,
  NotificationStore,
} from "./store";

// Delivery (NOTIFICATIONS.md): dispatch turns each new notification into a
// delivery per matching channel; the worker sends what is due, retrying
// with backoff forever, and folds a storm into one digest a minute. It runs
// every five seconds, and at once when a notification arrives.

const TICK_MS = 5_000;
const CLAIM = 100;
/** How long a claimed delivery is held: longer than any send. */
const LEASE_SECONDS = 60;
const FIRST_RETRY_SECONDS = 30;
const LAST_RETRY_SECONDS = 3_600;
/** A channel whose oldest undelivered message is this old is failing, and says so elsewhere. */
const FAILING_AFTER_MS = 3_600_000;
const HEARTBEAT_MS = 60_000;

const rank: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export function matches(channel: ChannelRow, notice: NoticeRow): boolean {
  return (
    channel.kinds.includes(notice.kind) &&
    rank[notice.severity] >= rank[channel.min_severity]
  );
}

/** The wait before the next attempt: 30 s doubling to an hour, a tenth either way. */
export function retryDelayMs(attempts: number, random = Math.random): number {
  const seconds = Math.min(
    FIRST_RETRY_SECONDS * 2 ** Math.max(0, attempts - 1),
    LAST_RETRY_SECONDS,
  );
  return seconds * 1000 * (0.9 + random() * 0.2);
}

export interface WorkerOptions {
  store: NotificationStore;
  secrets: ChannelSecrets;
  reads: EngineReads;
  /** The engine's stream, whose `notification` events wake the worker. */
  events?: EngineEvents;
  /** Whether the engine is watching, for the heartbeat. */
  watching?: () => boolean;
  clock?: () => number;
  log?: (message: string, detail?: object) => void;
}

export class NotificationWorker implements EngineEvents {
  readonly #o: Required<Omit<WorkerOptions, "events">> &
    Pick<WorkerOptions, "events">;
  readonly #listeners = new Set<EngineListener>();
  /** Messages sent to each channel in the current minute. */
  readonly #sent = new Map<string, { minute: number; count: number }>();
  /** Deliveries held back by a storm, to go out as that channel's digest. */
  readonly #digest = new Set<string>();
  /** Channels known to be failing, and those already reported. */
  readonly #failing = new Set<string>();
  readonly #reported = new Set<string>();
  #lastHeartbeat = 0;
  #running: Promise<void> = Promise.resolve();
  #again = false;

  constructor(options: WorkerOptions) {
    this.#o = {
      watching: () => false,
      clock: Date.now,
      log: (message, detail) => console.warn(message, detail ?? ""),
      ...options,
    };
  }

  /** Runs until the returned function is called. */
  start(): () => Promise<void> {
    const timer = setInterval(() => this.wake(), TICK_MS);
    timer.unref();
    const unlisten = this.#o.events?.listen({
      event: (e) => {
        if (e.event === "notification") this.wake();
      },
      resync: () => this.wake(),
    });
    this.wake();
    return async () => {
      clearInterval(timer);
      unlisten?.();
      await this.#running;
    };
  }

  /** A pass now, or right after the one running. */
  wake() {
    this.#again = true;
    this.#running = this.#running.then(async () => {
      while (this.#again) {
        this.#again = false;
        await this.tick().catch((error: unknown) =>
          this.#o.log("Notification delivery failed a pass.", {
            error: String(error),
          }),
        );
      }
    });
  }

  /** One pass: dispatch, send what is due, watch the channels, beat. */
  async tick() {
    await this.dispatch();
    await this.deliver();
    await this.#watchChannels();
    await this.#heartbeat();
  }

  /** Raises one of the application's own notifications, and sends it. */
  async raise(
    severity: Severity,
    title: string,
    text: string,
    link = "/",
  ): Promise<void> {
    const id = await this.#o.store.raise("system", severity, {
      title,
      text,
      link,
    });
    this.#emit("notification", {
      id,
      source: "app",
      kind: "system",
      severity,
    });
    this.wake();
  }

  listen(listener: EngineListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: string, data: object) {
    for (const l of this.#listeners) l.event({ event, data });
  }

  async dispatch() {
    const channels = await this.#o.store.channels();
    for (;;) {
      const batch = await this.#o.store.undispatched(200);
      for (const notice of batch) {
        await this.#o.store.dispatch(
          notice,
          channels.filter((c) => matches(c, notice)).map((c) => c.id),
        );
      }
      if (batch.length < 200) return;
    }
  }

  async deliver() {
    const due = await this.#o.store.claimDue(CLAIM, LEASE_SECONDS);
    if (due.length === 0) return;
    const [channels, notices, names, urls] = await Promise.all([
      this.#o.store.channels(),
      this.#o.store.notices(
        due.map((d) => ({ source: d.source, id: d.notification_id })),
      ),
      this.#names(),
      this.#o.store.urls(),
    ]);
    const byKey = new Map(notices.map((n) => [`${n.source}:${n.id}`, n]));
    const byChannel = new Map<string, DeliveryRow[]>();
    for (const row of due) {
      byChannel.set(row.channel_id, [
        ...(byChannel.get(row.channel_id) ?? []),
        row,
      ]);
    }
    await Promise.all(
      [...byChannel].map(async ([channelId, rows]) => {
        const channel = channels.find((c) => c.id === channelId);
        if (!channel) return;
        const target = await this.#target(channel);
        const message = (row: DeliveryRow) => {
          const notice = byKey.get(`${row.source}:${row.notification_id}`);
          return notice ? toMessage(notice, names, urls.dashboard) : null;
        };
        await this.#deliverChannel(
          channel,
          target,
          rows,
          message,
          urls.dashboard,
          names,
          byKey,
        );
      }),
    );
  }

  async #deliverChannel(
    channel: ChannelRow,
    target: Target,
    rows: DeliveryRow[],
    message: (row: DeliveryRow) => Message | null,
    dashboardUrl: string | null,
    names: Map<string, string>,
    byKey: Map<string, NoticeRow>,
  ) {
    const store = this.#o.store;
    const now = this.#o.clock();
    const minute = Math.floor(now / 60_000);
    const sent = this.#sent.get(channel.id);
    const counter =
      sent && sent.minute === minute ? sent : { minute, count: 0 };
    this.#sent.set(channel.id, counter);

    // What a storm held back last minute goes out as one message.
    const held = rows.filter((r) => this.#digest.has(r.id));
    const single = rows.filter((r) => !this.#digest.has(r.id));
    if (held.length > 0) {
      const digest = digestOf(
        channel,
        held,
        byKey,
        names,
        dashboardUrl,
        minute,
      );
      const ids = held.map((r) => r.id);
      try {
        await sendMessage(target, digest);
        await store.delivered(ids, digest.id);
        ids.forEach((id) => this.#digest.delete(id));
      } catch (error) {
        await this.#failed(held, error);
      }
      counter.count++;
    }

    for (const row of single) {
      if (channel.storm_limit > 0 && counter.count >= channel.storm_limit) {
        // The rest of this minute waits for the digest at its end.
        this.#digest.add(row.id);
        await store.deferToNextMinute([row.id]);
        continue;
      }
      const m = message(row);
      if (!m) {
        // Its notification is gone, swept by retention: nothing to send.
        await store.delivered([row.id]);
        continue;
      }
      try {
        await sendMessage(target, m);
        await store.delivered([row.id]);
      } catch (error) {
        await this.#failed([row], error);
      }
      counter.count++;
    }
  }

  async #failed(rows: DeliveryRow[], error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    const attempts = Math.max(...rows.map((r) => r.attempts)) + 1;
    await this.#o.store.failed(
      rows.map((r) => r.id),
      reason,
      retryDelayMs(attempts),
    );
  }

  /** Sends a test message through a channel now. */
  async test(
    channel: ChannelRow,
  ): Promise<{ delivered: boolean; error: string | null }> {
    const urls = await this.#o.store.urls();
    try {
      await sendMessage(await this.#target(channel), {
        id: `test:${this.#o.clock()}`,
        source: "app",
        kind: "system",
        severity: "info",
        createdAt: new Date(this.#o.clock()).toISOString(),
        title: `Test message for ${channel.name}`,
        text: "If you can read this, Tripwire can reach this channel.",
        url: absolute(urls.dashboard, "/notifications"),
        event: null,
      });
      return { delivered: true, error: null };
    } catch (error) {
      return {
        delivered: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async #target(channel: ChannelRow): Promise<Target> {
    return {
      type: channel.type,
      settings: channel.settings,
      secrets: await this.#o.secrets.resolved(channel.id),
    };
  }

  async #names(): Promise<Map<string, string>> {
    const contracts = await this.#o.reads.contracts().catch(() => []);
    return new Map(contracts.map((c) => [c.address.toLowerCase(), c.name]));
  }

  /** Says when a channel starts or stops failing, and warns the others after an hour. */
  async #watchChannels() {
    const [states, channels] = await Promise.all([
      this.#o.store.channelStates(),
      this.#o.store.channels(),
    ]);
    const now = this.#o.clock();
    for (const state of states) {
      const failing = state.failing_since !== null;
      if (failing !== this.#failing.has(state.channel_id)) {
        if (failing) this.#failing.add(state.channel_id);
        else this.#failing.delete(state.channel_id);
        this.#emit("channel", { id: state.channel_id, failing });
      }
      const stale =
        failing &&
        state.oldest_pending_at !== null &&
        now - state.oldest_pending_at.getTime() >= FAILING_AFTER_MS;
      if (stale && !this.#reported.has(state.channel_id)) {
        this.#reported.add(state.channel_id);
        const name =
          channels.find((c) => c.id === state.channel_id)?.name ?? "A channel";
        await this.raise(
          "warning",
          `Channel failing: ${name}`,
          `Its oldest undelivered message is over an hour old.${state.last_error ? ` Last error: ${state.last_error}` : ""}`,
          "/settings",
        );
      }
      if (!failing) this.#reported.delete(state.channel_id);
    }
  }

  async #heartbeat() {
    const now = this.#o.clock();
    if (now - this.#lastHeartbeat < HEARTBEAT_MS || !this.#o.watching()) return;
    const { heartbeat } = await this.#o.store.urls();
    if (!heartbeat) return;
    this.#lastHeartbeat = now;
    await fetch(heartbeat, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    })
      .then((response) => response.body?.cancel())
      .catch((error: unknown) =>
        this.#o.log("The heartbeat did not reach its address.", {
          error: String(error),
        }),
      );
  }
}

/** Whether a channel type has every field it needs. */
export function missingFields(
  type: ChannelRow["type"],
  settings: Record<string, string>,
  secrets: string[],
): string[] {
  return channelFields[type]
    .filter((f) => f.required)
    .filter((f) => (f.secret ? !secrets.includes(f.key) : !settings[f.key]))
    .map((f) => f.label);
}

function toMessage(
  notice: NoticeRow,
  names: Map<string, string>,
  dashboardUrl: string | null,
): Message {
  const rendered = render(notice, names);
  return {
    id: rendered.id,
    source: notice.source,
    kind: notice.kind,
    severity: notice.severity,
    createdAt: notice.created_at.toISOString(),
    title: rendered.title,
    text: rendered.text,
    url: absolute(dashboardUrl, rendered.link),
    event: notice.payload,
  };
}

/**
 * "37 more notifications in the last minute: 31 violations on Treasury
 * vault, 6 evaluation errors."
 */
function digestOf(
  channel: ChannelRow,
  rows: DeliveryRow[],
  byKey: Map<string, NoticeRow>,
  names: Map<string, string>,
  dashboardUrl: string | null,
  minute: number,
): Message {
  const notices = rows
    .map((r) => byKey.get(`${r.source}:${r.notification_id}`))
    .filter((n): n is NoticeRow => n !== undefined);
  const groups = new Map<string, number>();
  for (const n of notices) {
    const where =
      n.kind === "violation" && typeof n.payload.contract === "string"
        ? ` on ${names.get(n.payload.contract.toLowerCase()) ?? n.payload.contract}`
        : "";
    const label = `${plural(n.kind)}${where}`;
    groups.set(label, (groups.get(label) ?? 0) + 1);
  }
  const worst = notices.reduce<Severity>(
    (w, n) => (rank[n.severity] > rank[w] ? n.severity : w),
    "info",
  );
  const summary = [...groups]
    .sort((a, b) => b[1] - a[1])
    .map(
      ([label, n]) =>
        `${n} ${n === 1 ? label.replace(/s(?= on|$)/, "") : label}`,
    )
    .join(", ");
  return {
    id: `digest:${channel.id}:${minute}`,
    source: "app",
    kind: "digest",
    severity: worst,
    createdAt: new Date((minute + 1) * 60_000).toISOString(),
    title: `${rows.length} more notifications in the last minute`,
    text: `${summary}.`,
    url: absolute(dashboardUrl, "/notifications"),
    event: {
      notifications: rows.map((r) => `${r.source}:${r.notification_id}`),
    },
  };
}

function plural(kind: string): string {
  return (
    {
      violation: "violations",
      evaluation_error: "evaluation errors",
      response: "responses",
      health: "engine health changes",
      system: "Tripwire alerts",
    }[kind] ?? "notifications"
  );
}
