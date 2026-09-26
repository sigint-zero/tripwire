import type { EngineInfo, EngineStatus } from "@tripwire/shared";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ConfigError,
  loadConfig,
  maskUrls,
  parseConfig,
  restorePreviousConfig,
  saveConfig,
  type AppConfig,
  type ChainConfig,
} from "../config";
import { EngineDownloadError, installEngine, pruneVersions } from "./install";
import {
  engineEnvironment,
  engineToml,
  freePort,
  readSecret,
  runEngine,
  sleep,
  spawnEngine,
  stopEngine,
  stopOrphan,
  verifyChain,
  withEnvironmentChain,
  writePid,
  writeWhole,
  type SpawnedEngine,
  type VerifyResult,
} from "./launch";
import { EngineLog } from "./log";
import {
  EngineReleaseError,
  engineTarget,
  verifiedEngine,
  type EnginePin,
  type InstalledEngine,
} from "./release";

/**
 * The application as the engine's supervisor (`ENGINE.md`, Supervision):
 * it installs the pinned release, starts it from `config.json`, restarts
 * it by exit code, kills it when it hangs, applies configuration with a
 * way back, and stops it in order. Health itself is the monitor's; the
 * supervisor says what the process is doing.
 */

/** What the process is doing; `running` defers to the engine's own health. */
export type SupervisorPhase =
  | "unconfigured"
  | "installing"
  | "starting"
  | "running"
  | "restarting"
  | "failed"
  | "stopped";

export type EngineAlert =
  | { kind: "stopped"; message: string }
  | { kind: "repeated"; message: string }
  | { kind: "cannot_start"; message: string };

export interface SupervisorListener {
  phase?(phase: SupervisorPhase): void;
  alert?(alert: EngineAlert): void;
}

/** A configuration change the engine would not run on; the previous one is back. */
export class SettingsRejected extends Error {
  readonly code = "settings_rejected";
}

/** Another change is being applied. */
export class SettingsBusy extends Error {
  readonly code = "settings_busy";
}

export interface SupervisorTiming {
  backoffStartMs: number;
  backoffMaxMs: number;
  /** Running this long resets the backoff. */
  steadyMs: number;
  /** Code 70: how often to try again, and for how long before it counts. */
  leaseRetryMs: number;
  leaseGiveUpMs: number;
  /** Health unanswered this long: killed and restarted. */
  killAfterMs: number;
  stopGraceMs: number;
  /** How long a configuration change may take to reach ready. */
  applyWaitMs: number;
  /** How long to wait for the secret after a spawn. */
  secretWaitMs: number;
}

const TIMING: SupervisorTiming = {
  backoffStartMs: 1_000,
  backoffMaxMs: 60_000,
  steadyMs: 10 * 60_000,
  leaseRetryMs: 10_000,
  leaseGiveUpMs: 90_000,
  killAfterMs: 120_000,
  stopGraceMs: 15_000,
  applyWaitMs: 60_000,
  secretWaitMs: 120_000,
};

const REPEATED_WINDOW_MS = 10 * 60_000;

/** What an exit means (`ENGINE.md`, Restart policy, and G3). */
export function exitPolicy(
  code: number | null,
  lines: string[],
): "failed" | "lease" | "port" | "restart" {
  if (code === 78 || code === 65) return "failed";
  if (code === 70) return "lease";
  if (
    code === 1 &&
    lines.some((l) => l.includes("cannot bind the control interface"))
  ) {
    return "port";
  }
  return "restart";
}

export class EngineSupervisor {
  /** Read by the routes; updated in place when the configuration changes. */
  readonly info: EngineInfo;
  readonly log: EngineLog;
  readonly pin: EnginePin;
  readonly home: string;

  readonly #databaseUrl: string;
  readonly #local: boolean;
  readonly #env: NodeJS.ProcessEnv;
  readonly #target: string | null;
  readonly #timing: SupervisorTiming;
  readonly #clock: () => number;
  readonly #listeners = new Set<SupervisorListener>();

  #config: AppConfig | null = null;
  #phase: SupervisorPhase = "stopped";
  #since: number;
  #problem: EngineStatus["problem"] = null;
  #lastExit: EngineStatus["lastExit"] = null;
  #install: EngineStatus["install"] = null;
  #unplanned: number[] = [];
  #total = 0;
  #repeatedRaised = false;

