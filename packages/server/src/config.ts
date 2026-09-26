import { chmod, copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { chains } from "@tripwire/shared";
import { join } from "node:path";

/**
 * The application's configuration, `TRIPWIRE_HOME/config.json`
 * (`ENGINE.md`, Configuration): the database (`DATABASE.md`) and
 * everything the engine is configured with. `chain` is absent until first
 * run saves it; every other member takes its default when absent.
 */

export interface ChainConfig {
  chainId: number;
  /** A literal URL or `env:NAME`. */
  rpcHttp: string;
  rpcWs: string | null;
  pollIntervalMs: number;
  /** Both set, or both null for the chain's known deployment. */
  controllerAddress: string | null;
  controllerDeployedBlock: number | null;
}

export interface ResponseConfig {
  mode: "notify" | "prepare" | "send";
  key: string | null;
  maxFeeGwei: number | null;
  maxPriorityFeeGwei: number | null;
  replacementBlocks: number;
  maxAttempts: number;
  submission: "private" | "private_strict" | "public";
  privateEndpoints: string[] | null;
}

export interface AppConfig {
  version: 1;
  database: { mode: "local" } | { mode: "external"; url: string };
  chain: ChainConfig | null;
  response: ResponseConfig;
  retention: { pointsDays: number; notificationsDays: number };
  mempool: { enabled: boolean; respond: boolean };
}

/** A configuration refused, naming the member and the rule. */
export class ConfigError extends Error {
  readonly code = "config_invalid";
  constructor(
    readonly member: string,
    rule: string,
  ) {
    super(`${member}: ${rule}`);
  }
}

export const CHAIN_DEFAULTS = {
  rpcWs: null,
  pollIntervalMs: 2000,
  controllerAddress: null,
  controllerDeployedBlock: null,
} as const;

export function defaultConfig(): AppConfig {
  return {
    version: 1,
    database: { mode: "local" },
    chain: null,
    response: {
      mode: "notify",
      key: null,
      maxFeeGwei: null,
      maxPriorityFeeGwei: null,
      replacementBlocks: 5,
      maxAttempts: 3,
      submission: "private",
      privateEndpoints: null,
    },
    retention: { pointsDays: 90, notificationsDays: 90 },
    mempool: { enabled: false, respond: false },
  };
}

/** The chains first run offers by name (`FIRST-RUN.md`). */
export const KNOWN_CHAINS = chains;

/** Known TripwireController deployments (`RESPONSES.md`), with the block each was deployed at. */
export const CONTROLLER_DEPLOYMENTS: Record<
  number,
  { address: string; block: number }
> = {
  1: { address: "0x328aed8f7a01f45a959c187f3cb97ec508064854", block: 25141731 },
};

/** The controller the engine mirrors: the configured one, else the chain's known deployment. */
export function controllerOf(
  chain: ChainConfig,
): { address: string; block: number } | null {
  if (chain.controllerAddress !== null) {
    return {
      address: chain.controllerAddress.toLowerCase(),
      block: chain.controllerDeployedBlock ?? 0,
    };
  }
  return CONTROLLER_DEPLOYMENTS[chain.chainId] ?? null;
}

type Raw = Record<string, unknown>;

function object(value: unknown, member: string): Raw {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(member, "must be an object");
  }
  return value as Raw;
}

function only(raw: Raw, member: string, known: string[]) {
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) {
      throw new ConfigError(
        member ? `${member}.${key}` : key,
        "is not a known member",
      );
    }
  }
}

function integer(
  value: unknown,
  member: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new ConfigError(
      member,
      max === Number.MAX_SAFE_INTEGER
        ? `must be an integer, ${min} or more`
        : `must be an integer, ${min} to ${max}`,
    );
  }
  return value;
}

