import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { openSync, closeSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";

/**
 * Running the installed engine (`ENGINE.md`, Start): write `engine.toml`,
 * migrate, spawn, wait for the secret and health, and stop with SIGTERM,
 * then SIGKILL after 15 seconds. Until the application keeps
 * `config.json`, the engine's configuration comes from the environment.
 * Restarts are not supervised yet: an engine that exits stays down until
 * the next start.
 */

export interface EngineConfig {
  chainId: number;
  responseMode: "notify" | "prepare" | "send";
  /** Set when `TRIPWIRE_RPC_WS` is: the mempool is watched, never responded to. */
  mempool: boolean;
  /** `[keys] passphrase` is written only when the variable is set. */
  keysPassphrase: boolean;
}

export class EngineLaunchError extends Error {}

/** The engine's configuration from the environment, refused with a reason. */
export function engineConfig(env: NodeJS.ProcessEnv): EngineConfig {
  if (!env.TRIPWIRE_RPC_HTTP) {
    throw new EngineLaunchError(
      "TRIPWIRE_RPC_HTTP must name the chain's HTTP endpoint for the engine.",
    );
  }
  const chainId = Number(env.TRIPWIRE_CHAIN_ID ?? 1);
  if (!Number.isSafeInteger(chainId) || chainId < 1) {
    throw new EngineLaunchError(
      `TRIPWIRE_CHAIN_ID must be a chain id, not "${env.TRIPWIRE_CHAIN_ID}".`,
    );
  }
  const responseMode = env.TRIPWIRE_RESPONSE_MODE ?? "notify";
  if (
    responseMode !== "notify" &&
    responseMode !== "prepare" &&
    responseMode !== "send"
  ) {
    throw new EngineLaunchError(
      `TRIPWIRE_RESPONSE_MODE must be notify, prepare or send, not "${responseMode}".`,
    );
  }
  return {
    chainId,
    responseMode,
    mempool: Boolean(env.TRIPWIRE_RPC_WS),
    keysPassphrase: Boolean(env.TRIPWIRE_KEYS_PASSPHRASE),
  };
}

/**
 * `engine.toml` for this run. Every secret is an `env:` reference, so the
 * file holds none.
 */
export function engineToml(
  config: EngineConfig,
  options: { dataDir: string; port: number; local: boolean },
): string {
  const lines = [
    "# Written by `tripwire start` on every start. Edits are overwritten.",
    "",
    "[chain]",
    `chain_id = ${config.chainId}`,
    'rpc_http = "env:TRIPWIRE_RPC_HTTP"',
    ...(config.mempool ? ['rpc_ws = "env:TRIPWIRE_RPC_WS"'] : []),
    "",
    "[database]",
    'url = "env:TRIPWIRE_DATABASE_URL"',
    // The local database is one session behind the pooler (DATABASE.md).
    ...(options.local ? ["max_connections = 1"] : []),
    "",
    "[data]",
    `dir = ${JSON.stringify(options.dataDir)}`,
    "",
    "[engine]",
    `bind = "127.0.0.1:${options.port}"`,
    "",
    "[response]",
    `mode = "${config.responseMode}"`,
    "",
    "[mempool]",
    `enabled = ${config.mempool}`,
    "respond = false",
  ];
  if (config.keysPassphrase) {
    lines.push("", "[keys]", 'passphrase = "env:TRIPWIRE_KEYS_PASSPHRASE"');
  }
  return `${lines.join("\n")}\n`;
}

/** Only what the engine needs reaches it (ENGINE.md, the engine's environment). */
export function engineEnvironment(
  env: NodeJS.ProcessEnv,
  databaseUrl: string,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    PATH: env.PATH,
    TRIPWIRE_DATABASE_URL: databaseUrl,
    TRIPWIRE_RPC_HTTP: env.TRIPWIRE_RPC_HTTP,
  };
  if (env.TRIPWIRE_RPC_WS) out.TRIPWIRE_RPC_WS = env.TRIPWIRE_RPC_WS;
  if (env.TRIPWIRE_KEYS_PASSPHRASE) {
    out.TRIPWIRE_KEYS_PASSPHRASE = env.TRIPWIRE_KEYS_PASSPHRASE;
  }
  return out;
}

export interface RunningEngine {
  /** The control interface, for `TRIPWIRE_ENGINE_URL`. */
  url: string;
  secretFile: string;
  config: EngineConfig;
  logFile: string;
  /** Resolves when the engine has exited, with its code. */
  exited: Promise<number | null>;
  stop(): Promise<void>;
}

