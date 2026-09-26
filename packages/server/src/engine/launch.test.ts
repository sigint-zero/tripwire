import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EngineLaunchError,
  engineConfig,
  engineEnvironment,
  engineToml,
  launchEngine,
} from "./launch";

const RPC = { TRIPWIRE_RPC_HTTP: "https://node.example/key" };

describe("engineConfig", () => {
  it("needs the HTTP endpoint", () => {
    expect(() => engineConfig({})).toThrow("TRIPWIRE_RPC_HTTP");
  });

  it("defaults to chain 1, notify, no mempool", () => {
    expect(engineConfig(RPC)).toEqual({
      chainId: 1,
      responseMode: "notify",
      mempool: false,
      keysPassphrase: false,
    });
  });

  it("refuses an unknown mode or chain id", () => {
    expect(() =>
      engineConfig({ ...RPC, TRIPWIRE_RESPONSE_MODE: "auto" }),
    ).toThrow("notify, prepare or send");
    expect(() =>
      engineConfig({ ...RPC, TRIPWIRE_CHAIN_ID: "mainnet" }),
    ).toThrow("chain id");
  });

  it("watches the mempool when a WebSocket endpoint is given", () => {
    expect(
      engineConfig({ ...RPC, TRIPWIRE_RPC_WS: "wss://node.example" }).mempool,
    ).toBe(true);
  });
});

describe("engineToml", () => {
  const base = engineConfig(RPC);

  it("refers to every secret by environment variable", () => {
    const toml = engineToml(
      { ...base, mempool: true, keysPassphrase: true },
      { dataDir: "/h/engine", port: 4100, local: false },
    );
    expect(toml).toContain('rpc_http = "env:TRIPWIRE_RPC_HTTP"');
    expect(toml).toContain('rpc_ws = "env:TRIPWIRE_RPC_WS"');
    expect(toml).toContain('url = "env:TRIPWIRE_DATABASE_URL"');
    expect(toml).toContain('passphrase = "env:TRIPWIRE_KEYS_PASSPHRASE"');
    expect(toml).toContain('bind = "127.0.0.1:4100"');
    expect(toml).toContain("enabled = true");
    expect(toml).not.toContain("node.example");
  });

  it("leaves out what is not configured", () => {
    const toml = engineToml(base, {
      dataDir: "/h/engine",
      port: 4100,
      local: false,
    });
    expect(toml).not.toContain("rpc_ws");
    expect(toml).not.toContain("[keys]");
    expect(toml).not.toContain("max_connections");
    expect(toml).toContain("enabled = false");
  });

  it("gives the local database one connection", () => {
    expect(
      engineToml(base, { dataDir: "/h/engine", port: 4100, local: true }),
    ).toContain("max_connections = 1");
  });
});

describe("engineEnvironment", () => {
  it("passes only what the engine needs", () => {
    const env = engineEnvironment(
      { ...RPC, PATH: "/bin", HOME: "/home/x", AWS_SECRET: "nope" },
      "postgres://db",
    );
    expect(env).toEqual({
      PATH: "/bin",
      TRIPWIRE_RPC_HTTP: RPC.TRIPWIRE_RPC_HTTP,
      TRIPWIRE_DATABASE_URL: "postgres://db",
    });
  });
});

/**
 * A stand-in for the engine binary, steered by fake.json beside its
 * configuration (the engine's environment is allow-listed): `migrate`
 * exits with `migrate` (default 0); `run` writes the secret by rename,
 * answers /v1/health on the configured port and exits 0 on SIGTERM, or
 * exits 75 at once with `runFails`.
 */
const FAKE_ENGINE = `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const [cmd, , config] = process.argv.slice(2);
let fake = {};
try { fake = JSON.parse(fs.readFileSync(path.join(path.dirname(config), "fake.json"), "utf8")); } catch {}
if (cmd === "migrate") process.exit(fake.migrate || 0);
const toml = fs.readFileSync(config, "utf8");
if (fake.runFails) { console.error("database unreachable"); process.exit(75); }
const dir = /^dir = "(.*)"$/m.exec(toml)[1];
const port = Number(/^bind = "127\\.0\\.0\\.1:(\\d+)"$/m.exec(toml)[1]);
const secret = "ab".repeat(32);
fs.writeFileSync(dir + "/.secret", secret, { mode: 0o600 });
fs.renameSync(dir + "/.secret", dir + "/interface-secret");
const server = http.createServer((req, res) => {
  const ok = req.headers.authorization === "Bearer " + secret;
  res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "ready" }));
}).listen(port, "127.0.0.1", () => console.log("control interface listening"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;

async function fakeEngine(fake: { migrate?: number; runFails?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "tripwire-launch-"));
  const binary = join(home, "fake-engine");
  await writeFile(binary, FAKE_ENGINE);
  await chmod(binary, 0o755);
  await writeFile(join(home, "fake.json"), JSON.stringify(fake));
  return { home, binary };
}

describe("launchEngine", () => {
  it("migrates, starts, answers with its secret, and stops on request", async () => {
    const { home, binary } = await fakeEngine();
    const engine = await launchEngine({
      binary,
      home,
      databaseUrl: "postgres://db",
      local: true,
      env: { ...RPC, PATH: process.env.PATH },
    });
    const secret = await readFile(engine.secretFile, "utf8");
    const health = await fetch(`${engine.url}/v1/health`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(health.status).toBe(200);
    expect((await stat(join(home, "engine.toml"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(home, "engine", "engine.pid"), "utf8")).toMatch(
      /^\d+\n$/,
    );

    await engine.stop();
    await expect(engine.exited).resolves.toBe(0);
    await expect(
      readFile(join(home, "engine", "engine.pid"), "utf8"),
    ).rejects.toThrow();
  });

  it("refuses to start when the engine will not migrate", async () => {
    const { home, binary } = await fakeEngine({ migrate: 65 });
    await expect(
      launchEngine({
        binary,
        home,
        databaseUrl: "postgres://db",
        local: false,
        env: { ...RPC, PATH: process.env.PATH },
      }),
    ).rejects.toThrow("refused to migrate the database (exit 65)");
  });

  it("names the log when the engine exits while starting", async () => {
    const { home, binary } = await fakeEngine({ runFails: true });
    const error = await launchEngine({
      binary,
      home,
      databaseUrl: "postgres://db",
      local: false,
      env: { ...RPC, PATH: process.env.PATH },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineLaunchError);
    expect((error as Error).message).toContain("exited with code 75");
    expect(await readFile(join(home, "logs", "engine.log"), "utf8")).toContain(
      "database unreachable",
    );
  });
});
