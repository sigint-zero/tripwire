import type { ServerResponse } from "node:http";
import type { EngineEvent, EngineEvents } from "./types";

// The browser side of live updates: one engine stream fanned out to every
// open tab. Events only say which thing changed; the dashboard reads the
// thing itself through the API, so a missed event costs a refetch.

/** Events a browser connection may hold unsent before it is told to resync. */
export const QUEUE_LIMIT = 256;
/** Open streams per session; one more closes the oldest. */
export const STREAMS_PER_SESSION = 10;
const KEEP_ALIVE_MS = 15_000;
const BLOCK_EVERY_MS = 1_000;

export interface BrowserEvent {
  event: string;
  data: object;
}

type Row = Record<string, unknown>;
const text = (v: unknown) =>
  typeof v === "string" || typeof v === "number" ? String(v) : undefined;

/**
 * An engine event as the browser gets it, `null` for one the browser has
 * no use for, or `undefined` when it cannot be read.
 */
export function toBrowser(event: EngineEvent): BrowserEvent | null | undefined {
  if (typeof event.data !== "object" || event.data === null) return undefined;
  const row = event.data as Row;
  const need = (...values: unknown[]) =>
    values.every((v) => v !== undefined) ? true : undefined;
  switch (event.event) {
    case "block":
      return (
        need(row.number, row.time) && {
          event: "block",
          data: { number: Number(row.number), time: row.time },
        }
      );
    case "violation":
      return (
        need(text(row.id), text(row.rule_id)) && {
          event: "violation",
          data: {
            id: text(row.id),
            ruleId: text(row.rule_id),
            contractAddress: row.contract_address,
            kind: row.kind,
            severity: row.severity,
          },
        }
      );
    case "rule_state":
      return (
        need(text(row.rule_id)) && {
          event: "rule_state",
          data: {
            ruleId: text(row.rule_id),
            enabled: row.enabled,
            warming: row.warming,
          },
        }
      );
    case "trip_state":
      return (
        need(row.contract_address) && {
          event: "trip_state",
          data: {
            contractAddress: row.contract_address,
            selector: row.selector,
            source: row.source,
            tripped: row.tripped,
          },
        }
      );
    case "response":
      return (
        need(text(row.id)) && {
          event: "response",
          data: {
            id: text(row.id),
            ruleId: text(row.rule_id),
            status: row.status,
          },
        }
      );
    case "notification":
      return (
        need(text(row.id)) && {
          event: "notification",
          data: {
            id: text(row.id),
            source: "engine",
            kind: row.kind,
            severity:
              typeof row.payload === "object" && row.payload
                ? (row.payload as Row).severity
                : undefined,
          },
        }
      );
    case "health":
      return (
        need(row.status) && {
          event: "health",
          data: { state: row.status, since: new Date().toISOString() },
        }
      );
    default:
      return null;
  }
}

/** One browser tab's stream. */
export class BrowserStream {
  readonly sessionId: string;
  readonly #out: ServerResponse;
  readonly #onEnd: (stream: BrowserStream) => void;
  readonly #queue: string[] = [];
  #waiting = false;
  #id = 0;
  #ended = false;

  constructor(
    sessionId: string,
    out: ServerResponse,
    onEnd: (stream: BrowserStream) => void,
  ) {
    this.sessionId = sessionId;
    this.#out = out;
    this.#onEnd = onEnd;
  }

  get ended() {
    return this.#ended;
  }