const STOP_GRACE_MS = 15_000;

/** Start the verified `binary` against `databaseUrl`, and wait until it answers. */
export async function launchEngine(options: {
  binary: string;
  home: string;
  databaseUrl: string;
  /** Local mode: the engine shares the pooler's one session. */
  local: boolean;
  env?: NodeJS.ProcessEnv;
  /** How long to wait for the engine to answer. */
  readyTimeoutMs?: number;
}): Promise<RunningEngine> {
  const env = options.env ?? process.env;
  const binary = options.binary;
  const config = engineConfig(env);
  const childEnv = engineEnvironment(env, options.databaseUrl);

  const dataDir = join(options.home, "engine");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await stopOrphan(join(dataDir, "engine.pid"));

  const port = await freePort();
  const configFile = join(options.home, "engine.toml");
  const staged = `${configFile}.${process.pid}`;
  await writeFile(
    staged,
    engineToml(config, { dataDir, port, local: options.local }),
    { mode: 0o600 },
  );
  await rename(staged, configFile);

  const migrated = await run(
    binary,
    ["migrate", "--config", configFile],
    childEnv,
  );
  if (migrated.code !== 0) {
    throw new EngineLaunchError(
      `The engine refused to migrate the database (exit ${migrated.code}): ${(
        migrated.stderr || migrated.stdout
      ).trim()}`,
    );
  }

  const logFile = join(options.home, "logs", "engine.log");
  await mkdir(dirname(logFile), { recursive: true });
  const log = openSync(logFile, "a");
  const child = spawn(binary, ["run", "--config", configFile], {
    // Its own process group: a Ctrl+C reaches the application, which
    // then stops the engine in order.
    detached: true,
    stdio: ["ignore", log, log],
    env: childEnv,
  });
  closeSync(log);
  const pidFile = join(dataDir, "engine.pid");
  await writeFile(pidFile, `${child.pid}\n`);
  const exited = exitOf(child).then(async (code) => {
    await rm(pidFile, { force: true });
    return code;
  });

  const url = `http://127.0.0.1:${port}`;
  const secretFile = join(dataDir, "interface-secret");
  try {
    await waitReady({
      url,
      secretFile,
      exited,
      logFile,
      timeoutMs: options.readyTimeoutMs ?? 60_000,
    });
  } catch (error) {
    await stopChild(child, exited);
    throw error;
  }

  return {
    url,
    secretFile,
    config,
    logFile,
    exited,
    stop: () => stopChild(child, exited),
  };
}

async function waitReady(options: {
  url: string;
  secretFile: string;
  exited: Promise<number | null>;
  logFile: string;
  timeoutMs: number;
}) {
  let gone: number | null | undefined;
  void options.exited.then((code) => (gone = code));
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (gone !== undefined) {
      throw new EngineLaunchError(
        `The engine exited with code ${gone} while starting; see ${options.logFile}.`,
      );
    }
    const secret = await readFile(options.secretFile, "utf8").catch(() => "");
    // The engine renames the file into place whole; anything else is not a secret.
    if (/^[0-9a-f]{64}$/.test(secret.trim())) {
      const answered = await fetch(`${options.url}/v1/health`, {
        headers: { authorization: `Bearer ${secret.trim()}` },
      }).then(
        (response) => response.ok,
        () => false,
      );
      if (answered) return;
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new EngineLaunchError(
    `The engine did not answer within ${options.timeoutMs / 1000} seconds; see ${options.logFile}.`,
  );
}

async function stopChild(child: ChildProcess, exited: Promise<unknown>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
  await exited;
  clearTimeout(timer);
}

function exitOf(child: ChildProcess): Promise<number | null> {
  return once(child, "exit").then(([code]) => code as number | null);
}

/** An engine left running by an application that was killed. */
async function stopOrphan(pidFile: string) {
  const text = await readFile(pidFile, "utf8").catch(() => null);
  const pid = Number(text);
  if (!text || !Number.isSafeInteger(pid) || pid <= 0) return;
  const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(
    () => "",
  );
  if (cmdline.includes("tripwire-engine") || cmdline.includes("\0run\0")) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    for (let i = 0; i < 60 && alive(pid); i++) {
      await new Promise((done) => setTimeout(done, 250));
    }
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
  await rm(pidFile, { force: true });
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

function run(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(binary, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", fail);
    child.once("close", (code) => done({ code, stdout, stderr }));
  });
}
