import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invalidations,
  type Channel,
  joinStream,
  type LiveEnv,
  type LiveHandlers,
  type Locks,
  type Source,
} from "./live";

describe("what an event refreshes", () => {
  it("refreshes every violation list and the rule on a violation", () => {
    expect(invalidations("violation", { ruleId: "7" })).toEqual(
      expect.arrayContaining([["violations"], ["rules"], ["rule", "7"]]),
    );
  });

  it("refreshes the rule previews on a violation and a rule's state", () => {
    expect(invalidations("violation", { ruleId: "7" })).toContainEqual([
      "previews",
    ]);
    expect(invalidations("rule_state", { ruleId: "7" })).toContainEqual([
      "previews",
    ]);
  });

  it("refreshes everything on resync, and only readiness on a block", () => {
    expect(invalidations("resync", { reason: "connected" })).toBe("all");
    expect(invalidations("block", { number: 1 })).toEqual([["readiness"]]);
  });

  it("refreshes violations when a response moves", () => {
    expect(invalidations("response", { id: "3" })).toEqual(
      expect.arrayContaining([
        ["responses"],
        ["response", "3"],
        ["violations"],
      ]),
    );
  });
});

// A browser's tabs, faked: one lock manager and one channel name shared by
// every tab of a test, and a server stream the test drives by hand.
class FakeSource implements Source {
  onopen: Source["onopen"] = null;
  onerror: Source["onerror"] = null;
  readyState = 0;
  closed = false;
  #listeners = new Map<string, (message: MessageEvent) => void>();
  addEventListener(name: string, listener: (message: MessageEvent) => void) {
    this.#listeners.set(name, listener);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  emit(name: string, data: unknown) {
    this.#listeners.get(name)?.(
      new MessageEvent(name, { data: JSON.stringify(data) }),
    );
  }
  fail(readyState: number) {
    this.readyState = readyState;
    this.onerror?.(new Event("error"));
  }
}

/** One lock, granted in request order, as `navigator.locks` grants it. */
function fakeLocks(): Locks {
  const waiting: { held: () => Promise<void>; done: () => void }[] = [];
  let holding = false;
  const next = () => {
    const turn = holding ? undefined : waiting.shift();
    if (!turn) return;
    holding = true;
    // Granted in a later task, as `navigator.locks` grants.
    queueMicrotask(() => {
      void turn.held().finally(() => {
        holding = false;
        turn.done();
        next();
      });
    });
  };
  return {
    request: (_name, { signal }, held) =>
      new Promise((done, refused) => {
        const turn = { held, done: () => done(undefined) };
        signal.addEventListener("abort", () => {
          const at = waiting.indexOf(turn);
          if (at < 0) return;
          waiting.splice(at, 1);
          refused(new DOMException("aborted", "AbortError"));
        });
        waiting.push(turn);
        next();
      }),
  };
}

/**
 * A `BroadcastChannel` in memory, for tests on fake timers; a muted member
 * posts nothing, as a page the browser has suspended.
 */
function fakeHub() {
  const members = new Set<Channel>();
  const muted = new Set<Channel>();
  const channel = () => {
    const self: Channel = {
      onmessage: null,
      postMessage: (message) => {
        if (muted.has(self)) return;
        for (const other of members) {
          if (other === self) continue;
          queueMicrotask(() => {
            if (members.has(other))
              other.onmessage?.(
                new MessageEvent("message", { data: structuredClone(message) }),
              );
          });
        }
      },
      close: () => void members.delete(self),
    };
    members.add(self);
    return self;
  };
  return { channel, members, muted };
}

let channels = 0;
function browser(
  options: { hub?: ReturnType<typeof fakeHub>; locks?: Locks } = {},
) {
  const name = `live-test-${++channels}`;
  const locks = options.locks ?? fakeLocks();
  const sources: FakeSource[] = [];
  const env = (share = true): LiveEnv => ({
    openSource: () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
    share: share
      ? {
          locks,
          channel: options.hub?.channel ?? (() => new BroadcastChannel(name)),
        }
      : undefined,
  });
  return { env, sources };
}