  #installed: InstalledEngine | null = null;
  #installing: Promise<InstalledEngine> | null = null;
  #engine: SpawnedEngine | null = null;
  #url: string | null = null;
  #secret: string | null = null;
  #spawnedAt = 0;
  #readyOnce = false;
  #backoff: number;
  #timer: NodeJS.Timeout | null = null;
  /** Counts runs, so a stale exit handler knows it is stale. */
  #generation = 0;
  #shuttingDown = false;
  #planned = false;
  #applying = false;
  #leaseSince: number | null = null;
  #newPort = true;
  #port = 0;

  constructor(options: {
    home: string;
    pin: EnginePin;
    databaseUrl: string;
    local: boolean;
    env?: NodeJS.ProcessEnv;
    target?: string;
    timing?: Partial<SupervisorTiming>;
    clock?: () => number;
  }) {
    this.home = options.home;
    this.pin = options.pin;
    this.#databaseUrl = options.databaseUrl;
    this.#local = options.local;
    this.#env = options.env ?? process.env;
    this.#timing = { ...TIMING, ...options.timing };
    this.#clock = options.clock ?? Date.now;
    this.#since = this.#clock();
    this.#backoff = this.#timing.backoffStartMs;
    let target: string | null = null;
    try {
      target = options.target ?? engineTarget();
    } catch {
      // Reported as failed at start.
    }
    this.#target = target;
    this.info = { chainId: 0, responseMode: "notify", simulated: false };
    this.log = new EngineLog(join(this.home, "logs", "engine.log"));
  }

  get phase(): SupervisorPhase {
    return this.#phase;
  }

  get config(): AppConfig | null {
    return this.#config;
  }

  /** Where the running engine answers, once it has written its secret. */
  current(): { url: string; secret: string } | null {
    return this.#phase === "running" && this.#url && this.#secret
      ? { url: this.#url, secret: this.#secret }
      : null;
  }

  /** What the supervisor adds to `GET /engine`. */
  report() {
    const now = this.#clock();
    return {
      since: new Date(this.#since).toISOString(),
      pinnedVersion: this.pin.version,
      install: this.#install,
      restarts: {
        last10Minutes: this.#unplanned.filter(
          (t) => now - t < REPEATED_WINDOW_MS,
        ).length,
        total: this.#total,
      },
      lastExit: this.#lastExit,
      problem: this.#problem,
    };
  }

  listen(listener: SupervisorListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Loads the configuration and brings the engine up in the background.
   * Resolves once the first step is under way, never waiting for ready.
   */
  async start(): Promise<void> {
    await mkdir(join(this.home, "engine"), { recursive: true, mode: 0o700 });
    if (await stopOrphan(join(this.home, "engine", "engine.pid"))) {
      this.log.tripwire("stopped an engine a previous server left running");
    }
    try {
      this.#config = withEnvironmentChain(
        await loadConfig(this.home),
        this.#env,
      );
    } catch (error) {
      this.#fail("config_invalid", messageOf(error));
      return;
    }
    this.#applyInfo(this.#config);
    if (!this.#target) {
      this.#fail("platform", unsupported());
      return;
    }
    if (!this.#config.chain) {
      this.#enter("unconfigured");
      // The download starts early, while a person makes an account.
      void this.#ensureInstalled().catch(() => {});
      return;
    }
    void this.#run(this.#generation);
  }

  /** Stops the engine for good: SIGTERM, then SIGKILL after the grace. */
  async stop(): Promise<void> {
    this.#shuttingDown = true;
    this.#clearTimer();
    this.#generation++;
    await this.#stopProcess("stopped as the server shuts down");
    this.#enter("stopped");
    this.log.close();
  }

  /** A planned restart, or from failed a retry of the install or the start. */
  async restart(by: string): Promise<void> {
    if (this.#phase === "unconfigured") {
      throw new SettingsRejected(
        "There is no chain configured to start the engine on.",
      );
    }
    this.log.tripwire(`restart requested by ${by}`);
    this.#clearTimer();
    const generation = ++this.#generation;
    await this.#stopProcess("stopped for a restart");
    this.#problem = null;
    this.#backoff = this.#timing.backoffStartMs;
    if (!this.#config?.chain) {
      try {
        this.#config = withEnvironmentChain(
          await loadConfig(this.home),
          this.#env,
        );
        this.#applyInfo(this.#config);
      } catch (error) {
        this.#fail("config_invalid", messageOf(error));
        return;
      }
    }
    void this.#run(generation);
  }

