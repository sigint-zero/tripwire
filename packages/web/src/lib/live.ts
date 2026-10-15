import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { auth } from "./api";

// Live updates: one server-sent event stream per browser, shared by
// its tabs. An event only says what changed; the queries that could
// show it are invalidated and read again through the API, so a missed
// event costs a refetch, never a wrong page.

/** Without a stream this long, the shell says updates are paused. */
const QUIET_MS = 5_000;
/** How often queries on screen are refetched while there is no stream. */
const POLL_MS = 60_000;
/** Before opening a stream again after the server refused one. */
const RETRY_MS = 5_000;

const EVENTS = [
  "block",
  "violation",
  "rule_state",
  "trip_state",
  "response",
  "notification",
  "health",
  "settings",
  "channel",
  "resync",
] as const;

type Payload = Record<string, unknown>;
const text = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * The queries an event could have changed: prefixes, so `["violations"]`
 * covers every filter. `"all"` for everything, `[]` for nothing.
 */
export function invalidations(
  event: string,
  data: Payload,
): QueryKey[] | "all" {
  switch (event) {
    case "violation":
      return [
        ["violations"],
        ["rules"],
        ["rule", text(data.ruleId)],
        ["contracts"],
        ["trip-state"],
        // A value that crossed its limit turns red without waiting.
        ["previews"],
      ];
    case "rule_state":
      return [
        ["rules"],
        ["rule", text(data.ruleId)],
        ["contracts"],
        ["contract"],
        ["previews"],
      ];
    case "trip_state":
      return [
        ["trip-state"],
        ["contracts"],
        ["contract", text(data.contractAddress)],
        ["activity"],
      ];
    case "response":
      return [["responses"], ["response", text(data.id)], ["violations"]];
    case "notification":
      return [["notifications"]];
    case "block":
      // A readiness checklist ticks by itself as the controller's events land.
      return [["readiness"]];
    case "health":
      return [["engine"]];
    case "settings":
      return [["engine"], ["settings", text(data.area)]];
    case "channel":
      return [["channels"]];
    case "resync":
      return "all";
    default:
      return [];
  }
}

// What the shell shows about the stream, kept outside React so any
// component can read it.
interface LiveState {
  /** No stream for a while: the page is not being kept current. */
  paused: boolean;
  /** The chain's head, from the latest `block`. */
  head: { number: number; time: string } | null;
}
let state: LiveState = { paused: false, head: null };
const subscribers = new Set<() => void>();
const update = (change: Partial<LiveState>) => {
  state = { ...state, ...change };
  for (const s of subscribers) s();
};
const subscribe = (s: () => void) => {
  subscribers.add(s);
  return () => subscribers.delete(s);
};

export function useLive(): LiveState {
  return useSyncExternalStore(subscribe, () => state);
}

// The tabs of one browser share one stream. A browser keeps six HTTP/1.1
// connections per site, and a stream holds one for as long as its tab is
// open, so a stream per tab stalls the sixth tab. One tab holds the lock
// and the stream and passes each event to the others; when it closes, the
// next tab in line opens its own, which starts with `resync`. Where the
// browser has no lock manager (outside a secure context: plain HTTP to
// anything but a loopback address) every tab holds its own stream.

/** The lock and channel; the suffix is the protocol's version. */
const LOCK = "tripwire-live-1";
/** How often the holder tells the other tabs it is still there. */
const BEAT_MS = 20_000;
/**
 * Silence after which the other tabs count the stream as down: past the
 * once a minute Chromium allows the timers of a page hidden for long.
 */
const SILENT_MS = 90_000;
/** `EventSource.CLOSED`: the browser gave up and will not reconnect. */
const CLOSED = 2;

/** What a tab needs of an `EventSource`; tests pass a fake. */
export interface Source {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  readonly readyState: number;
  addEventListener(
    name: string,
    listener: (message: MessageEvent) => void,
  ): void;
  close(): void;
}

/** What the stream's holder tells the other tabs, and what they ask it. */
type Message =
  | { kind: "event"; name: string; data: Payload }
  | { kind: "open" }
  | { kind: "down" }
  | { kind: "beat"; open: boolean }
  | { kind: "hello" };

export interface Channel {
  postMessage(message: Message): void;
  onmessage: ((message: MessageEvent<Message>) => void) | null;
  close(): void;
}

export interface Locks {
  request(
    name: string,
    options: { signal: AbortSignal },
    held: () => Promise<void>,
  ): Promise<unknown>;
}

export interface LiveEnv {
  openSource: () => Source;
  /** Absent where the browser cannot share: the tab holds its own stream. */
  share?: { locks: Locks; channel: () => Channel };
}

export interface LiveHandlers {
  event: (name: string, data: Payload) => void;
  connected: () => void;
  disconnected: () => void;
  /** The browser closed the stream for good; resolves once it may reopen. */
  refused: () => Promise<void>;
}

