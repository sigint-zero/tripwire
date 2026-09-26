import type { EngineEvents, EngineListener } from "./types";

// The server's one connection to the engine's event stream. It
// reconnects for as long as anyone listens, and every (re)connection is a
// resync: the engine keeps no replay, so whatever happened while the
// connection was down is read back from the views.

const FIRST_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
/** Connected this long, the next drop starts again from the first delay. */
const STEADY_MS = 60_000;

interface Log {
  warn(message: string, detail?: object): void;
  error(message: string, detail?: object): void;
}

export class EngineStream implements EngineEvents {
  /** Null while no engine runs to connect to. */
  readonly #url: () => string | null;
  readonly #secret: () => Promise<string>;
  readonly #log: Log;
  readonly #listeners = new Set<EngineListener>();
  #stop: AbortController | null = null;

  /**
   * `secret` is read again when the engine refuses it: a new data
   * directory. `url` is asked at each connection, since a supervised
   * engine moves to a new port when it restarts.
   */
  constructor(options: {
    url: string | (() => string | null);
    secret: () => Promise<string>;
    log?: Log;
  }) {
    const url = options.url;
    this.#url =
      typeof url === "string"
        ? () => url.replace(/\/$/, "")
        : () => url()?.replace(/\/$/, "") ?? null;
    this.#secret = options.secret;
    this.#log = options.log ?? {
      warn: (m, d) => console.warn(m, d ?? ""),
      error: (m, d) => console.error(m, d ?? ""),
    };
  }

  listen(listener: EngineListener): () => void {
    this.#listeners.add(listener);
    if (!this.#stop) {
      this.#stop = new AbortController();
      void this.#run(this.#stop.signal);
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#stop?.abort();
        this.#stop = null;
      }
    };
  }

  #resync(reason: string) {
    for (const l of this.#listeners) l.resync(reason);
  }

  async #run(signal: AbortSignal) {
    let delay = FIRST_DELAY_MS;
    let secret = await this.#secret().catch(() => "");
    let refused = false;
    while (!signal.aborted) {
      let connectedAt: number | null = null;
      const url = this.#url();
      if (url === null) {
        // Nothing runs yet; look again shortly, without counting it as a drop.
        await sleep(FIRST_DELAY_MS, signal);
        continue;
      }
      try {
        if (refused === false && secret === "") {
          secret = await this.#secret().catch(() => "");
        }
        const response = await fetch(`${url}/v1/events`, {
          headers: {
            authorization: `Bearer ${secret.trim()}`,
            accept: "text/event-stream",
          },
          signal,
        });
        if (response.status === 401) {
          // Read the secret once more; refused again, stay closed until
          // the engine next starts.
          if (!refused) {
            refused = true;
            secret = await this.#secret().catch(() => "");
            continue;
          }
          this.#log.error("The engine refused the interface secret twice.");
          this.#resync("engine");
          return;
        }
        if (!response.ok || !response.body) {
          throw new Error(`The engine's stream answered ${response.status}.`);
        }
        refused = false;
        connectedAt = Date.now();
        this.#resync("upstream");
        await this.#read(response.body);
      } catch (error) {
        if (signal.aborted) return;
        this.#log.warn("The engine's event stream dropped.", {
          error: String(error),
        });
      }
      if (connectedAt !== null && Date.now() - connectedAt >= STEADY_MS) {
        delay = FIRST_DELAY_MS;
      }
      // A random tenth either way, so restarts do not reconnect in step.
      const wait = delay * (0.9 + Math.random() * 0.2);
      await sleep(wait, signal);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }

  /** Reads server-sent events until the stream ends. */
  async #read(body: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    let buffer = "";
    let name = "message";
    let id: string | undefined;
    let data: string[] = [];
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.search(/\r\n|\n|\r/)) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(
          buffer[newline] === "\r" && buffer[newline + 1] === "\n"
            ? newline + 2
            : newline + 1,
        );
        if (line === "") {
          if (data.length > 0) this.#dispatch(name, id, data.join("\n"));
          name = "message";
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value =
          colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") name = value;
        else if (field === "data") data.push(value);
        else if (field === "id") id = value;
      }
    }
  }

  #dispatch(name: string, id: string | undefined, raw: string) {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      // The server does not guess: anything may have been missed.
      this.#log.warn("Could not read an event from the engine.", {
        event: name,
        id,
      });
      this.#resync("upstream");
      return;
    }
    if (name === "error") {
      // Sent just before the engine hangs up on a reader that fell
      // behind: the reconnect follows, and anything may have been missed.
      const { code, message } = (data ?? {}) as {
        code?: string;
        message?: string;
      };
      this.#log.warn("The engine is disconnecting: it fell behind.", {
        code,
        message,
      });
      this.#resync("upstream");
      return;
    }
    for (const l of this.#listeners) l.event({ event: name, data });
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
