import type { EngineInfo } from "@tripwire/shared";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type pg from "pg";
import { EngineStream } from "../events/upstream";
import type { EngineEvents } from "../events/types";
import { HttpEngine } from "./http";
import { ViewReads } from "./reads";
import { STUB_VIEWS, StubEngine } from "./stub";
import type { EngineSupervisor } from "./supervisor";
import { EngineError, type EngineCommands, type EngineReads } from "./types";

/** The engine as the server uses it: commands, reads, and how it is set up. */
export interface EngineBackend {
  commands: EngineCommands;
  reads: EngineReads;
  /** What changed, as it happens. */
  events: EngineEvents;
  info: EngineInfo;
  /** Where the engine keeps its keystore files; none for the stand-in. */
  keysDirectory?: string | null;
  /** Set when the application runs the engine itself. */
  supervisor?: EngineSupervisor;
  /** Stops whatever the backend runs on its own. */
  close(): Promise<void>;
}

/**
 * The development stand-in, kept in the shared database beside `app`.
 * With `ticking`, it evaluates its rules on every simulated block.
 */
export async function stubBackend(
  pool: pg.Pool,
  { ticking = false } = {},
): Promise<EngineBackend> {
  const stub = await StubEngine.open(pool, Date.now, "prepare");
  return {
    commands: stub,
    reads: new ViewReads(pool, STUB_VIEWS),
    events: stub,
    info: { chainId: 1, responseMode: "prepare", simulated: true },
    keysDirectory: null,
    close: ticking ? stub.ticking() : () => Promise.resolve(),
  };
}

/** The engine: its control interface for commands, its views for reads. */
export function engineBackend(
  pool: pg.Pool,
  options: {
    url: string;
    secret: string;
    /** Read again when the engine refuses the secret it was given. */
    readSecret?: () => Promise<string>;
    chainId: number;
    responseMode: EngineInfo["responseMode"];
    keysDirectory?: string | null;
  },
): EngineBackend {
  return {
    commands: new HttpEngine({ url: options.url, secret: options.secret }),
    reads: new ViewReads(pool, "api_v1"),
    events: new EngineStream({
      url: options.url,
      secret: options.readSecret ?? (() => Promise.resolve(options.secret)),
    }),
    info: {
      chainId: options.chainId,
      responseMode: options.responseMode,
      simulated: false,
    },
    keysDirectory: options.keysDirectory ?? null,
    close: () => Promise.resolve(),
  };
}

/**
 * The engine the application runs itself: commands go to whichever
 * process runs now, since each start takes a new port, and are refused
 * while none does; the views are read as they are.
 */
export function supervisedBackend(
  pool: pg.Pool,
  supervisor: EngineSupervisor,
): EngineBackend {
  let client: { key: string; engine: HttpEngine } | null = null;
  const current = (): HttpEngine => {
    const target = supervisor.current();
    if (!target) {
      throw new EngineError(
        503,
        "engine_not_running",
        `The engine is not running (${supervisor.phase}). See GET /engine.`,
      );
    }
    const key = `${target.url} ${target.secret}`;
    if (client?.key !== key) {
      client = { key, engine: new HttpEngine(target) };
    }
    return client.engine;
  };
  const commands = new Proxy({} as EngineCommands, {
    get: (_target, name) => {
      if (typeof name !== "string" || name === "then") return undefined;
      // Every command answers with a promise, refusals included.
      return (...args: unknown[]) => {
        try {
          const engine = current() as unknown as Record<
            string,
            (...a: unknown[]) => unknown
          >;
          return engine[name]!(...args);
        } catch (error) {
          return Promise.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      };
    },
  });
  return {
    commands,
    reads: new ViewReads(pool, "api_v1"),
    events: new EngineStream({
      url: () => supervisor.current()?.url ?? null,
      secret: () => Promise.resolve(supervisor.current()?.secret ?? ""),
    }),
    info: supervisor.info,
    keysDirectory: join(supervisor.home, "engine", "keys"),
    supervisor,
    close: () => supervisor.stop(),
  };
}

/**
 * The engine when `TRIPWIRE_ENGINE_URL` names its control interface,
 * otherwise the stand-in. Until the application spawns the engine itself,
 * the secret file and chain come from the environment too.
 */
export async function connectEngine(
  pool: pg.Pool,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EngineBackend> {
  const url = env.TRIPWIRE_ENGINE_URL;
  if (!url) return stubBackend(pool, { ticking: true });
  const secretFile = env.TRIPWIRE_ENGINE_SECRET_FILE;
  if (!secretFile) {
    throw new Error(
      "TRIPWIRE_ENGINE_SECRET_FILE must name the engine's interface-secret file.",
    );
  }
  const mode = env.TRIPWIRE_RESPONSE_MODE ?? "notify";
  if (mode !== "notify" && mode !== "prepare" && mode !== "send") {
    throw new Error(`Unknown TRIPWIRE_RESPONSE_MODE: ${mode}`);
  }
  return engineBackend(pool, {
    url,
    secret: await readFile(secretFile, "utf8"),
    readSecret: () => readFile(secretFile, "utf8"),
    chainId: Number(env.TRIPWIRE_CHAIN_ID ?? 1),
    responseMode: mode,
    // The secret sits in the engine's data directory, beside its keys.
    keysDirectory: join(dirname(secretFile), "keys"),
  });
}
