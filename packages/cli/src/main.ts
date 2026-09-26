import {
  connectEngine,
  createServer,
  DatabaseSetupError,
  EngineSupervisor,
  McpTokens,
  RunLockError,
  startDatabase,
  supervisedBackend,
  takeRunLock,
  TokenError,
  tripwireHome,
  type EngineBackend,
  type StartedDatabase,
} from "@tripwire/server";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chainName, engineCommand, readPin, setupCommand } from "./engine";
import { userCommand } from "./users";

const USAGE = `Usage: tripwire [start] [options]
       tripwire setup [--username <name>] [--chain-id <id or name>]
                      [--rpc-http <url or env:NAME>] [--rpc-ws <url or env:NAME>]
                      [--database-url <url or env:NAME>] [--skip-verify]
       tripwire engine status
       tripwire engine install [--from <dir>]
       tripwire engine log [-n <lines>] [--follow]
       tripwire user add|passwd|remove|unlock <name>
       tripwire user list
       tripwire mcp token new <label> [--expires <30d|12h|90m>]
       tripwire mcp token list
       tripwire mcp token revoke <id or label>

Sets Tripwire up, starts it and serves the dashboard, looks after its
engine, manages its accounts, or manages the tokens AI agents use to
reach its MCP server. Everything lives in TRIPWIRE_HOME (default
~/.tripwire).

A new installation: tripwire setup, then tripwire start. Setup asks for
the database, an account and the chain; with flags and TRIPWIRE_PASSWORD
it asks nothing, for servers and scripts. Start installs the pinned
engine release if it is missing, verifies it, and runs and supervises it.
Without setup, start serves the dashboard, whose first page sets up the
same things.

Environment:
  TRIPWIRE_PASSWORD         the password for setup and user commands, for scripts
  TRIPWIRE_KEYS_PASSPHRASE  unlocks the engine's signing keys at start
  TRIPWIRE_RPC_HTTP         before setup: the chain's HTTP endpoint, taken
                            with TRIPWIRE_RPC_WS, TRIPWIRE_CHAIN_ID and
                            TRIPWIRE_RESPONSE_MODE until config.json has a chain
  TRIPWIRE_ENGINE=stand-in  runs with simulated data and no engine
  TRIPWIRE_ENGINE_URL       with TRIPWIRE_ENGINE_SECRET_FILE, attaches to an
                            engine started by hand

Options:
  -p, --port <port>         port to listen on (default: 4747)
      --host <host>         address to listen on (default: 127.0.0.1)
      --database-url <url>  use this PostgreSQL database for this run
      --open                open the dashboard in your browser
      --tls-cert <file>     serve HTTPS with this certificate...
      --tls-key <file>      ...and this key
      --behind-proxy        a reverse proxy in front terminates TLS
      --expires <duration>  when a new MCP token stops working (default: never)
      --from <dir>          install the engine from this directory
  -n, --lines <n>           log lines to print (default: 50)
      --follow              keep printing the log as it grows
  -v, --version             print the version
  -h, --help                print this help`;

const { values, positionals } = parseCommandLine();

function parseCommandLine() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        port: { type: "string", short: "p", default: "4747" },
        host: { type: "string", default: "127.0.0.1" },
        "database-url": { type: "string" },
        open: { type: "boolean", default: false },
        expires: { type: "string" },
        "tls-cert": { type: "string" },
        "tls-key": { type: "string" },
        "behind-proxy": { type: "boolean", default: false },
        username: { type: "string" },
        "chain-id": { type: "string" },
        "rpc-http": { type: "string" },
        "rpc-ws": { type: "string" },
        "skip-verify": { type: "boolean", default: false },
        from: { type: "string" },
        lines: { type: "string", short: "n" },
        follow: { type: "boolean", default: false },
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    process.exit(1);
  }
}

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

if (values.version) {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  console.log(pkg.version);
  process.exit(0);
}

if (positionals[0] === "user") {
  await userCommand(tripwireHome(), positionals.slice(1), (message) => {
    console.error(`${message}\n\n${USAGE}`);
    process.exit(1);
  });
  process.exit(0);
}

if (positionals[0] === "mcp") {
  await mcpCommand(positionals.slice(1));
  process.exit(0);
}

const failWithUsage = (message: string): never => {
  console.error(message);
  process.exit(1);
};

if (positionals[0] === "engine") {
  await engineCommand(
    tripwireHome(),
    positionals.slice(1),
    { from: values.from, lines: values.lines, follow: values.follow },
    failWithUsage,
  );
  process.exit(0);
}

if (positionals[0] === "setup") {
  if (positionals.length > 1) {
    failWithUsage(`Unexpected: ${positionals.slice(1).join(" ")}`);
  }
  await setupCommand(
    tripwireHome(),
    {
      username: values.username,
      chainId: values["chain-id"],
      rpcHttp: values["rpc-http"],
      rpcWs: values["rpc-ws"],
      databaseUrl: values["database-url"],
      skipVerify: values["skip-verify"],
    },
    failWithUsage,
  );
  process.exit(0);
}

