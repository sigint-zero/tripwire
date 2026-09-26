import { PGlite } from "@electric-sql/pglite";
import net from "node:net";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { Pooler } from "./pooler";

let db: PGlite;
let pooler: Pooler;
let port: number;
const clients: pg.Client[] = [];

async function client() {
  const c = new pg.Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database: "tripwire",
  });
  c.on("error", () => {});
  await c.connect();
  clients.push(c);
  return c;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  db = await PGlite.create();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("DROP TABLE IF EXISTS t");
  pooler = new Pooler(db, { idleInTransactionMs: 400 });
  const endpoint = await pooler.listen({ host: "127.0.0.1", port: 0 });
  port = (endpoint as { port: number }).port;
  await db.exec("CREATE TABLE t (id int, who text)");
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.end().catch(() => {});
  await pooler.close();
});

async function rows() {
  const result = await db.query<{ who: string }>(
    "SELECT who FROM t ORDER BY id",
  );
  return result.rows.map((r) => r.who);
}

describe("Pooler", () => {
  it("makes a statement wait for another client's open transaction", async () => {
    const a = await client();
    const b = await client();
    await a.query("BEGIN");
    await a.query("INSERT INTO t VALUES (1, 'a')");

    let bFinished = 0;
    const bInsert = b
      .query("INSERT INTO t VALUES (2, 'b')")
      .then(() => (bFinished = Date.now()));
    await sleep(150);
    const aEnded = Date.now();
    await a.query("ROLLBACK");
    await bInsert;

    expect(bFinished).toBeGreaterThanOrEqual(aEnded);
    expect(await rows()).toEqual(["b"]);
  });

  it("never interleaves another client inside an extended-query sequence", async () => {
    // A sends Parse, pauses, then Bind/Execute/Sync. B's query must not
    // run in between, where it would destroy A's unnamed statement.
    const b = await client();
    const a = await rawClient(port);
    await a.send(parseMessage("SELECT 'from a' AS v"));
    await sleep(100);

    let bFinished = 0;
    const bQuery = b
      .query("SELECT 'from b' AS v")
      .then((r) => ((bFinished = Date.now()), r));
    await sleep(150);
    const aFinished = Date.now();
    await a.send(BIND_EXECUTE_SYNC);
    const answer = await a.until("Z");

    expect(answer).toContain("from a");
    expect(answer).not.toContain("does not exist");
    expect((await bQuery).rows[0]).toEqual({ v: "from b" });
    expect(bFinished).toBeGreaterThanOrEqual(aFinished);
    a.close();
  });

  it("keeps a client's unnamed statement from one sequence to its next", async () => {
    // A prepares in one sequence and binds in the next, as drivers that
    // avoid named statements do. B parses its own unnamed statement in
    // between, taking a parameter A's Bind does not supply.
    const a = await rawClient(port);
    const b = await client();
    await a.send(
      Buffer.concat([
        parseMessage("SELECT 'from a' AS v"),
        frame("D", Buffer.concat([Buffer.from("S"), text("")])),
        frame("S", Buffer.alloc(0)),
      ]),
    );
    await a.until("Z");
    expect((await b.query("SELECT $1::text AS v", ["from b"])).rows).toEqual([
      { v: "from b" },
    ]);
    await a.send(BIND_EXECUTE_SYNC);
    const answer = await a.until("Z");
    expect(answer).toContain("from a");
    expect(answer).not.toContain("bind message");
    // B's statement, replaced for A, is B's again when B binds it.
    expect((await b.query("SELECT $1::text AS v", ["b again"])).rows).toEqual([
      { v: "b again" },
    ]);
    a.close();
  });

  it("rolls back a client that disconnects mid-transaction", async () => {
    const a = await client();
    const b = await client();
    await a.query("BEGIN");
    await a.query("INSERT INTO t VALUES (1, 'a')");
    const bInsert = b.query("INSERT INTO t VALUES (2, 'b')");
    await sleep(50);
    // Kill A's connection without a word, as a crashed process would.
    (
      a as unknown as { connection: { stream: net.Socket } }
    ).connection.stream.destroy();
    await bInsert;

    const status = await b.query<{ open: boolean }>(
      "SELECT now() <> statement_timestamp() AS open",
    );
    expect(status.rows[0]?.open).toBe(false);
    expect(await rows()).toEqual(["b"]);
  });

  it("rolls back a transaction left idle, and lets the other client proceed", async () => {
    const a = await client();
    const b = await client();
    await a.query("BEGIN");
    await a.query("INSERT INTO t VALUES (1, 'a')");

    const started = Date.now();
    await b.query("INSERT INTO t VALUES (2, 'b')");
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);

    await expect(a.query("COMMIT")).rejects.toThrow();
    expect(await rows()).toEqual(["b"]);
  });

  it("serves waiting clients in arrival order", async () => {
    const a = await client();
    const others = await Promise.all([client(), client(), client()]);
    await a.query("BEGIN");
    const order: number[] = [];
    const waiting = others.map((c, i) =>
      c.query("SELECT 1").then(() => order.push(i)),
    );
    await sleep(100);
    await a.query("COMMIT");
    await Promise.all(waiting);
    expect(order).toEqual([0, 1, 2]);
  });

  it("keeps working after a client's statement fails", async () => {
    const a = await client();
    const b = await client();
    await expect(a.query("SELECT * FROM missing")).rejects.toThrow(
      /does not exist/,
    );
    await a.query("BEGIN");
    await expect(a.query("SELECT 1/0")).rejects.toThrow();
    // A's transaction is failed but open, so B still waits for it to end.
    const bInsert = b.query("INSERT INTO t VALUES (2, 'b')");
    await sleep(50);
    await a.query("ROLLBACK");
    await bInsert;
    expect(await rows()).toEqual(["b"]);
  });
});