/** Joins the browser's shared stream, or holds one; returns what leaves it. */
export function joinStream(env: LiveEnv, on: LiveHandlers): () => void {
  let source: Source | null = null;
  let open = false;
  let leading = false;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  let silence: ReturnType<typeof setTimeout> | undefined;
  let release: (() => void) | undefined;
  // A tab with its own stream starts with `resync`; one that hears another
  // tab's refetches everything the first time it hears the stream is open,
  // after it joins and after a silence, so no event it missed shows.
  let synced = false;
  const channel = env.share?.channel() ?? null;
  const tell = (message: Message) => {
    if (leading) channel?.postMessage(message);
  };

  const connect = () => {
    source = env.openSource();
    source.onopen = () => {
      open = true;
      on.connected();
      tell({ kind: "open" });
    };
    for (const name of EVENTS) {
      source.addEventListener(name, (message) => {
        let data: Payload;
        try {
          data = JSON.parse((message as MessageEvent<string>).data) as Payload;
        } catch {
          data = {};
        }
        on.event(name, data);
        tell({ kind: "event", name, data });
      });
    }
    source.onerror = () => {
      open = false;
      on.disconnected();
      tell({ kind: "down" });
      // A dropped connection is retried by the browser itself; a refused
      // one is closed for good.
      if (source?.readyState !== CLOSED) return;
      void on.refused().finally(() => {
        if (!stopped) retry = setTimeout(connect, RETRY_MS);
      });
    };
  };

  const lead = () =>
    new Promise<void>((resolve) => {
      release = resolve;
      if (stopped) return resolve();
      leading = true;
      clearTimeout(silence);
      beat = setInterval(() => tell({ kind: "beat", open }), BEAT_MS);
      connect();
    });

  const opened = () => {
    if (!synced) {
      synced = true;
      on.event("resync", { reason: "joined" });
    }
    on.connected();
  };

  let abort: AbortController | undefined;
  if (env.share && channel) {
    channel.onmessage = ({ data: message }) => {
      if (leading) {
        if (message.kind === "hello") tell({ kind: open ? "open" : "down" });
        return;
      }
      // A holder that stops running without leaving (a page suspended
      // with no `freeze`) goes silent: the stream counts as down.
      clearTimeout(silence);
      silence = setTimeout(() => {
        synced = false;
        on.disconnected();
      }, SILENT_MS);
      if (message.kind === "event") on.event(message.name, message.data);
      else if (message.kind === "open") opened();
      else if (message.kind === "down") on.disconnected();
      else if (message.kind === "beat") {
        if (message.open) opened();
        else on.disconnected();
      }
    };
    // Until the holder answers, this tab has no stream.
    on.disconnected();
    channel.postMessage({ kind: "hello" });
    abort = new AbortController();
    void env.share.locks
      .request(LOCK, { signal: abort.signal }, lead)
      .catch((error: unknown) => {
        if (stopped || (error instanceof Error && error.name === "AbortError"))
          return;
        // No lock to be had (storage denied): the tab holds its own.
        leading = true;
        connect();
      });
  } else {
    leading = true;
    connect();
  }

  return () => {
    stopped = true;
    abort?.abort();
    if (open) tell({ kind: "down" });
    source?.close();
    clearTimeout(retry);
    clearInterval(beat);
    clearTimeout(silence);
    channel?.close();
    leading = false;
    release?.();
  };
}

/** The browser's own stream and, where it can share, its lock and channel. */
function browserEnv(): LiveEnv {
  const openSource = () => new EventSource("/api/v1/events");
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks || typeof BroadcastChannel === "undefined") return { openSource };
  return {
    openSource,
    share: { locks, channel: () => new BroadcastChannel(LOCK) },
  };
}

/** Joins the browser's stream while the shell is on screen. */
export function useLiveUpdates() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;

    const on: LiveHandlers = {
      event: (name, data) => {
        if (name === "block") {
          update({
            head: { number: Number(data.number), time: text(data.time) },
          });
        }
        const keys = invalidations(name, data);
        if (keys === "all") void queryClient.invalidateQueries();
        else
          for (const queryKey of keys)
            void queryClient.invalidateQueries({ queryKey });
      },
      connected: () => {
        clearTimeout(quiet);
        quiet = undefined;
        clearInterval(poll);
        poll = undefined;
        update({ paused: false });
      },
      disconnected: () => {
        quiet ??= setTimeout(() => update({ paused: true }), QUIET_MS);
        // The floor while the stream is down: what is on screen, every minute.
        poll ??= setInterval(
          () => void queryClient.invalidateQueries(),
          POLL_MS,
        );
      },
      // One look at the session tells an ended session, which goes to the
      // login page, from a server hiccup.
      refused: () =>
        queryClient
          .fetchQuery({
            queryKey: ["auth", "session"],
            queryFn: ({ signal }) => auth.session(signal),
            staleTime: 0,
          })
          .then(
            () => {},
            () => {},
          ),
    };

    // A page kept in the back-forward cache, or frozen in the background,
    // would keep its stream and its place in line while it runs nothing:
    // it leaves, and joins again when it comes back.
    let leave = joinStream(browserEnv(), on);
    // Chromium fires `resume` and `pageshow` for one restore: join once.
    let gone = false;
    const away = () => {
      if (gone) return;
      gone = true;
      leave();
    };
    const back = () => {
      if (!gone) return;
      gone = false;
      leave = joinStream(browserEnv(), on);
    };
    const shown = (event: PageTransitionEvent) => {
      if (event.persisted) back();
    };
    window.addEventListener("pagehide", away);
    window.addEventListener("pageshow", shown);
    document.addEventListener("freeze", away);
    document.addEventListener("resume", back);
    return () => {
      window.removeEventListener("pagehide", away);
      window.removeEventListener("pageshow", shown);
      document.removeEventListener("freeze", away);
      document.removeEventListener("resume", back);
      if (!gone) leave();
      clearTimeout(quiet);
      clearInterval(poll);
      update({ paused: false });
    };
  }, [queryClient]);
}
