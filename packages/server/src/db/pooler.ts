import { rm, stat } from "node:fs/promises";
import net from "node:net";
import {
  lastReadyStatus,
  queryMessage,
  splitFrames,
  SYNC,
  unnamedStatement,
  type TransactionStatus,
} from "./wire";

/** What the pooler needs of the database: PGlite's raw protocol interface. */
export interface ProtocolDatabase {
  execProtocolRaw(message: Uint8Array): Promise<Uint8Array>;
}

export type Endpoint = { path: string } | { host: string; port: number };

export interface PoolerOptions {
  /** How long a client may hold an open transaction without sending anything. */
  idleInTransactionMs?: number;
}

interface Client {
  socket: net.Socket;
  buffer: Buffer;
  started: boolean;
  /** Whole messages waiting to be sent to the database. */
  pending: Uint8Array[];
  /** The session was idle after this client's last message, so its lease can end. */
  idle: boolean;
  pumping: boolean;
  closed: boolean;
  idleTimer?: NodeJS.Timeout;
  /** Its last Parse of the unnamed statement, to restore after another client's replaced it. */
  unnamed: Uint8Array | null;
}

/**
 * Serves one PGlite session to many wire-protocol clients by leasing it
 * to one client transaction at a time. A client takes the lease with its
 * first message while the session is free, and keeps it until the
 * database reports the session idle again (ReadyForQuery with status I),
 * so neither a transaction nor an extended-query sequence is ever
 * interleaved with another client's statements. Waiting clients are
 * served in arrival order. A client that disconnects or sits idle inside
 * a transaction is rolled back before the next lease.
 *
 * The session has one unnamed prepared statement, and a driver may parse
 * it in one sequence and bind it in the next, with another client's lease
 * in between. The pooler keeps each client's last unnamed Parse and
 * replays it before the client uses the statement, when another's has
 * taken its place.
 */
export class Pooler {
  readonly #db: ProtocolDatabase;
  readonly #idleInTransactionMs: number;
  #server: net.Server | null = null;
  #holder: Client | null = null;
  readonly #waiting: Client[] = [];
  readonly #clients = new Set<Client>();
  #onFree: (() => void) | null = null;
  /** Whose Parse the session's unnamed statement is now. */
  #unnamedOwner: Client | null = null;

  constructor(db: ProtocolDatabase, options: PoolerOptions = {}) {
    this.#db = db;
    this.#idleInTransactionMs = options.idleInTransactionMs ?? 30_000;
  }

