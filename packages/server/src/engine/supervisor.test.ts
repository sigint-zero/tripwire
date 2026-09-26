import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, saveConfig, type AppConfig } from "../config";
import { engineInstallDir, type EnginePin } from "./release";
import {
  EngineSupervisor,
  exitPolicy,
  SettingsRejected,
  type EngineAlert,
  type SupervisorPhase,
} from "./supervisor";

// The supervisor against a stand-in engine binary: a small script, signed
// as a release is, steered by fake.json in its own directory.

const TARGET = "x86_64-unknown-linux-musl";
const RPC = "https://node.example/secret-key";

/**
 * `--version` prints 0.1.0; `verify` answers for the chain in its
 * configuration, refusing any but fake.chainId when that is set;
 * `migrate` exits fake.migrate; `run` records its environment and exits
 * at once with fake.runExit (or runExitByChain[chain id]), else writes
 * the secret, answers /v1/health (never, with fake.hang), and exits 0 on
 * SIGTERM.
 */
const FAKE_ENGINE = (dir: string) => `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const FAKE = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("0.1.0"); process.exit(0); }
const [cmd, , config] = args;
let fake = {};
try { fake = JSON.parse(fs.readFileSync(FAKE + "/fake.json", "utf8")); } catch {}
fs.appendFileSync(FAKE + "/calls.log", cmd + "\\n");
const toml = fs.readFileSync(config, "utf8");
const chainId = Number(/^chain_id = (\\d+)$/m.exec(toml)[1]);
if (cmd === "verify") {
  const ok = fake.chainId === undefined || fake.chainId === chainId;
  console.log(JSON.stringify({ ok, chain_id: chainId, head: ok ? 100 : null,
    receipts: ok ? "block_receipts" : null, ws: null,
    problems: ok ? [] : [{ code: "wrong_chain", message: "the node serves chain id " + fake.chainId + ", the engine is configured for " + chainId + " at " + process.env.TRIPWIRE_RPC_HTTP }] }));
  process.exit(ok ? 0 : 69);
}
if (cmd === "migrate") process.exit(fake.migrate || 0);
fs.writeFileSync(FAKE + "/env.json", JSON.stringify(process.env));
const code = (fake.runExitByChain || {})[chainId] ?? fake.runExit;
if (code !== undefined) { console.error(fake.runMessage || "refused"); process.exit(code); }
const dir = /^dir = "(.*)"$/m.exec(toml)[1];
const port = Number(/^bind = "127\\.0\\.0\\.1:(\\d+)"$/m.exec(toml)[1]);
const secret = "ab".repeat(32);
fs.writeFileSync(dir + "/.secret", secret, { mode: 0o600 });
fs.renameSync(dir + "/.secret", dir + "/interface-secret");
const server = http.createServer((req, res) => {
  if (fake.hang) return;
  const ok = req.headers.authorization === "Bearer " + secret;
  res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "ready" }));
}).listen(port, "127.0.0.1", () => console.log("control interface listening"));
process.on("SIGTERM", () => { console.log("stopped cleanly"); process.exit(0); });
`;

function minisignKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const id = randomBytes(8);
  return {
    publicKey: Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64"),
    sign(file: Buffer, trusted = "timestamp:0\tfile:SHA256SUMS\thashed") {
      const digest = createHash("blake2b512").update(file).digest();
      const body = sign(null, digest, privateKey);
      const global = sign(
        null,
        Buffer.concat([body, Buffer.from(trusted)]),
        privateKey,
      );
      return [
        "untrusted comment: signature from minisign secret key",
        Buffer.concat([Buffer.from("ED"), id, body]).toString("base64"),
        `trusted comment: ${trusted}`,
        global.toString("base64"),
        "",
      ].join("\n");
    },
  };
}

const running: EngineSupervisor[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.stop();
});