// A bare wire-protocol client, for sending an extended-query sequence in
// separate writes, as a slow network or another driver might.

const frame = (type: string, body: Buffer) => {
  const out = Buffer.alloc(5 + body.length);
  out.write(type, 0, "latin1");
  out.writeInt32BE(4 + body.length, 1);
  body.copy(out, 5);
  return out;
};
const text = (s: string) => Buffer.from(`${s}\0`);
const parseMessage = (sql: string) =>
  frame("P", Buffer.concat([text(""), text(sql), Buffer.from([0, 0])]));
const BIND_EXECUTE_SYNC = Buffer.concat([
  frame("B", Buffer.concat([text(""), text(""), Buffer.alloc(6)])),
  frame("E", Buffer.concat([text(""), Buffer.alloc(4)])),
  frame("S", Buffer.alloc(0)),
]);

async function rawClient(port: number) {
  const socket = net.connect(port, "127.0.0.1");
  await new Promise((r) => socket.once("connect", r));
  let received = Buffer.alloc(0);
  socket.on("data", (d: Buffer) => (received = Buffer.concat([received, d])));
  const params = Buffer.concat([
    text("user"),
    text("postgres"),
    text("database"),
    text("tripwire"),
    Buffer.from([0]),
  ]);
  const startup = Buffer.alloc(8 + params.length);
  startup.writeInt32BE(8 + params.length, 0);
  startup.writeInt32BE(196_608, 4);
  params.copy(startup, 8);

  const raw = {
    send: (bytes: Buffer) =>
      new Promise<void>((r) => socket.write(bytes, () => r())),
    /** Waits for a message of `type`, returns everything received, and clears it. */
    async until(type: string) {
      for (let i = 0; i < 100; i++) {
        if (received.includes(Buffer.from(type)) && received.at(-6) === 0x5a) {
          break;
        }
        await sleep(20);
      }
      const seen = received.toString("latin1");
      received = Buffer.alloc(0);
      return seen;
    },
    close: () => socket.destroy(),
  };
  await raw.send(startup);
  await raw.until("Z");
  return raw;
}