function tab() {
  const seen: string[] = [];
  const on: LiveHandlers = {
    event: (name, data) => seen.push(`${name} ${JSON.stringify(data)}`),
    connected: () => seen.push("connected"),
    disconnected: () => seen.push("disconnected"),
    refused: () => Promise.resolve(),
  };
  return { on, seen };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const leaving: (() => void)[] = [];
const join = (env: LiveEnv, on: LiveHandlers) => {
  const leave = joinStream(env, on);
  leaving.push(leave);
  return leave;
};
afterEach(() => {
  for (const leave of leaving.splice(0)) leave();
  vi.useRealTimers();
});

describe("one stream shared by a browser's tabs", () => {
  it("opens one stream for six tabs and passes every event to each", async () => {
    const { env, sources } = browser();
    const tabs = Array.from({ length: 6 }, () => tab());
    for (const t of tabs) join(env(), t.on);
    await settle();
    expect(sources).toHaveLength(1);

    sources[0]!.open();
    sources[0]!.emit("violation", { ruleId: "7" });
    await settle();
    for (const t of tabs) {
      expect(t.seen).toContain("connected");
      expect(t.seen).toContain('violation {"ruleId":"7"}');
    }
  });

  it("tells a tab that joins late that the stream is open", async () => {
    const { env, sources } = browser();
    join(env(), tab().on);
    await settle();
    sources[0]!.open();
    const late = tab();
    join(env(), late.on);
    await settle();
    expect(late.seen).toEqual([
      "disconnected",
      'resync {"reason":"joined"}',
      "connected",
    ]);
    expect(sources).toHaveLength(1);
  });

  it("refetches everything in a tab that leaves and joins again", async () => {
    const { env, sources } = browser();
    join(env(), tab().on);
    await settle();
    sources[0]!.open();
    const back = tab();
    const leave = join(env(), back.on);
    await settle();
    leave();
    back.seen.length = 0;
    join(env(), back.on);
    await settle();
    expect(back.seen).toContain('resync {"reason":"joined"}');
    expect(sources).toHaveLength(1);
  });

  it("counts the stream as down when its holder goes silent", async () => {
    vi.useFakeTimers();
    const hub = fakeHub();
    const { env, sources } = browser({ hub });
    join(env(), tab().on);
    const holder = [...hub.members][0]!;
    const other = tab();
    join(env(), other.on);
    await vi.advanceTimersByTimeAsync(0);
    sources[0]!.open();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(other.seen.at(-1)).toBe("connected");

    // Suspended without a `freeze`: no beat, no event, no `down`.
    hub.muted.add(holder);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(other.seen.at(-1)).toBe("disconnected");

    // Heard again, it refetches what it may have missed.
    hub.muted.delete(holder);
    other.seen.length = 0;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(other.seen).toEqual(['resync {"reason":"joined"}', "connected"]);
  });

  it("holds its own stream when the lock cannot be had", async () => {
    const locks: Locks = {
      request: () =>
        Promise.reject(new DOMException("storage denied", "SecurityError")),
    };
    const { env, sources } = browser({ locks });
    join(env(), tab().on);
    join(env(), tab().on);
    await settle();
    expect(sources).toHaveLength(2);
  });

  it("hands the stream to the next tab when its holder leaves", async () => {
    const { env, sources } = browser();
    const leaveFirst = join(env(), tab().on);
    const second = tab();
    const third = tab();
    join(env(), second.on);
    join(env(), third.on);
    await settle();
    sources[0]!.open();
    await settle();

    leaveFirst();
    await settle();
    expect(sources[0]!.closed).toBe(true);
    expect(sources).toHaveLength(2);
    expect(third.seen.at(-1)).toBe("disconnected");

    sources[1]!.open();
    sources[1]!.emit("resync", { reason: "connected" });
    await settle();
    expect(second.seen.slice(-2)).toEqual([
      "connected",
      'resync {"reason":"connected"}',
    ]);
    expect(third.seen.slice(-2)).toEqual([
      "connected",
      'resync {"reason":"connected"}',
    ]);
  });

  it("passes a dropped stream on to the other tabs as paused", async () => {
    const { env, sources } = browser();
    join(env(), tab().on);
    const other = tab();
    join(env(), other.on);
    await settle();
    sources[0]!.open();
    sources[0]!.fail(0);
    await settle();
    expect(other.seen.slice(-2)).toEqual(["connected", "disconnected"]);
  });

  it("never opens a stream for a tab that leaves while it waits", async () => {
    const { env, sources } = browser();
    join(env(), tab().on);
    const leaveWaiting = join(env(), tab().on);
    await settle();
    leaveWaiting();
    await settle();
    expect(sources).toHaveLength(1);
  });

  it("holds its own stream where the browser cannot share", () => {
    const { env, sources } = browser();
    const one = tab();
    join(env(false), one.on);
    join(env(false), tab().on);
    expect(sources).toHaveLength(2);
    sources[0]!.open();
    sources[0]!.emit("block", { number: 5 });
    expect(one.seen).toEqual(["connected", 'block {"number":5}']);
  });

  it("asks about the session once refused, then opens again", async () => {
    vi.useFakeTimers();
    const { env, sources } = browser();
    const refused = vi.fn(() => Promise.resolve());
    join(env(false), { ...tab().on, refused });
    sources[0]!.fail(2);
    expect(refused).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sources).toHaveLength(2);
  });
});
