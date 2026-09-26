import {
  connectEngine,
  createServer,
  DatabaseSetupError,
  EngineLaunchError,
  EngineReleaseError,
  launchEngine,
  McpTokens,
  startDatabase,
  TokenError,
  tripwireHome,
  verifiedEngine,
  type EngineBackend,
  type EnginePin,
  type StartedDatabase,
} from "@tripwire/server";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { userCommand } from "./users";

const USAGE = `Usage: tripwire [start] [options]
       tripwire user add|passwd|remove|unlock <name>
       tripwire user list
       tripwire mcp token new <label> [--expires <30d|12h|90m>]
       tripwire mcp token list
       tripwire mcp token revoke <id or label>

Starts Tripwire and serves the dashboard, manages its accounts, or
manages the tokens AI agents use to reach its MCP server.

Start runs the pinned engine release installed under TRIPWIRE_HOME
(default ~/.tripwire), configured from the environment:
  TRIPWIRE_RPC_HTTP         the chain's HTTP endpoint (required)
  TRIPWIRE_RPC_WS           a WebSocket endpoint; turns on mempool watching
  TRIPWIRE_CHAIN_ID         the chain id (default: 1)
  TRIPWIRE_RESPONSE_MODE    notify, prepare or send (default: notify)
  TRIPWIRE_KEYS_PASSPHRASE  unlocks the engine's keys
TRIPWIRE_ENGINE=stand-in runs with simulated data and no engine;
TRIPWIRE_ENGINE_URL with TRIPWIRE_ENGINE_SECRET_FILE attaches to an
engine started by hand.

Options:
  -p, --port <port>         port to listen on (default: 4747)
      --host <host>         address to listen on (default: 127.0.0.1)
      --database-url <url>  use this PostgreSQL database for this run
      --open                open the dashboard in your browser
      --tls-cert <file>     serve HTTPS with this certificate...
      --tls-key <file>      ...and this key
      --behind-proxy        a reverse proxy in front terminates TLS
      --expires <duration>  when a new MCP token stops working (default: never)
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

// The database comes up, and the app schema is migrated, before anything
// is served.
const database = await startDatabase({
  home: tripwireHome(),
  url: values["database-url"],
  migrationsDir: fileURLToPath(new URL("./migrations/", import.meta.url)),
}).catch((error: unknown) => {
  if (!(error instanceof DatabaseSetupError)) throw error;
  console.error(error.message);
  process.exit(1);
});

let stopping = false;
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
  await engine.stop();
  await database.close();
  const message = listenErrorMessage(error as NodeJS.ErrnoException);
  if (!message) throw error;
  console.error(message);
  process.exit(1);
}

const url = `${https ? "https" : "http"}://${host.includes(":") ? `[${host}]` : host}:${port}`;
console.log(`Tripwire is running at ${url}\nPress Ctrl+C to stop.`);
if (values.open) openBrowser(url);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopping = true;
    void app
      .close()
      .then(() => engine.stop())
      .then(() => database.close())
      .then(() => process.exit(0));
  });
}

/**
 * The engine this start runs against: the stand-in when asked for, an
 * engine someone runs by hand when TRIPWIRE_ENGINE_URL names it, otherwise
 * the pinned release installed under TRIPWIRE_HOME, checked and started
 * here and stopped before the database closes.
 */
async function startEngine(
  database: StartedDatabase,
): Promise<{ backend: EngineBackend; stop(): Promise<void> }> {
  const none = () => Promise.resolve();
  if (process.env.TRIPWIRE_ENGINE === "stand-in") {
    const env = { ...process.env };
    delete env.TRIPWIRE_ENGINE_URL;
    return { backend: await connectEngine(database.pool, env), stop: none };
  }
  if (process.env.TRIPWIRE_ENGINE_URL) {
    return { backend: await connectEngine(database.pool), stop: none };
  }

  const home = tripwireHome();
  const pin = JSON.parse(
    readFileSync(new URL("./engine.json", import.meta.url), "utf8"),
  ) as EnginePin;
  try {
    const installed = await verifiedEngine({ home, pin });
    console.log(`Starting engine ${installed.version}.`);
    const running = await launchEngine({
      binary: installed.binary,
      home,
      databaseUrl: database.database.url,
      local: database.database.mode === "local",
    });
    void running.exited.then((code) => {
      if (!stopping) {
        console.error(
          `The engine exited with code ${code}; see ${running.logFile}. Restart Tripwire to start it again.`,
        );
      }
    });
    const backend = await connectEngine(database.pool, {
      ...process.env,
      TRIPWIRE_ENGINE_URL: running.url,
      TRIPWIRE_ENGINE_SECRET_FILE: running.secretFile,
      TRIPWIRE_CHAIN_ID: String(running.config.chainId),
      TRIPWIRE_RESPONSE_MODE: running.config.responseMode,
    });
    return { backend, stop: () => running.stop() };
  } catch (error) {
    if (
      !(error instanceof EngineReleaseError) &&
      !(error instanceof EngineLaunchError)
    ) {
      throw error;
    }
    await database.close();
    console.error(
      `${error.message}\n\nTo run without an engine, on simulated data: TRIPWIRE_ENGINE=stand-in tripwire start`,
    );
    process.exit(1);
  }
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