  /** Starts accepting clients; returns where, with the port filled in. */
  async listen(endpoint: Endpoint): Promise<Endpoint> {
    if (this.#server) throw new Error("The pooler is already listening.");
    const server = net.createServer((socket) => this.#accept(socket));
    this.#server = server;
    if ("path" in endpoint) {
      // A socket file left by a process that is gone would block the bind.
      const existing = await stat(endpoint.path).catch(() => null);
      if (existing?.isSocket()) await rm(endpoint.path);
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      const done = () => {
        server.off("error", reject);
        resolve();
      };
      if ("path" in endpoint) server.listen(endpoint.path, done);
      else server.listen(endpoint.port, endpoint.host, done);
    });
    if ("path" in endpoint) return endpoint;
    const address = server.address() as net.AddressInfo;
    return { host: endpoint.host, port: address.port };
  }

  /** Stops accepting, disconnects every client and rolls back what they left open. */
  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    const closed = server
      ? new Promise<void>((resolve) => server.close(() => resolve()))
      : Promise.resolve();
    for (const client of [...this.#clients]) {
      client.socket.destroy();
      this.#drop(client);
    }
    if (this.#holder) {
      await new Promise<void>((resolve) => (this.#onFree = resolve));
    }
    await closed;
  }

  #accept(socket: net.Socket) {
    const client: Client = {
      socket,
      buffer: Buffer.alloc(0),
      started: false,
      pending: [],
      idle: true,
      pumping: false,
      closed: false,
      unnamed: null,
    };
    this.#clients.add(client);
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.#receive(client, chunk));
    socket.on("close", () => this.#drop(client));
    socket.on("error", () => this.#drop(client));
  }

  #receive(client: Client, chunk: Buffer) {
    if (client.closed) return;
    const split = splitFrames(
      Buffer.concat([client.buffer, chunk]),
      client.started,
    );
    client.buffer = Buffer.from(split.rest);
    client.started = split.started;
    for (const frame of split.frames) {
      if (frame.kind === "ssl" || frame.kind === "gssenc") {
        // Neither is offered: the endpoint is a local socket.
        client.socket.write("N");
      } else if (frame.kind === "cancel") {
        // Cancelling is not supported; the requesting connection just ends.
        client.socket.end();
        return;
      } else if (frame.kind === "message" && frame.type === "X") {
        client.socket.end();
        this.#drop(client);
        return;
      } else {
        client.pending.push(Uint8Array.from(frame.bytes));
      }
    }
    if (client.pending.length > 0) this.#request(client);
  }

  #request(client: Client) {
    if (client.closed) return;
    if (!this.#holder) this.#holder = client;
    if (this.#holder === client) void this.#pump(client);
    else if (!this.#waiting.includes(client)) this.#waiting.push(client);
  }

  async #pump(client: Client): Promise<void> {
    if (client.pumping) return;
    client.pumping = true;
    clearTimeout(client.idleTimer);
    try {
      while (this.#holder === client && !client.closed) {
        const message = client.pending.shift();
        if (!message) break;
        const failed = await this.#unnamed(client, message);
        if (failed && !client.socket.destroyed) client.socket.write(failed);
        const response = await this.#db.execProtocolRaw(message);
        if (response.length > 0 && !client.socket.destroyed) {
          client.socket.write(response);
        }
        // Until the database reports idle, this client is mid-transaction
        // or mid-sequence and keeps the session.
        const status = lastReadyStatus(response);
        client.idle = status === "I";
      }
    } catch {
      client.socket.destroy();
      client.closed = true;
      client.idle = false;
    } finally {
      client.pumping = false;
    }
    if (this.#holder !== client) return;
    if (client.closed) return this.#endLease(client);
    if (client.pending.length > 0) return this.#pump(client);
    if (client.idle) return this.#endLease(client);
    client.idleTimer = setTimeout(
      () => this.#expire(client),
      this.#idleInTransactionMs,
    );
  }

  /**
   * Keeps track of the unnamed statement before `message` runs, restoring
   * the client's own when `message` uses it. Returns the database's error
   * when that Parse no longer succeeds, for the client to see.
   */
  async #unnamed(
    client: Client,
    message: Uint8Array,
  ): Promise<Uint8Array | null> {
    const effect = unnamedStatement(message);
    if (effect === "parse") {
      client.unnamed = message;
      this.#unnamedOwner = client;
    } else if (effect === "destroy") {
      if (message[0] === 0x43) client.unnamed = null;
      this.#unnamedOwner = null;
    } else if (
      effect === "use" &&
      client.unnamed &&
      this.#unnamedOwner !== client
    ) {
      const replayed = await this.#db.execProtocolRaw(client.unnamed);
      this.#unnamedOwner = client;
      // ParseComplete alone is the client's own earlier answer, not sent again.
      if (replayed.length !== 5 || replayed[0] !== 0x31) return replayed;
    }
    return null;
  }

  /** Ends a transaction left idle too long, and the connection that left it. */
  #expire(client: Client) {
    if (this.#holder !== client || client.pumping || client.closed) return;
    if (!client.socket.destroyed) {
      client.socket.end(
        errorResponse(
          "25P03",
          "terminating connection due to idle-in-transaction timeout",
        ),
      );
    }
    this.#drop(client);
  }

  #drop(client: Client) {
    if (client.closed && !this.#clients.has(client)) return;
    client.closed = true;
    clearTimeout(client.idleTimer);
    this.#clients.delete(client);
    const index = this.#waiting.indexOf(client);
    if (index >= 0) this.#waiting.splice(index, 1);
    if (this.#holder === client && !client.pumping) void this.#endLease(client);
  }

  /** Hands the session to the next waiting client, rolling back first if needed. */
  async #endLease(client: Client) {
    if (this.#holder !== client) return;
    if (!client.idle) await this.#rollBack();
    this.#holder = null;
    let next = this.#waiting.shift();
    while (next?.closed) next = this.#waiting.shift();
    if (next) {
      this.#holder = next;
      void this.#pump(next);
    } else if (this.#onFree) {
      this.#onFree();
      this.#onFree = null;
    }
  }

  /**
   * Leaves the session idle without committing anything the last client
   * left open: a transaction block, or an extended-query sequence that
   * never reached its Sync.
   */
  async #rollBack() {
    // A simple query destroys the unnamed statement.
    this.#unnamedOwner = null;
    try {
      // Aborts an open implicit or explicit transaction; ignored when an
      // extended-query error is waiting for its Sync.
      await this.#db.execProtocolRaw(queryMessage("ROLLBACK"));
      const status: TransactionStatus | null = lastReadyStatus(
        await this.#db.execProtocolRaw(SYNC),
      );
      if (status !== "I") {
        await this.#db.execProtocolRaw(queryMessage("ROLLBACK"));
      }
    } catch {
      // The database itself failed; there is nothing further to undo here.
    }
  }
}

/** A FATAL ErrorResponse, sent before the pooler closes a connection. */
function errorResponse(code: string, message: string): Buffer {
  const fields = Buffer.from(
    `SFATAL\0VFATAL\0C${code}\0M${message}\0\0`,
    "utf8",
  );
  const frame = Buffer.alloc(5 + fields.length);
  frame.write("E", 0, "latin1");
  frame.writeInt32BE(4 + fields.length, 1);
  fields.copy(frame, 5);
  return frame;
}