const command = positionals[0] ?? "start";
if (command !== "start" || positionals.length > 1) {
  console.error(`Unknown command: ${positionals.join(" ")}\n\n${USAGE}`);
  process.exit(1);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid port: ${values.port}`);
  process.exit(1);
}

// An empty host would make Node listen on every network interface.
const host = values.host.trim();
if (host === "") {
  console.error("Invalid host: it must not be empty.");
  process.exit(1);
}

// A password over plain HTTP is acceptable only on the loopback interface;
// MCP tokens travel in a header on every request too.
const tlsCert = values["tls-cert"];
const tlsKey = values["tls-key"];
if (Boolean(tlsCert) !== Boolean(tlsKey)) {
  console.error("--tls-cert and --tls-key go together.");
  process.exit(1);
}
const loopback =
  host === "localhost" || /^127\./.test(host) || /^\[?::1\]?$/.test(host);
if (!loopback && !tlsCert && !values["behind-proxy"]) {
  console.error(
    `Listening on ${host} would send passwords and tokens over the network in the clear.\n` +
      "Add --tls-cert <file> --tls-key <file> to serve HTTPS, or --behind-proxy if a reverse proxy in front terminates TLS.",
  );
  process.exit(1);
}
const https =
  tlsCert && tlsKey
    ? { cert: readFileSync(tlsCert), key: readFileSync(tlsKey) }
    : undefined;

// One server per installation.
const releaseLock = await takeRunLock(tripwireHome()).catch(
  (error: unknown) => {
    if (!(error instanceof RunLockError)) throw error;
    console.error(error.message);
    process.exit(1);
  },
);

// The database comes up, and the app schema is migrated, before anything
// is served.
const database = await startDatabase({
  home: tripwireHome(),
  url: values["database-url"],
  migrationsDir: fileURLToPath(new URL("./migrations/", import.meta.url)),
}).catch(async (error: unknown) => {
  await releaseLock();
  if (!(error instanceof DatabaseSetupError)) throw error;
  console.error(error.message);
  process.exit(1);
});

const engine = await startEngine(database);

const app = await createServer({
  webRoot: fileURLToPath(new URL("./web", import.meta.url)),
  allowedHosts: [host],
  backend: { pool: database.pool, engine: engine.backend },
  home: tripwireHome(),
  mcpContentDir: fileURLToPath(new URL("./mcp/", import.meta.url)),
  https,
  behindProxy: values["behind-proxy"],
});

try {
  await app.listen({ host, port });
} catch (error) {
  await app.close();
  await database.close();
  await releaseLock();
  const message = listenErrorMessage(error as NodeJS.ErrnoException);
  if (!message) throw error;
  console.error(message);
  process.exit(1);
}

const url = `${https ? "https" : "http"}://${host.includes(":") ? `[${host}]` : host}:${port}`;
console.log(`Tripwire is running at ${url}\nPress Ctrl+C to stop.`);
if (values.open) openBrowser(url);

engine.report(url);

// Closing the server stops the engine, before the database closes.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => database.close())
      .then(() => releaseLock())
      .then(() => process.exit(0));
  });
}

/**
 * The engine this start runs against: the stand-in when asked for, an
 * engine someone runs by hand when TRIPWIRE_ENGINE_URL names it, otherwise
 * the pinned release, installed, started and supervised here. Its progress
 * is printed, since many installations are only ever seen from here.
 */
