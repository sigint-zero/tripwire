import type { EngineInfo } from "@tripwire/shared";
import { readFile } from "node:fs/promises";
import type pg from "pg";
import { HttpEngine } from "./http";
import { ViewReads } from "./reads";
import { STUB_VIEWS, StubEngine } from "./stub";
import type { EngineCommands, EngineReads } from "./types";

/** The engine as the server uses it: commands, reads, and how it is set up. */
export interface EngineBackend {
  commands: EngineCommands;
  reads: EngineReads;
  info: EngineInfo;
}

/** The development stand-in, kept in the shared database beside `app`. */
export async function stubBackend(pool: pg.Pool): Promise<EngineBackend> {
  return {
    commands: await StubEngine.open(pool),
    reads: new ViewReads(pool, STUB_VIEWS),
    info: { chainId: 1, responseMode: "prepare", simulated: true },
  };
}

/** The engine: its control interface for commands, its views for reads. */
export function engineBackend(
  pool: pg.Pool,
  options: {
    url: string;
    secret: string;
    chainId: number;
    responseMode: EngineInfo["responseMode"];
  },
): EngineBackend {
  return {
    commands: new HttpEngine({ url: options.url, secret: options.secret }),
    reads: new ViewReads(pool, "api_v1"),
    info: {
      chainId: options.chainId,
      responseMode: options.responseMode,
      simulated: false,
    },
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
  if (!url) return stubBackend(pool);
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
    chainId: Number(env.TRIPWIRE_CHAIN_ID ?? 1),
    responseMode: mode,
  });
}
