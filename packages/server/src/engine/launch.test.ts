import { describe, expect, it } from "vitest";
import {
  defaultConfig,
  parseConfig,
  type AppConfig,
  type ChainConfig,
} from "../config";
import {
  EngineLaunchError,
  engineEnvironment,
  engineToml,
  withEnvironmentChain,
} from "./launch";

const RPC = { TRIPWIRE_RPC_HTTP: "https://node.example/key" };

const chain: ChainConfig = {
  chainId: 1,
  rpcHttp: "env:TRIPWIRE_RPC_HTTP",
  rpcWs: null,
  pollIntervalMs: 2000,
  controllerAddress: null,
  controllerDeployedBlock: null,
};
const config = (change: Partial<AppConfig> = {}) =>
  ({ ...defaultConfig(), chain, ...change }) as AppConfig & {
    chain: ChainConfig;
  };
const where = {
  dataDir: "/h/engine",
  port: 4100,
  local: false,
  keysPassphrase: false,
};

describe("withEnvironmentChain", () => {
  it("leaves a configuration without a chain alone when no endpoint is set", () => {
    expect(withEnvironmentChain(defaultConfig(), {}).chain).toBeNull();
  });

  it("takes the chain from the environment until the file has one", () => {
    const taken = withEnvironmentChain(defaultConfig(), {
      ...RPC,
      TRIPWIRE_CHAIN_ID: "31337",
      TRIPWIRE_RESPONSE_MODE: "prepare",
    });
    expect(taken.chain).toMatchObject({
      chainId: 31337,
      rpcHttp: "env:TRIPWIRE_RPC_HTTP",
      rpcWs: null,
    });
    expect(taken.response.mode).toBe("prepare");
    expect(taken.mempool).toEqual({ enabled: false, respond: false });
  });

  it("watches the mempool when a WebSocket endpoint is given", () => {
    const taken = withEnvironmentChain(defaultConfig(), {
      ...RPC,
      TRIPWIRE_RPC_WS: "wss://node.example",
    });
    expect(taken.chain?.rpcWs).toBe("env:TRIPWIRE_RPC_WS");
    expect(taken.mempool.enabled).toBe(true);
  });

  it("keeps the file's chain over the environment", () => {
    const file = config({ chain: { ...chain, chainId: 8453 } });
    expect(
      withEnvironmentChain(file, { ...RPC, TRIPWIRE_CHAIN_ID: "1" }).chain
        ?.chainId,
    ).toBe(8453);
  });

  it("refuses an unknown mode or chain id", () => {
    expect(() =>
      withEnvironmentChain(defaultConfig(), {
        ...RPC,
        TRIPWIRE_RESPONSE_MODE: "auto",
      }),
    ).toThrow(EngineLaunchError);
    expect(() =>
      withEnvironmentChain(defaultConfig(), {
        ...RPC,
        TRIPWIRE_CHAIN_ID: "mainnet",
      }),
    ).toThrow("chain id");
  });
});

describe("engineToml", () => {
  it("refers to every secret by environment variable", () => {
    const toml = engineToml(
      config({
        chain: { ...chain, rpcWs: "env:TRIPWIRE_RPC_WS" },
        mempool: { enabled: true, respond: false },
      }),
      { ...where, keysPassphrase: true },
    );
    expect(toml).toContain('rpc_http = "env:TRIPWIRE_RPC_HTTP"');
    expect(toml).toContain('rpc_ws = "env:TRIPWIRE_RPC_WS"');
    expect(toml).toContain('url = "env:TRIPWIRE_DATABASE_URL"');
    expect(toml).toContain('passphrase = "env:TRIPWIRE_KEYS_PASSPHRASE"');
    expect(toml).toContain('bind = "127.0.0.1:4100"');
    expect(toml).toContain("enabled = true");
    expect(toml).not.toContain("node.example");
  });

  it("writes every member the spec maps, leaving nulls to the engine", () => {
    const toml = engineToml(config(), where);
    expect(toml).toContain("poll_interval_ms = 2000");
    expect(toml).toContain('mode = "notify"');
    expect(toml).toContain("replacement_blocks = 5");
    expect(toml).toContain("max_attempts = 3");
    expect(toml).toContain('submission = "private"');
    expect(toml).toContain("points_days = 90");
    expect(toml).toContain("notifications_days = 90");
    expect(toml).not.toContain("max_fee_gwei");
    expect(toml).not.toContain("key =");
    expect(toml).not.toContain("rpc_ws");
    expect(toml).not.toContain("[keys]");
    expect(toml).not.toContain("max_connections");
  });

  it("names the known controller for the chain, or the configured one", () => {
    expect(engineToml(config(), where)).toContain(
      'controller_address = "0x328aed8f7a01f45a959c187f3cb97ec508064854"',
    );
    expect(engineToml(config(), where)).toContain(
      "controller_deployed_block = 25141731",
    );
    const own = parseConfig({
      version: 1,
      chain: {
        ...chain,
        chainId: 31337,
        controllerAddress: "0xE7f1725E7734CE288F8367e1Bb143E90bb3F0512",
        controllerDeployedBlock: 2800,
      },
    }) as AppConfig & { chain: ChainConfig };
    const toml = engineToml(own, where);
    expect(toml).toContain(
      'controller_address = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512"',
    );
    expect(toml).toContain("controller_deployed_block = 2800");
    expect(
      engineToml(config({ chain: { ...chain, chainId: 31337 } }), where),
    ).not.toContain("controller_address");
  });

  it("gives the local database one connection", () => {
    expect(engineToml(config(), { ...where, local: true })).toContain(
      "max_connections = 1",
    );
  });
});

describe("engineEnvironment", () => {
  it("passes only what the engine needs, resolved", () => {
    const env = engineEnvironment(
      chain,
      { ...RPC, PATH: "/bin", HOME: "/home/x", AWS_SECRET: "nope" },
      "postgres://db",
    );
    expect(env).toEqual({
      PATH: "/bin",
      TRIPWIRE_RPC_HTTP: RPC.TRIPWIRE_RPC_HTTP,
      TRIPWIRE_DATABASE_URL: "postgres://db",
    });
  });

  it("refuses an endpoint whose variable is not set", () => {
    expect(() => engineEnvironment(chain, {}, "postgres://db")).toThrow(
      "reads TRIPWIRE_RPC_HTTP, which is not set",
    );
  });
});
