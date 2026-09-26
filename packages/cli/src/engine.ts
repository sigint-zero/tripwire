import {
  AccountError,
  CHAIN_DEFAULTS,
  ConfigError,
  EngineReleaseError,
  engineTarget,
  installedVersions,
  installEngine,
  KNOWN_CHAINS,
  loadConfig,
  maskUrl,
  parseConfig,
  preflight,
  readLogTail,
  readPid,
  runLockHolder,
  saveConfig,
  Users,
  verifyChain,
  type AppConfig,
  type ChainConfig,
  type EnginePin,
} from "@tripwire/server";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { askPassword } from "./users";

// `tripwire engine …` and `tripwire setup` (`ENGINE.md`, Command line;
// `FIRST-RUN.md`, Command line). Both work with the server stopped, on
// the files under TRIPWIRE_HOME, so a machine with no browser can be set
// up and inspected entirely from here.

export function readPin(): EnginePin {
  return JSON.parse(
    readFileSync(new URL("./engine.json", import.meta.url), "utf8"),
  ) as EnginePin;
}

type Fail = (message: string) => never;

/** A download's progress on one line, when there is a terminal to redraw. */
function progressLine(label: string) {
  let last = 0;
  return {
    update({ bytes, total }: { bytes: number; total: number | null }) {
      const now = Date.now();
      if (!process.stdout.isTTY || now - last < 100) return;
      last = now;
      const mb = (n: number) => (n / 1_048_576).toFixed(1);
      process.stdout.write(
        `\r${label}  ${mb(bytes)}${total ? ` of ${mb(total)}` : ""} MB   `,
      );
    },
    done() {
      if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
    },
  };
}

async function install(home: string, pin: EnginePin) {
  const bar = progressLine(`Downloading engine ${pin.version}`);
  try {
    return await installEngine({
      home,
      pin,
      onProgress: (p) => bar.update(p),
    });
  } finally {
    bar.done();
  }
}

export async function engineCommand(
  home: string,
  args: string[],
  options: { lines?: string; follow?: boolean },
  fail: Fail,
) {
  const pin = readPin();
  const [verb, ...extra] = args;
  if (extra.length > 0) fail(`Unexpected: ${extra.join(" ")}`);
  switch (verb) {
    case "install": {
      try {
        const installed = await install(home, pin);
        console.log(
          `Engine ${installed.version} is installed and verified: ${installed.binary}`,
        );
      } catch (error) {
        if (error instanceof EngineReleaseError) fail(error.message);
        throw error;
      }
      return;
    }
    case "status": {
      await status(home, pin);
      return;
    }
    case "log": {
      const n = Number(options.lines ?? 50);
      if (!Number.isInteger(n) || n < 1) fail(`Invalid -n: ${options.lines}`);
      const path = join(home, "logs", "engine.log");
      for (const line of readLogTail(path, n)) console.log(line);
      if (options.follow) await follow(path);
      return;
    }
    default:
      fail(`Unknown command: engine ${args.join(" ")}`);
  }
}