  send(event: BrowserEvent) {
    if (this.#ended) return;
    const chunk = `id: ${++this.#id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
    if (this.#waiting) {
      // A tab that cannot keep up is told to refetch and reconnect,
      // rather than silently losing events.
      if (this.#queue.length >= QUEUE_LIMIT) return this.#behind();
      this.#queue.push(chunk);
      return;
    }
    this.#write(chunk);
  }

  keepAlive() {
    if (!this.#ended && !this.#waiting) this.#write(": keep-alive\n\n");
  }

  end() {
    if (this.#ended) return;
    this.#ended = true;
    this.#queue.length = 0;
    this.#out.end();
    this.#onEnd(this);
  }

  #write(chunk: string) {
    if (!this.#out.write(chunk)) {
      this.#waiting = true;
      this.#out.once("drain", () => this.#flush());
    }
  }

  #flush() {
    this.#waiting = false;
    while (this.#queue.length > 0 && !this.#ended) {
      this.#write(this.#queue.shift()!);
      if (this.#waiting) return;
    }
  }

  #behind() {
    this.#queue.length = 0;
    this.#out.write(
      `id: ${++this.#id}\nevent: resync\ndata: ${JSON.stringify({ reason: "behind" })}\n\n`,
    );
    this.end();
  }
}

export class BrowserRelay {
  readonly #streams = new Set<BrowserStream>();
  readonly #checks = new Map<BrowserStream, () => Promise<boolean>>();
  readonly #unlisten: () => void;
  readonly #warn: (message: string, detail: object) => void;
  readonly #timer: NodeJS.Timeout;
  #lastBlockAt = 0;
  #nextBlock: BrowserEvent | null = null;
  #blockTimer: NodeJS.Timeout | null = null;

  constructor(
    engine: EngineEvents,
    warn: (message: string, detail: object) => void = (m, d) =>
      console.warn(m, d),
  ) {
    this.#warn = warn;
    this.#unlisten = engine.listen({
      event: (event) => this.#fromEngine(event),
      resync: (reason) =>
        this.#broadcast({ event: "resync", data: { reason } }),
    });
    // Keep proxies from closing idle streams, and end the streams of
    // sessions that have ended.
    this.#timer = setInterval(() => void this.#tend(), KEEP_ALIVE_MS);
    this.#timer.unref();
  }

  /**
   * Opens a tab's stream. It starts with `resync`, since nothing is
   * replayed; `valid` says whether its session still stands.
   */
  open(
    sessionId: string,
    out: ServerResponse,
    valid: () => Promise<boolean>,
  ): BrowserStream {
    const mine = [...this.#streams].filter((s) => s.sessionId === sessionId);
    if (mine.length >= STREAMS_PER_SESSION) mine[0]!.end();
    const stream = new BrowserStream(sessionId, out, (s) => {
      this.#streams.delete(s);
      this.#checks.delete(s);
    });
    this.#streams.add(stream);
    this.#checks.set(stream, valid);
    stream.send({ event: "resync", data: { reason: "connected" } });
    return stream;
  }

  get size() {
    return this.#streams.size;
  }

  close() {
    clearInterval(this.#timer);
    if (this.#blockTimer) clearTimeout(this.#blockTimer);
    this.#unlisten();
    for (const s of [...this.#streams]) s.end();
  }

  #broadcast(event: BrowserEvent) {
    for (const s of [...this.#streams]) s.send(event);
  }

  #fromEngine(event: EngineEvent) {
    const out = toBrowser(event);
    if (out === null) return;
    if (out === undefined) {
      this.#warn("Could not read an event from the engine.", {
        event: event.event,
      });
      this.#broadcast({ event: "resync", data: { reason: "upstream" } });
      return;
    }
    if (out.event === "block") return this.#block(out);
    this.#broadcast(out);
  }

  /** At most one block a second, the latest winning. */
  #block(event: BrowserEvent) {
    const since = Date.now() - this.#lastBlockAt;
    if (since >= BLOCK_EVERY_MS && !this.#blockTimer) {
      this.#lastBlockAt = Date.now();
      this.#broadcast(event);
      return;
    }
    this.#nextBlock = event;
    this.#blockTimer ??= setTimeout(
      () => {
        this.#blockTimer = null;
        this.#lastBlockAt = Date.now();
        const next = this.#nextBlock;
        this.#nextBlock = null;
        if (next) this.#broadcast(next);
      },
      Math.max(BLOCK_EVERY_MS - since, 0),
    );
  }

  async #tend() {
    for (const s of [...this.#streams]) {
      const valid = this.#checks.get(s);
      if (valid && !(await valid().catch(() => false))) {
        s.end();
        continue;
      }
      s.keepAlive();
    }
  }
}