async function installation(fake: object = {}) {
  const home = await mkdtemp(join(tmpdir(), "tripwire-supervisor-"));
  const fakeDir = join(home, "fake");
  await mkdir(fakeDir);
  await writeFile(join(fakeDir, "fake.json"), JSON.stringify(fake));
  const key = minisignKey();
  const pin: EnginePin = {
    version: "0.1.0",
    publicKey: key.publicKey,
    releases: "http://127.0.0.1:1/{version}/{asset}",
  };
  const dir = engineInstallDir(home, "0.1.0");
  await mkdir(dir, { recursive: true });
  const script = Buffer.from(FAKE_ENGINE(fakeDir));
  await writeFile(join(dir, "tripwire-engine"), script, { mode: 0o755 });
  const sums = Buffer.from(
    `${createHash("sha256").update(script).digest("hex")}  tripwire-engine-0.1.0-${TARGET}\n`,
  );
  await writeFile(join(dir, "SHA256SUMS"), sums);
  await writeFile(join(dir, "SHA256SUMS.minisig"), key.sign(sums));

  const phases: SupervisorPhase[] = [];
  const alerts: EngineAlert[] = [];
  const make = () => {
    const supervisor = new EngineSupervisor({
      home,
      pin,
      databaseUrl: "postgres://app@127.0.0.1:1/tripwire",
      local: false,
      target: TARGET,
      env: { PATH: process.env.PATH, HOME: "/nope" },
      timing: {
        backoffStartMs: 50,
        backoffMaxMs: 200,
        leaseRetryMs: 100,
        leaseGiveUpMs: 4_000,
        killAfterMs: 1_000,
        stopGraceMs: 2_000,
        applyWaitMs: 4_000,
        secretWaitMs: 4_000,
      },
    });
    supervisor.listen({
      phase: (p) => phases.push(p),
      alert: (a) => alerts.push(a),
    });
    running.push(supervisor);
    return supervisor;
  };
  return {
    home,
    make,
    phases,
    alerts,
    fake: (next: object) =>
      writeFile(join(fakeDir, "fake.json"), JSON.stringify(next)),
    calls: async () =>
      (await readFile(join(fakeDir, "calls.log"), "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean),
    env: async () =>
      JSON.parse(await readFile(join(fakeDir, "env.json"), "utf8")) as Record<
        string,
        string
      >,
  };
}

const chain = (chainId = 31337): AppConfig["chain"] => ({
  chainId,
  rpcHttp: RPC,
  rpcWs: null,
  pollIntervalMs: 1000,
  controllerAddress: null,
  controllerDeployedBlock: null,
});

/**
 * Whether the engine answers its health now, as the monitor judges it:
 * a new process counts only once it has answered.
 */
function watching(supervisor: EngineSupervisor): () => boolean {
  let answered = false;
  let asking = false;
  supervisor.listen({
    phase: () => {
      answered = false;
    },
  });
  const timer = setInterval(() => {
    const target = supervisor.current();
    if (!target || asking) return;
    asking = true;
    void fetch(`${target.url}/v1/health`, {
      headers: { authorization: `Bearer ${target.secret}` },
    })
      .then((r) => (answered = r.ok))
      .catch(() => (answered = false))
      .finally(() => (asking = false));
  }, 25);
  timer.unref();
  return () => answered;
}

async function until(check: () => boolean | Promise<boolean>, ms = 5_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
}

describe("exitPolicy", () => {
  it("fails on what needs a person, waits out a lease, and restarts on the rest", () => {
    expect(exitPolicy(78, [])).toBe("failed");
    expect(exitPolicy(65, [])).toBe("failed");
    expect(exitPolicy(70, [])).toBe("lease");
    expect(exitPolicy(1, ["x cannot bind the control interface: in use"])).toBe(
      "port",
    );
    for (const code of [0, 1, 75, 69, null]) {
      expect(exitPolicy(code, [])).toBe("restart");
    }
  });
});

describe("EngineSupervisor", () => {
  it("is unconfigured with no chain, and starts nothing", async () => {
    const it = await installation();
    const supervisor = it.make();
    await supervisor.start();
    expect(supervisor.phase).toBe("unconfigured");
    expect(await it.calls()).toEqual([]);
  });

  it("starts from config.json and stops in order", async () => {
    const it = await installation();
    await saveConfig(it.home, { ...defaultConfig(), chain: chain() });
    const supervisor = it.make();
    await supervisor.start();
    await until(() => supervisor.phase === "running");
    expect(supervisor.info.chainId).toBe(31337);
    expect(await it.calls()).toEqual(["migrate", "run"]);

    const target = supervisor.current()!;
    const health = await fetch(`${target.url}/v1/health`, {
      headers: { authorization: `Bearer ${target.secret}` },
    });
    expect(health.status).toBe(200);

    // The file holds no secret; the engine's environment only what it needs.
    const toml = await readFile(join(it.home, "engine.toml"), "utf8");
    expect((await stat(join(it.home, "engine.toml"))).mode & 0o777).toBe(0o600);
    expect(toml).not.toContain("node.example");
    expect(Object.keys(await it.env()).sort()).toEqual([
      "PATH",
      "TRIPWIRE_DATABASE_URL",
      "TRIPWIRE_RPC_HTTP",
    ]);
    const pid = JSON.parse(
      await readFile(join(it.home, "engine", "engine.pid"), "utf8"),
    ) as { pid: number; binary: string };
    expect(pid.binary).toContain("tripwire-engine");

    await supervisor.stop();
    expect(supervisor.phase).toBe("stopped");
    await expect(
      readFile(join(it.home, "engine", "engine.pid"), "utf8"),
    ).rejects.toThrow();
    const log = await readFile(join(it.home, "logs", "engine.log"), "utf8");
    expect(log).toContain("stopped cleanly");
    expect(log).not.toContain("secret-key");
  });

  it("fails on a refused configuration, and does not loop", async () => {
    const it = await installation({
      runExit: 78,
      runMessage: "config error: bad key",
    });
    await saveConfig(it.home, { ...defaultConfig(), chain: chain() });
    const supervisor = it.make();
    await supervisor.start();
    await until(() => supervisor.phase === "failed");
    await new Promise((r) => setTimeout(r, 300));
    expect((await it.calls()).filter((c) => c === "run")).toHaveLength(1);
    expect(supervisor.report().problem).toEqual({
      code: "config_refused",
      message: expect.stringContaining("config error: bad key") as unknown,
    });
    expect(it.alerts.map((a) => a.kind)).toEqual(["cannot_start"]);
  });

  it("restarts a crashed engine on the backoff, and says so once when it keeps crashing", async () => {
    const it = await installation();
    await saveConfig(it.home, { ...defaultConfig(), chain: chain() });
    const supervisor = it.make();
    await supervisor.start();
    await until(() => supervisor.phase === "running");
    await it.fake({ runExit: 1, runMessage: "panicked" });
    for (let i = 0; i < 3; i++) {
      const pid = JSON.parse(
        await readFile(join(it.home, "engine", "engine.pid"), "utf8").catch(
          () => "{}",
        ),
      ) as { pid?: number };
      if (pid.pid) process.kill(pid.pid, "SIGKILL");
      await until(() => supervisor.phase !== "running");
      if (i === 0) await it.fake({});
      await until(() => supervisor.phase === "running");
    }
    const report = supervisor.report();
    expect(report.restarts.total).toBeGreaterThanOrEqual(3);
    expect(report.lastExit?.signal).toBe("SIGKILL");
    expect(it.alerts.filter((a) => a.kind === "repeated")).toHaveLength(1);
    expect(it.phases).toContain("restarting");
  });

  it("waits out another engine's lease without counting it", async () => {
    const it = await installation({ runExit: 70 });
    await saveConfig(it.home, { ...defaultConfig(), chain: chain() });
    const supervisor = it.make();
    await supervisor.start();
    await until(
      async () => (await it.calls()).filter((c) => c === "run").length >= 3,
    );
    expect(supervisor.phase).toBe("starting");
    expect(supervisor.report().problem?.message).toContain(
      "hold on the database",
    );
    expect(supervisor.report().restarts.total).toBe(0);
    await it.fake({});
    await until(() => supervisor.phase === "running");
    expect(it.alerts).toEqual([]);
  });

  it("kills an engine that stops answering, and starts another", async () => {
    const it = await installation();
    await saveConfig(it.home, { ...defaultConfig(), chain: chain() });
    const supervisor = it.make();
    await supervisor.start();
    await until(() => supervisor.phase === "running");
    supervisor.unanswered(500);
    expect(supervisor.phase).toBe("running");
    supervisor.unanswered(1_000);
    await until(() => supervisor.phase !== "running");
    await until(() => supervisor.phase === "running");
    expect(supervisor.report().lastExit?.signal).toBe("SIGKILL");
    expect(it.alerts.map((a) => a.kind)).toContain("stopped");
  });

  it("applies the first chain, and verifies an endpoint without saving it", async () => {
    const it = await installation({ chainId: 31337 });
    const supervisor = it.make();
    await supervisor.start();
    expect(supervisor.phase).toBe("unconfigured");

    const wrong = await supervisor.verify(chain(1)!);
    expect(wrong.ok).toBe(false);
    expect(wrong.problems[0]!.message).toBe(
      "This endpoint serves chain 31337, not Ethereum (1).",
    );
    // The endpoint's key never comes back.
    expect(wrong.problems[0]!.message).not.toContain("secret-key");
    expect((await supervisor.verify(chain()!)).ok).toBe(true);

    await supervisor.apply(
      { ...defaultConfig(), chain: chain() },
      watching(supervisor),
    );
    expect(supervisor.phase).toBe("running");
    expect(supervisor.info.chainId).toBe(31337);
    expect(
      JSON.parse(await readFile(join(it.home, "config.json"), "utf8")),
    ).toMatchObject({ chain: { chainId: 31337 } });
  });

  it("rolls a refused change back, and returns the engine's words", async () => {
    const it = await installation();
    await saveConfig(it.home, { ...defaultConfig(), chain: chain() });
    const supervisor = it.make();
    await supervisor.start();
    await until(() => supervisor.phase === "running");
    await it.fake({
      runExit: 78,
      runMessage: "config error: submission refused",
    });

    const next: AppConfig = {
      ...defaultConfig(),
      chain: chain(),
      response: { ...defaultConfig().response, mode: "send" },
    };
    const error = await supervisor
      .apply(next, watching(supervisor))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SettingsRejected);
    expect((error as Error).message).toContain("submission refused");
    const back = JSON.parse(
      await readFile(join(it.home, "config.json"), "utf8"),
    ) as AppConfig;
    expect(back.response.mode).toBe("notify");

    await it.fake({});
    await supervisor.restart("tester");
    await until(() => supervisor.phase === "running");
    expect(supervisor.info.responseMode).toBe("notify");
  });

  it("refuses to move an installation to another chain", async () => {
    const it = await installation();
    await saveConfig(it.home, { ...defaultConfig(), chain: chain() });
    const supervisor = it.make();
    await supervisor.start();
    await until(() => supervisor.phase === "running");
    await expect(
      supervisor.apply(
        { ...defaultConfig(), chain: chain(1) },
        watching(supervisor),
      ),
    ).rejects.toThrow("fixed once set");
  });
});