async function startEngine(
  database: StartedDatabase,
): Promise<{ backend: EngineBackend; report(url: string): void }> {
  if (process.env.TRIPWIRE_ENGINE === "stand-in") {
    const env = { ...process.env };
    delete env.TRIPWIRE_ENGINE_URL;
    const backend = await connectEngine(database.pool, env);
    return {
      backend,
      report: () => console.log("Engine: the stand-in, on simulated data."),
    };
  }
  if (process.env.TRIPWIRE_ENGINE_URL) {
    return {
      backend: await connectEngine(database.pool),
      report: () =>
        console.log(`Engine: attached at ${process.env.TRIPWIRE_ENGINE_URL}.`),
    };
  }

  const home = tripwireHome();
  const supervisor = new EngineSupervisor({
    home,
    pin: readPin(),
    databaseUrl: database.database.url,
    local: database.database.mode === "local",
  });
  let dashboard = "";
  let readyShown = false;
  const say = (phase: string) => {
    const problem = supervisor.report().problem;
    switch (phase) {
      case "unconfigured":
        // Said once the dashboard's address is known.
        if (!dashboard) break;
        console.log(
          `Engine: no chain configured yet. Run: tripwire setup${dashboard ? `, or open ${dashboard}` : ""}`,
        );
        break;
      case "installing":
        console.log(`Engine: downloading ${supervisor.pin.version}…`);
        break;
      case "starting":
        console.log(
          `Engine ${supervisor.pin.version}: starting${problem?.code === "lease" ? ` (${problem.message})` : ""}`,
        );
        break;
      case "running":
        readyShown = false;
        void waitReady();
        break;
      case "restarting":
        console.error(
          `Engine: restarting${problem ? `: ${problem.message.split("\n")[0]}` : ""}`,
        );
        break;
      case "failed":
        console.error(
          `Engine: cannot start: ${problem?.message ?? "see tripwire engine log"}\nFix it, then restart Tripwire, or see: tripwire engine log`,
        );
        break;
    }
  };
  // "Ready" is the engine's own word, from its health.
  const waitReady = async () => {
    for (let i = 0; i < 600 && !readyShown; i++) {
      const target = supervisor.current();
      if (!target) return;
      const health = await fetch(`${target.url}/v1/health`, {
        headers: { authorization: `Bearer ${target.secret}` },
        signal: AbortSignal.timeout(5_000),
      })
        .then((r) =>
          r.ok
            ? (r.json() as Promise<{
                status: string;
                evaluated_block: number | null;
                observed_head: number | null;
              }>)
            : null,
        )
        .catch(() => null);
      if (health && health.status !== "starting") {
        readyShown = true;
        const block = health.evaluated_block ?? health.observed_head;
        console.log(
          `Engine ${supervisor.pin.version}: ${health.status}, watching ${chainName(supervisor.info.chainId)}${block !== null ? ` at block ${block.toLocaleString("en-US")}` : ""}.`,
        );
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  supervisor.listen({
    phase: (phase) => say(phase),
    alert: (alert) => {
      if (alert.kind !== "cannot_start")
        console.error(`Engine: ${alert.message}`);
    },
  });
  await supervisor.start();
  return {
    backend: supervisedBackend(database.pool, supervisor),
    report: (url) => {
      dashboard = url;
      if (supervisor.phase === "unconfigured") say("unconfigured");
    },
  };
}

function listenErrorMessage(error: NodeJS.ErrnoException) {
  switch (error.code) {
    case "EADDRINUSE":
      return `Port ${port} is already in use. Try --port <other port>.`;
    case "EACCES":
      return `No permission to use port ${port}. Ports below 1024 usually need admin rights; try --port ${port < 1024 ? 4747 : "<other port>"}.`;
    case "EADDRNOTAVAIL":
      return `Address ${host} does not belong to this machine. Try --host 127.0.0.1.`;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `Cannot resolve host "${host}". Try --host 127.0.0.1.`;
    default:
      return undefined;
  }
}

function openBrowser(target: string) {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [target]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", target]]
        : ["xdg-open", [target]];
  spawn(cmd, args, { detached: true, stdio: "ignore" })
    .on("error", () => console.log(`Open ${target} in your browser.`))
    .unref();
}

/**
 * `tripwire mcp token …`: works on the token file directly, so it takes
 * effect on an agent's next request with the server running or not.
 */
async function mcpCommand(args: string[]) {
  const tokens = new McpTokens(tripwireHome());
  const [noun, verb, ...rest] = args;
  const fail = (message: string): never => {
    console.error(`${message}\n\n${USAGE}`);
    process.exit(1);
  };
  if (noun !== "token") fail(`Unknown command: mcp ${args.join(" ")}`);

  if (verb === "new") {
    const label = rest.join(" ");
    if (!label) fail("A new token needs a label, such as the agent's name.");
    const expiresAt = values.expires ? expiryOf(values.expires) : null;
    try {
      const { token } = await tokens.create({ label, expiresAt });
      const url = `http://${values.host}:${values.port}/mcp`;
      console.log(`Token for "${label}"; it is shown only this once:

  ${token}

For an agent host that speaks HTTP, add this MCP server:

  {
    "mcpServers": {
      "tripwire": {
        "type": "http",
        "url": "${url}",
        "headers": { "Authorization": "Bearer ${token}" }
      }
    }
  }

With Claude Code:

  claude mcp add --transport http tripwire ${url} --header "Authorization: Bearer ${token}"`);
    } catch (error) {
      if (error instanceof TokenError) fail(error.message);
      throw error;
    }
    return;
  }
  if (verb === "list") {
    const list = await tokens.list();
    if (list.length === 0) console.log("No MCP tokens.");
    for (const t of list) {
      console.log(
        [
          t.id,
          t.label,
          `created ${t.createdAt}`,
          `last used ${t.lastUsedAt ?? "never"}`,
          t.expiresAt ? `expires ${t.expiresAt}` : "no expiry",
        ].join("  "),
      );
    }
    return;
  }
  if (verb === "revoke") {
    const which = rest.join(" ");
    if (!which) fail("Name the token to revoke by its id or label.");
    if (!(await tokens.revoke(which))) fail(`No token is "${which}".`);
    console.log(`Revoked "${which}".`);
    return;
  }
  fail(`Unknown command: mcp ${args.join(" ")}`);
}

/** "30d", "12h" or "90m" from now. */
function expiryOf(duration: string): Date {
  const match = /^(\d+)([dhm])$/.exec(duration.trim());
  if (!match) {
    console.error(
      `Invalid --expires: ${duration}. Use a number and d, h or m, like 30d.`,
    );
    process.exit(1);
  }
  const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[
    match[2] as "d" | "h" | "m"
  ];
  return new Date(Date.now() + Number(match[1]) * unit);
}