async function status(home: string, pin: EnginePin) {
  let target: string | null = null;
  try {
    target = engineTarget();
  } catch (error) {
    console.log((error as Error).message);
  }
  console.log(`Pinned engine: ${pin.version}${target ? ` (${target})` : ""}`);
  const versions = target ? await installedVersions(home, pin, target) : [];
  if (versions.length === 0) {
    console.log("Installed: none. Run: tripwire engine install");
  }
  for (const v of versions) {
    console.log(
      `Installed: ${v.version}  ${v.verified ? "verified" : `does not verify: ${v.problem}`}`,
    );
  }

  let config: AppConfig | null = null;
  try {
    config = await loadConfig(home);
  } catch (error) {
    console.log(`config.json: ${(error as Error).message}`);
  }
  if (config) {
    console.log(
      config.chain
        ? `Chain: ${chainName(config.chain.chainId)} (${config.chain.chainId}) via ${maskUrl(config.chain.rpcHttp)}${config.chain.rpcWs ? `, WebSocket ${maskUrl(config.chain.rpcWs)}` : ""}`
        : "Chain: not configured. Run: tripwire setup",
    );
    console.log(`Response mode: ${config.response.mode}`);
  }

  const server = await runLockHolder(home);
  const engine = await readPid(join(home, "engine", "engine.pid"));
  const engineAlive = engine ? isAlive(engine.pid) : false;
  console.log(
    `Server: ${server ? `running as process ${server}` : "not running"}`,
  );
  console.log(
    `Engine: ${
      engine && engineAlive
        ? `running as process ${engine.pid}${engine.startedAt ? ` since ${engine.startedAt}` : ""}`
        : "not running"
    }`,
  );

  const lines = readLogTail(join(home, "logs", "engine.log"), 20);
  if (lines.length > 0) {
    console.log("\nLast log lines:");
    for (const line of lines) console.log(`  ${line}`);
  }
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Prints what is appended to the log until Ctrl+C, following rotation. */
async function follow(path: string) {
  let offset = existsSync(path) ? statSync(path).size : 0;
  const read = () => {
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    if (size < offset) offset = 0; // rotated
    if (size === offset) return;
    const text = readFileSync(path).subarray(offset, size).toString("utf8");
    offset = size;
    process.stdout.write(text);
  };
  const dir = join(path, "..");
  watch(dir, () => read());
  setInterval(read, 1000);
  await new Promise(() => {});
}

export function chainName(id: number): string {
  return KNOWN_CHAINS.find((c) => c.id === id)?.name ?? `Chain ${id}`;
}

/** A chain given by id or by name. */
export function chainIdOf(value: string): number | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const found = KNOWN_CHAINS.find(
    (c) =>
      c.name.toLowerCase().replace(/\s+/g, "") ===
      trimmed.toLowerCase().replace(/[\s_-]+/g, ""),
  );
  return found?.id ?? null;
}

/** The lines Verify prints, as the dashboard shows them. */
export function verifyLines(
  result: Awaited<ReturnType<typeof verifyChain>>,
  wanted: number,
): string[] {
  const lines: string[] = [];
  const wrong = result.problems.find((p) => p.code === "wrong_chain");
  lines.push(
    wrong
      ? `✗ ${wrong.message}`
      : result.ok || result.head !== null
        ? `✓ The endpoint serves ${chainName(wanted)} (${wanted})`
        : `✗ The endpoint could not be checked`,
  );
  if (result.receipts) lines.push(`✓ Receipts: ${result.receipts}`);
  if (result.head !== null) {
    lines.push(`✓ Latest block: ${result.head.toLocaleString("en-US")}`);
  }
  if (result.ws) {
    lines.push(
      result.ws.ok && result.ws.pending
        ? "✓ Pending transactions: subscribed"
        : "✗ Pending transactions: the WebSocket did not subscribe",
    );
  }
  for (const p of result.problems) {
    if (p.code !== "wrong_chain") lines.push(`✗ ${p.message}`);
  }
  return lines;
}

export interface SetupOptions {
  username?: string;
  chainId?: string;
  rpcHttp?: string;
  rpcWs?: string;
  databaseUrl?: string;
  skipVerify?: boolean;
}

/**
 * `tripwire setup`: the database, the account and the chain, then stop;
 * `tripwire start` runs everything. Prompts for what no flag gives when
 * there is a terminal; without one, fails naming the missing flag.
 */
