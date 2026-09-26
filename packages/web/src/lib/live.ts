import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { auth } from "./api";

// Live updates: one server-sent event stream per tab. An event only says
// what changed; the queries that could show it are invalidated and read
// again through the API, so a missed event costs a refetch, never a
// wrong page.

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
      ];
    case "rule_state":
      return [
        ["rules"],
        ["rule", text(data.ruleId)],
        ["contracts"],
        ["contract"],
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

/** Opens the tab's stream while the shell is on screen. */
export function useLiveUpdates() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let source: EventSource | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;

    const connected = () => {
      clearTimeout(quiet);
      quiet = undefined;
      clearInterval(poll);
      poll = undefined;
      update({ paused: false });
    };
    const disconnected = () => {
      quiet ??= setTimeout(() => update({ paused: true }), QUIET_MS);
      // The floor while the stream is down: what is on screen, every minute.
      poll ??= setInterval(() => void queryClient.invalidateQueries(), POLL_MS);
    };

    const connect = () => {
      source = new EventSource("/api/v1/events");
      source.onopen = connected;
      for (const name of EVENTS) {
        source.addEventListener(name, (message) => {
          let data: Payload;
          try {
            data = JSON.parse(
              (message as MessageEvent<string>).data,
            ) as Payload;
          } catch {
            data = {};
          }
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
        });
      }
      source.onerror = () => {
        disconnected();
        // A dropped connection is retried by the browser itself; a refused
        // one is closed for good. One look at the session tells an ended
        // session, which goes to the login page, from a server hiccup.
        if (source?.readyState !== EventSource.CLOSED) return;
        void queryClient
          .fetchQuery({
            queryKey: ["auth", "session"],
            queryFn: ({ signal }) => auth.session(signal),
            staleTime: 0,
          })
          .catch(() => {})
          .finally(() => {
            if (!stopped) retry = setTimeout(connect, RETRY_MS);
          });
      };
    };

    connect();
    return () => {
      stopped = true;
      source?.close();
      clearTimeout(retry);
      clearTimeout(quiet);
      clearInterval(poll);
      update({ paused: false });
    };
  }, [queryClient]);
}
