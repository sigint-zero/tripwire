import {
  createServer,
  DatabaseSetupError,
  startDatabase,
  tripwireHome,
} from "@tripwire/server";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const USAGE = `Usage: tripwire [start] [options]

Starts Tripwire and serves the dashboard.

Options:
  -p, --port <port>         port to listen on (default: 4747)
      --host <host>         address to listen on (default: 127.0.0.1)
      --database-url <url>  use this PostgreSQL database for this run
      --open                open the dashboard in your browser
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

const app = await createServer({
  webRoot: fileURLToPath(new URL("./web", import.meta.url)),
  allowedHosts: [host],
});

try {
  await app.listen({ host, port });
} catch (error) {
  await database.close();
  const message = listenErrorMessage(error as NodeJS.ErrnoException);
  if (!message) throw error;
  console.error(message);
  process.exit(1);
}

const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
console.log(`Tripwire is running at ${url}\nPress Ctrl+C to stop.`);
if (values.open) openBrowser(url);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => database.close())
      .then(() => process.exit(0));
  });
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