export async function setupCommand(
  home: string,
  options: SetupOptions,
  fail: Fail,
) {
  const users = new Users(home);
  const existing = await loadConfig(home).catch((error: unknown) => {
    if (error instanceof ConfigError) fail(`config.json: ${error.message}`);
    throw error;
  });
  const accounts = await users.all();
  const exists = [
    ...(accounts.length > 0
      ? [`an account (${accounts.map((u) => u.username).join(", ")})`]
      : []),
    ...(existing.chain
      ? [`a chain (${chainName(existing.chain.chainId)})`]
      : []),
  ];
  if (exists.length > 0) {
    fail(
      `This installation already has ${exists.join(" and ")}. Setup runs once; accounts change with tripwire user.`,
    );
  }

  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  // Reopened after the password, which reads the terminal with echo off.
  let rl = tty
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null;
  const ask = async (
    flag: string,
    given: string | undefined,
    question: string,
    fallback?: string,
  ): Promise<string> => {
    if (given !== undefined) return given;
    if (!rl) {
      if (fallback !== undefined) return fallback;
      fail(`--${flag} is required when there is no terminal to ask on.`);
    }
    const answer = (await rl.question(question)).trim();
    return answer || fallback || ask(flag, undefined, question, fallback);
  };

  try {
    // 1. The database.
    const databaseAnswer = await ask(
      "database-url",
      options.databaseUrl,
      "Database: local, or a PostgreSQL URL [local]: ",
      "local",
    );
    const database: AppConfig["database"] =
      databaseAnswer === "local"
        ? { mode: "local" }
        : { mode: "external", url: databaseAnswer };
    if (database.mode === "external") {
      const name = /^env:(.+)$/.exec(database.url)?.[1];
      const url = name ? process.env[name] : database.url;
      if (!url) fail(`--database-url reads ${name}, which is not set.`);
      try {
        await preflight(url);
      } catch (error) {
        fail((error as Error).message);
      }
      console.log("✓ The database answers and Tripwire may create its schemas");
    }

    // 2. The account, created last so a failure below leaves nothing behind.
    const username = await ask("username", options.username, "Username: ");
    rl?.close();
    const password = await askPassword("Password (12 characters or more): ");
    if (process.env.TRIPWIRE_PASSWORD === undefined) {
      if ((await askPassword("Again: ")) !== password) {
        fail("The passwords do not match.");
      }
    }
    if (password.length < 12) fail("The password needs 12 characters or more.");
    rl = tty
      ? createInterface({ input: process.stdin, output: process.stdout })
      : null;

    // 3. The chain, checked before anything is written.
    const chainAnswer = await ask(
      "chain-id",
      options.chainId,
      `Chain (${KNOWN_CHAINS.map((c) => c.name).join(", ")}, or an id): `,
    );
    const chainId = chainIdOf(chainAnswer);
    if (chainId === null) fail(`Unknown chain: ${chainAnswer}. Give its id.`);
    const rpcHttp = await ask(
      "rpc-http",
      options.rpcHttp,
      "RPC endpoint (HTTP URL, or env:NAME): ",
    );
    const rpcWs = await ask(
      "rpc-ws",
      options.rpcWs,
      "WebSocket endpoint, to watch pending transactions (Enter to skip): ",
      "",
    );
    let chain: ChainConfig;
    try {
      chain = parseConfig({
        version: 1,
        chain: {
          ...CHAIN_DEFAULTS,
          chainId,
          rpcHttp,
          rpcWs: rpcWs || null,
        },
      }).chain!;
    } catch (error) {
      fail((error as Error).message);
    }

    if (!options.skipVerify) {
      const pin = readPin();
      let binary: string;
      try {
        binary = (await install(home, pin)).binary;
      } catch (error) {
        if (error instanceof EngineReleaseError) {
          fail(
            `${error.message}\n\nOr set up without checking the endpoint: --skip-verify`,
          );
        }
        throw error;
      }
      const result = await verifyChain({ binary, chain, env: process.env });
      for (const line of verifyLines(result, chainId)) console.log(line);
      if (!result.ok) fail("The endpoint did not verify; nothing was written.");
    }

    try {
      await users.add(username, password);
    } catch (error) {
      if (error instanceof AccountError) fail(error.message);
      throw error;
    }

    await saveConfig(home, {
      ...existing,
      database,
      chain,
      mempool: { enabled: Boolean(chain.rpcWs), respond: false },
    });
    console.log(
      `\nSet up: account "${username}", ${chainName(chainId)} via ${maskUrl(rpcHttp)}${database.mode === "external" ? ", an external database" : ", a local database"}.\nStart Tripwire with: tripwire start`,
    );
  } finally {
    rl?.close();
  }
}