function url(value: unknown, member: string, schemes: string[]): string {
  if (typeof value === "string") {
    if (/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return value;
    try {
      const parsed = new URL(value);
      if (schemes.includes(parsed.protocol.slice(0, -1)) && parsed.host) {
        return value;
      }
    } catch {
      // Refused below.
    }
  }
  throw new ConfigError(
    member,
    `must be a ${schemes.map((s) => `${s}://`).join(" or ")} URL, or env:NAME`,
  );
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function parseChain(value: unknown): ChainConfig {
  const raw = object(value, "chain");
  only(raw, "chain", [
    "chainId",
    "rpcHttp",
    "rpcWs",
    "pollIntervalMs",
    "controllerAddress",
    "controllerDeployedBlock",
  ]);
  const address = raw.controllerAddress ?? null;
  const block = raw.controllerDeployedBlock ?? null;
  if ((address === null) !== (block === null)) {
    throw new ConfigError(
      "chain.controllerAddress",
      "and chain.controllerDeployedBlock are both set or both null",
    );
  }
  if (
    address !== null &&
    (typeof address !== "string" || !ADDRESS.test(address))
  ) {
    throw new ConfigError("chain.controllerAddress", "must be an address");
  }
  return {
    chainId: integer(raw.chainId, "chain.chainId", 1),
    rpcHttp: url(raw.rpcHttp, "chain.rpcHttp", ["http", "https"]),
    rpcWs:
      raw.rpcWs === undefined || raw.rpcWs === null
        ? null
        : url(raw.rpcWs, "chain.rpcWs", ["ws", "wss"]),
    pollIntervalMs:
      raw.pollIntervalMs === undefined
        ? CHAIN_DEFAULTS.pollIntervalMs
        : integer(raw.pollIntervalMs, "chain.pollIntervalMs", 100, 60000),
    controllerAddress: address,
    controllerDeployedBlock:
      block === null
        ? null
        : integer(block, "chain.controllerDeployedBlock", 0),
  };
}

function parseResponse(value: unknown): ResponseConfig {
  const defaults = defaultConfig().response;
  if (value === undefined) return defaults;
  const raw = object(value, "response");
  only(raw, "response", Object.keys(defaults));
  const r = { ...defaults, ...raw } as Raw;
  if (r.mode !== "notify" && r.mode !== "prepare" && r.mode !== "send") {
    throw new ConfigError("response.mode", "must be notify, prepare or send");
  }
  if (r.key !== null && (typeof r.key !== "string" || !ADDRESS.test(r.key))) {
    throw new ConfigError("response.key", "must be an address or null");
  }
  const maxFee =
    r.maxFeeGwei === null
      ? null
      : integer(r.maxFeeGwei, "response.maxFeeGwei", 1);
  const priority =
    r.maxPriorityFeeGwei === null
      ? null
      : integer(r.maxPriorityFeeGwei, "response.maxPriorityFeeGwei", 0);
  // The engine's defaults stand in for whichever is null.
  if ((priority ?? 2) > (maxFee ?? 100)) {
    throw new ConfigError(
      "response.maxPriorityFeeGwei",
      "may not exceed the maximum fee",
    );
  }
  if (
    r.submission !== "private" &&
    r.submission !== "private_strict" &&
    r.submission !== "public"
  ) {
    throw new ConfigError(
      "response.submission",
      "must be private, private_strict or public",
    );
  }
  let endpoints: string[] | null = null;
  if (r.privateEndpoints !== null) {
    if (!Array.isArray(r.privateEndpoints) || r.privateEndpoints.length === 0) {
      throw new ConfigError(
        "response.privateEndpoints",
        "must be a non-empty list of URLs, or null",
      );
    }
    endpoints = r.privateEndpoints.map((e, i) =>
      url(e, `response.privateEndpoints[${i}]`, ["http", "https"]),
    );
  }
  return {
    mode: r.mode,
    key: r.key,
    maxFeeGwei: maxFee,
    maxPriorityFeeGwei: priority,
    replacementBlocks: integer(
      r.replacementBlocks,
      "response.replacementBlocks",
      1,
    ),
    maxAttempts: integer(r.maxAttempts, "response.maxAttempts", 1),
    submission: r.submission,
    privateEndpoints: endpoints,
  };
}

/** Validates a configuration as read from the file, filling in the defaults. */
export function parseConfig(value: unknown): AppConfig {
  const raw = object(value, "config.json");
  only(raw, "", [
    "version",
    "database",
    "chain",
    "response",
    "retention",
    "mempool",
  ]);
  if (raw.version !== 1) throw new ConfigError("version", "must be 1");
  const defaults = defaultConfig();

  let database = defaults.database;
  if (raw.database !== undefined) {
    const d = object(raw.database, "database");
    only(d, "database", ["mode", "url"]);
    if (d.mode === "local" && d.url === undefined) database = { mode: "local" };
    else if (d.mode === "external" && typeof d.url === "string" && d.url) {
      database = { mode: "external", url: d.url };
    } else {
      throw new ConfigError(
        "database",
        'needs mode "local", or mode "external" with a url',
      );
    }
  }

  const chain =
    raw.chain === undefined || raw.chain === null
      ? null
      : parseChain(raw.chain);

  let retention = defaults.retention;
  if (raw.retention !== undefined) {
    const r = object(raw.retention, "retention");
    only(r, "retention", ["pointsDays", "notificationsDays"]);
    retention = {
      pointsDays: integer(
        r.pointsDays ?? retention.pointsDays,
        "retention.pointsDays",
        7,
      ),
      notificationsDays: integer(
        r.notificationsDays ?? retention.notificationsDays,
        "retention.notificationsDays",
        7,
      ),
    };
  }

  let mempool = defaults.mempool;
  if (raw.mempool !== undefined) {
    const m = object(raw.mempool, "mempool");
    only(m, "mempool", ["enabled", "respond"]);
    const enabled = m.enabled ?? false;
    const respond = m.respond ?? false;
    if (typeof enabled !== "boolean" || typeof respond !== "boolean") {
      throw new ConfigError("mempool", "enabled and respond are true or false");
    }
    if (enabled && !chain?.rpcWs) {
      throw new ConfigError("mempool.enabled", "needs chain.rpcWs");
    }
    if (respond && !enabled) {
      throw new ConfigError("mempool.respond", "needs mempool.enabled");
    }
    mempool = { enabled, respond };
  }

  return {
    version: 1,
    database,
    chain,
    response: parseResponse(raw.response),
    retention,
    mempool,
  };
}

/** The file's form: `chain` is left out until it is set. */
export function configJson(config: AppConfig): string {
  const { chain, ...rest } = config;
  return `${JSON.stringify(chain ? { ...rest, chain } : rest, null, 2)}\n`;
}

export function configPath(home: string): string {
  return join(home, "config.json");
}

/** The configuration, or the defaults when the file does not exist yet. */
export async function loadConfig(home: string): Promise<AppConfig> {
  const path = configPath(home);
  const text = await readFile(path, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (text === null) return defaultConfig();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError("config.json", "is not JSON");
  }
  return parseConfig(parsed);
}

/**
 * Writes the configuration after validating it: the current file is kept
 * as `config.json.previous`, and the new one is staged and renamed into
 * place, mode 0600.
 */
export async function saveConfig(home: string, config: AppConfig) {
  const text = configJson(parseConfig(JSON.parse(configJson(config))));
  const path = configPath(home);
  await copyFile(path, `${path}.previous`).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  const staged = `${path}.${process.pid}`;
  await writeFile(staged, text, { mode: 0o600 });
  await chmod(staged, 0o600);
  await rename(staged, path);
}

/** Puts `config.json.previous` back, after a change the engine refused. */
export async function restorePreviousConfig(home: string) {
  const path = configPath(home);
  await rename(`${path}.previous`, path);
}

/** Resolves an `env:NAME` reference; a literal value is returned as it is. */
export function resolveValue(
  value: string,
  env: NodeJS.ProcessEnv,
  member: string,
): string {
  const name = /^env:(.+)$/.exec(value)?.[1];
  if (!name) return value;
  const resolved = env[name];
  if (!resolved) {
    throw new ConfigError(member, `reads ${name}, which is not set`);
  }
  return resolved;
}

/** A URL as it may be shown or logged: scheme and host, the rest masked. */
export function maskUrl(value: string): string {
  if (value.startsWith("env:")) return value;
  try {
    const parsed = new URL(value);
    const hidden = parsed.pathname.length > 1 || parsed.search ? "/…" : "";
    return `${parsed.protocol}//${parsed.host}${hidden}`;
  } catch {
    return "(not a URL)";
  }
}

/** Masks every URL inside a message, such as the engine's own error text. */
export function maskUrls(text: string): string {
  return text.replace(/\b(?:https?|wss?):\/\/[^\s)"'<>,]+/g, (found) =>
    maskUrl(found),
  );
}