  /** Called by the monitor each time health goes unanswered. */
  unanswered(ms: number) {
    if (this.#phase !== "running" || !this.#engine) return;
    if (ms < this.#timing.killAfterMs) return;
    this.log.tripwire(
      `health unanswered for ${Math.round(ms / 1000)} s: killed`,
    );
    this.#engine.child.kill("SIGKILL");
  }

  /** Called by the monitor when the engine reports ready. */
  ready() {
    if (this.#readyOnce) return;
    this.#readyOnce = true;
    this.#problem = null;
    this.#leaseSince = null;
    void pruneVersions(this.home, this.pin).catch(() => {});
  }

  /** The engine's verify invocation (G2) on proposed values; saves nothing. */
  async verify(chain: ChainConfig): Promise<VerifyResult> {
    const installed = await this.#ensureInstalled();
    return verifyChain({ binary: installed.binary, chain, env: this.#env });
  }

  /**
   * Applies a configuration (`ENGINE.md`, Applying configuration): keep
   * the previous one, write the new one, restart, and wait for ready or
   * degraded. When the engine does not get there, the previous one comes
   * back and the engine's own words are the error.
   */
  async apply(next: AppConfig, isWatching: () => boolean): Promise<void> {
    if (this.#applying) {
      throw new SettingsBusy("Another settings change is being applied.");
    }
    this.#applying = true;
    try {
      const config = parseConfig(JSON.parse(JSON.stringify(next)));
      if (
        this.#config?.chain &&
        config.chain &&
        config.chain.chainId !== this.#config.chain.chainId
      ) {
        throw new ConfigError(
          "chain.chainId",
          "is fixed once set: another chain is another installation",
        );
      }
      await saveConfig(this.home, config);
      this.log.tripwire(
        "configuration saved; restarting the engine to apply it",
      );
      const failure = await this.#restartAndWait(config, isWatching);
      if (!failure) {
        this.log.tripwire("configuration applied");
        return;
      }
      this.log.tripwire(
        "the engine did not run on the new configuration; rolling back",
      );
      await restorePreviousConfig(this.home).catch(async () => {
        // No previous file: the first chain. Without it, nothing runs.
        await rm(join(this.home, "config.json"), { force: true });
      });
      const previous = await loadConfig(this.home);
      if (previous.chain) {
        await this.#restartAndWait(previous, isWatching);
      } else {
        this.#clearTimer();
        this.#generation++;
        await this.#stopProcess("stopped: the chain was not applied");
        this.#config = previous;
        this.#applyInfo(previous);
        this.#problem = null;
        this.#enter("unconfigured");
      }
      throw new SettingsRejected(failure);
    } finally {
      this.#applying = false;
    }
  }

  async #restartAndWait(
    config: AppConfig,
    isWatching: () => boolean,
  ): Promise<string | null> {
    this.#clearTimer();
    const generation = ++this.#generation;
    this.#planned = true;
    await this.#stopProcess("stopped to apply a configuration");
    this.#planned = false;
    this.#config = config;
    this.#applyInfo(config);
    this.#problem = null;
    this.#readyOnce = false;
    const mark = this.log.mark();
    void this.#run(generation);
    const deadline = this.#clock() + this.#timing.applyWaitMs;
    let leaseWait = 0;
    while (this.#clock() < deadline + leaseWait) {
      await sleep(250);
      if (generation !== this.#generation) return "Another change took over.";
      if (this.#phase === "running" && isWatching()) return null;
      // Waiting out another engine's lease does not count against it.
      if (this.#leaseSince !== null) leaseWait += 250;
      if (this.#phase === "failed" || this.#phase === "restarting") break;
    }
    const lines = this.log
      .since(mark)
      .filter((l) => !l.startsWith("[tripwire]"))
      .slice(-12);
    return maskUrls(
      (this.#problem as EngineStatus["problem"])?.message ??
        (lines.length > 0
          ? lines.join("\n")
          : "The engine did not become ready in time."),
    );
  }

  #applyInfo(config: AppConfig) {
    this.info.chainId = config.chain?.chainId ?? 0;
    this.info.responseMode = config.response.mode;
  }

  async #ensureInstalled(): Promise<InstalledEngine> {
    if (this.#installed) return this.#installed;
    if (!this.#target) throw new EngineReleaseError(unsupported());
    this.#installing ??= (async () => {
      const found = await verifiedEngine({
        home: this.home,
        pin: this.pin,
        target: this.#target!,
      }).catch(() => null);
      if (found) return found;
      const wasPhase = this.#phase;
      if (wasPhase !== "unconfigured") this.#enter("installing");
      this.log.tripwire(`downloading engine ${this.pin.version}`);
      this.#install = { bytes: 0, total: null };
      try {
        const installed = await installEngine({
          home: this.home,
          pin: this.pin,
          target: this.#target!,
          env: this.#env,
          onProgress: (p) => (this.#install = p),
        });
        this.log.tripwire(`installed engine ${installed.version}`);
        return installed;
      } finally {
        this.#install = null;
      }
    })();
    try {
      this.#installed = await this.#installing;
      return this.#installed;
    } finally {
      this.#installing = null;
    }
  }

  async #run(generation: number): Promise<void> {
    const stale = () => generation !== this.#generation || this.#shuttingDown;
    const config = this.#config;
    if (!config?.chain) {
      this.#enter("unconfigured");
      return;
    }
    let installed: InstalledEngine;
    try {
      // A download begun while unconfigured is now what is being waited on.
      if (this.#installing) this.#enter("installing");
      installed = await this.#ensureInstalled();
    } catch (error) {
      if (stale()) return;
      if (error instanceof EngineDownloadError) {
        // The network may come back; retried on the backoff.
        this.#problem = { code: "install", message: error.message };
        this.#scheduleRestart(generation, "the download failed");
        return;
      }
      this.#fail("install", messageOf(error));
      return;
    }
    if (stale()) return;
    this.#enter("starting");

    let env: NodeJS.ProcessEnv;
    try {
      env = engineEnvironment(config.chain, this.#env, this.#databaseUrl);
    } catch (error) {
      this.#fail("config_invalid", messageOf(error));
      return;
    }
    const dataDir = join(this.home, "engine");
    if (this.#newPort || !this.#port) {
      this.#port = await freePort();
      this.#newPort = false;
    }
    const configFile = join(this.home, "engine.toml");
    await writeWhole(
      configFile,
      engineToml(
        { ...config, chain: config.chain },
        {
          dataDir,
          port: this.#port,
          local: this.#local,
          keysPassphrase: Boolean(this.#env.TRIPWIRE_KEYS_PASSPHRASE),
        },
      ),
    );

    const migrated = await runEngine(
      installed.binary,
      ["migrate", "--config", configFile],
      env,
    );
    for (const line of `${migrated.stdout}${migrated.stderr}`.split("\n")) {
      if (line.trim()) this.log.engine(line);
    }
    if (stale()) return;
    if (migrated.code !== 0) {
      const message = maskUrls(
        (migrated.stderr || migrated.stdout).trim() ||
          `the engine's migrate step exited with code ${migrated.code}`,
      );
      if (migrated.code === 75 || migrated.code === 69) {
        this.#problem = { code: "migrate", message };
        this.#scheduleRestart(generation, "the database could not be migrated");
      } else {
        this.#fail("migrate", message);
      }
      return;
    }

    const mark = this.log.mark();
    const engine = spawnEngine({
      binary: installed.binary,
      configFile,
      env,
      onLine: (line) => this.log.engine(line),
    });
    this.#engine = engine;
    this.#spawnedAt = this.#clock();
    const pidFile = join(dataDir, "engine.pid");
    if (engine.child.pid) {
      await writePid(pidFile, {
        pid: engine.child.pid,
        startedAt: new Date(this.#spawnedAt).toISOString(),
        binary: installed.binary,
      });
      this.log.tripwire(
        `spawned engine ${installed.version} (pid ${engine.child.pid})`,
      );
    }
    void engine.exited.then(async (exit) => {
      await rm(pidFile, { force: true });
      if (this.#engine === engine) {
        this.#engine = null;
        this.#url = null;
        this.#secret = null;
      }
      if (stale() || this.#planned) return;
      this.#exited(generation, exit, this.log.since(mark));
    });

    // The secret, written whole before the engine touches the database,
    // and then an answer: the file outlives the process that wrote it, so
    // only an answer says this process is up.
    const secretFile = join(dataDir, "interface-secret");
    const url = `http://127.0.0.1:${this.#port}`;
    const until = this.#clock() + this.#timing.secretWaitMs;
    while (!stale() && this.#engine === engine && this.#clock() < until) {
      const secret = await readSecret(secretFile);
      if (secret && (await answers(url, secret))) {
        if (stale() || this.#engine !== engine) return;
        this.#url = url;
        this.#secret = secret;
        this.#enter("running");
        return;
      }
      await sleep(100);
    }
    if (!stale() && this.#engine === engine) {
      this.log.tripwire("no interface secret in time: killed");
      engine.child.kill("SIGKILL");
    }
  }

  #exited(
    generation: number,
    exit: { code: number | null; signal: NodeJS.Signals | null },
    lines: string[],
  ) {
    const now = this.#clock();
    const ran = now - this.#spawnedAt;
    const wasRunning = this.#phase === "running";
    const policy = exitPolicy(exit.code, lines);
    const said = lines
      .filter((l) => !l.startsWith("[tripwire]"))
      .slice(-5)
      .join("\n");
    this.log.tripwire(
      `engine exited (${exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`}) after ${Math.round(ran / 1000)} s`,
    );
    this.#url = null;
    this.#secret = null;
    this.#readyOnce = false;

    if (policy === "port") {
      this.#newPort = true;
      void this.#run(generation);
      return;
    }
    if (policy === "lease") {
      this.#leaseSince ??= now;
      if (now - this.#leaseSince < this.#timing.leaseGiveUpMs) {
        this.#problem = {
          code: "lease",
          message:
            "waiting for the previous engine's hold on the database to lapse",
        };
        this.#enter("starting");
        this.#timer = setTimeout(
          () => void this.#run(generation),
          this.#timing.leaseRetryMs,
        );
        return;
      }
    }
    this.#leaseSince = null;
    const reason =
      policy === "failed"
        ? exit.code === 65
          ? "the database schema is newer than this engine"
          : "the engine refused its configuration"
        : exit.code === 75
          ? "the database is unreachable"
          : exit.code === 69
            ? "the RPC failed verification"
            : exit.signal
              ? `killed by ${exit.signal}`
              : `exited with code ${exit.code}`;
    this.#lastExit = {
      code: exit.code,
      signal: exit.signal,
      at: new Date(now).toISOString(),
      reason,
    };
    if (policy === "failed") {
      this.#fail(
        exit.code === 65 ? "schema" : "config_refused",
        maskUrls(said || reason),
      );
      return;
    }
    // Unplanned: counted, alerted, and tried again on the backoff.
    if (ran >= this.#timing.steadyMs)
      this.#backoff = this.#timing.backoffStartMs;
    this.#total++;
    this.#unplanned = [...this.#unplanned, now].filter(
      (t) => now - t < REPEATED_WINDOW_MS,
    );
    if (this.#unplanned.length < 3) this.#repeatedRaised = false;
    this.#problem = { code: "exited", message: maskUrls(said || reason) };
    if (wasRunning) {
      this.#alert({
        kind: "stopped",
        message: `The engine stopped (${reason}). Tripwire is restarting it.`,
      });
    }
    if (this.#unplanned.length >= 3 && !this.#repeatedRaised) {
      this.#repeatedRaised = true;
      this.#alert({
        kind: "repeated",
        message: `The engine has restarted ${this.#unplanned.length} times in ten minutes; Tripwire is backing off. Last: ${reason}.`,
      });
    }
    this.#scheduleRestart(generation, reason);
  }

  #scheduleRestart(generation: number, reason: string) {
    this.#enter("restarting");
    const wait = this.#backoff;
    this.log.tripwire(`restarting in ${Math.round(wait / 1000)} s (${reason})`);
    this.#backoff = Math.min(this.#backoff * 2, this.#timing.backoffMaxMs);
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      if (generation === this.#generation && !this.#shuttingDown) {
        void this.#run(generation);
      }
    }, wait);
  }

  #fail(code: string, message: string) {
    this.#problem = { code, message };
    this.log.tripwire(`cannot start: ${message}`);
    this.#enter("failed");
    this.#alert({ kind: "cannot_start", message });
  }

  async #stopProcess(why: string) {
    const engine = this.#engine;
    if (!engine) return;
    this.#planned = true;
    const how = await stopEngine(engine, this.#timing.stopGraceMs);
    this.#planned = false;
    this.log.tripwire(
      how === "killed" ? `${why}; killed after the grace` : why,
    );
    await rm(join(this.home, "engine", "engine.pid"), { force: true });
    this.#engine = null;
    this.#url = null;
    this.#secret = null;
  }

  #clearTimer() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #enter(phase: SupervisorPhase) {
    if (phase === this.#phase) return;
    this.#phase = phase;
    this.#since = this.#clock();
    for (const l of this.#listeners) l.phase?.(phase);
  }

  #alert(alert: EngineAlert) {
    for (const l of this.#listeners) l.alert?.(alert);
  }
}

/** Whether the control interface answers this secret at all. */
async function answers(url: string, secret: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/v1/health`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function unsupported(): string {
  try {
    engineTarget();
    return "";
  } catch (error) {
    return messageOf(error);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
