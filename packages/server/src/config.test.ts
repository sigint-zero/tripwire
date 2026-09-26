import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  controllerOf,
  defaultConfig,
  loadConfig,
  maskUrl,
  maskUrls,
  parseConfig,
  resolveValue,
  restorePreviousConfig,
  saveConfig,
} from "./config";

const chain = { chainId: 1, rpcHttp: "env:TRIPWIRE_RPC_HTTP" };

describe("parseConfig", () => {
  it("fills in the defaults, with no chain until one is saved", () => {
    expect(parseConfig({ version: 1 })).toEqual(defaultConfig());
    expect(parseConfig({ version: 1, chain }).chain).toEqual({
      chainId: 1,
      rpcHttp: "env:TRIPWIRE_RPC_HTTP",
      rpcWs: null,
      pollIntervalMs: 2000,
      controllerAddress: null,
      controllerDeployedBlock: null,
    });
  });

  it("refuses an unknown member, naming it", () => {
    expect(() => parseConfig({ version: 1, chains: {} })).toThrow(
      "chains: is not a known member",
    );
    expect(() =>
      parseConfig({ version: 1, chain: { ...chain, rpc: "x" } }),
    ).toThrow("chain.rpc: is not a known member");
  });

  it("checks each member by its rule", () => {
    const refused = (value: object) => () =>
      parseConfig({ version: 1, ...value });
    expect(refused({ chain: { ...chain, rpcHttp: "ftp://x" } })).toThrow(
      "chain.rpcHttp",
    );
    expect(refused({ chain: { ...chain, pollIntervalMs: 50 } })).toThrow(
      "100 to 60000",
    );
    expect(
      refused({
        chain: { ...chain, controllerAddress: "0x" + "1".repeat(40) },
      }),
    ).toThrow("both set or both null");
    expect(refused({ mempool: { enabled: true } })).toThrow(
      "needs chain.rpcWs",
    );
    expect(
      refused({
        chain: { ...chain, rpcWs: "wss://n" },
        mempool: { respond: true },
      }),
    ).toThrow("needs mempool.enabled");
    expect(refused({ response: { maxFeeGwei: 1 } })).toThrow(
      "may not exceed the maximum fee",
    );
    expect(refused({ response: { privateEndpoints: [] } })).toThrow(
      "non-empty",
    );
    expect(refused({ retention: { pointsDays: 3 } })).toThrow("7 or more");
  });
});

describe("the file", () => {
  it("is written 0600, keeping the previous one to go back to", async () => {
    const home = await mkdtemp(join(tmpdir(), "tripwire-config-"));
    expect(await loadConfig(home)).toEqual(defaultConfig());
    await saveConfig(home, {
      ...defaultConfig(),
      chain: parseConfig({ version: 1, chain }).chain,
    });
    expect((await stat(join(home, "config.json"))).mode & 0o777).toBe(0o600);
    const next = { ...(await loadConfig(home)) };
    next.response = { ...next.response, mode: "prepare" };
    await saveConfig(home, next);
    expect((await loadConfig(home)).response.mode).toBe("prepare");
    await restorePreviousConfig(home);
    expect((await loadConfig(home)).response.mode).toBe("notify");
    expect(await readFile(join(home, "config.json"), "utf8")).toContain(
      '"chainId": 1',
    );
  });
});

describe("controllerOf", () => {
  it("is the configured controller, else the chain's known one, else none", () => {
    const c = parseConfig({ version: 1, chain }).chain!;
    expect(controllerOf(c)).toEqual({
      address: "0x328aed8f7a01f45a959c187f3cb97ec508064854",
      block: 25141731,
    });
    expect(controllerOf({ ...c, chainId: 31337 })).toBeNull();
  });
});

describe("secrets", () => {
  it("resolves env: references, refusing an unset one", () => {
    expect(resolveValue("env:X", { X: "https://n/k" }, "m")).toBe(
      "https://n/k",
    );
    expect(resolveValue("https://n", {}, "m")).toBe("https://n");
    expect(() => resolveValue("env:X", {}, "chain.rpcHttp")).toThrow(
      "chain.rpcHttp: reads X, which is not set",
    );
  });

  it("shows an endpoint by scheme and host only", () => {
    expect(maskUrl("https://eth.node.io/v2/abc123?key=z")).toBe(
      "https://eth.node.io/…",
    );
    expect(maskUrl("https://eth.node.io")).toBe("https://eth.node.io");
    expect(
      maskUrls("error sending request for url (https://n.io/v2/abc123)"),
    ).toBe("error sending request for url (https://n.io/…)");
  });
});
