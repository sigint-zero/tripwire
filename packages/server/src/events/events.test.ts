import type { StoredRuleCheck } from "@tripwire/shared";
import type { FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import { createServer as createHttpServer, type Server } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "../app";
import { ViewReads } from "../engine/reads";
import { STUB_VIEWS, StubEngine } from "../engine/stub";
import { signIn, TEST_COST, testDatabase, testHome } from "../testing";
import { BrowserRelay, QUEUE_LIMIT, STREAMS_PER_SESSION } from "./relay";
import type { EngineEvents, EngineListener } from "./types";
import { EngineStream } from "./upstream";

/** Reads a server-sent event stream as it arrives. */
function reader(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  const iterator = body[Symbol.asyncIterator]();
  let buffer = "";
  return {
    async next(): Promise<{ event: string; data: unknown }> {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (block.startsWith(":")) continue;
          const field = (name: string) =>
            block
              .split("\n")
              .find((l) => l.startsWith(`${name}: `))
              ?.slice(name.length + 2);
          return {
            event: field("event") ?? "message",
            data: JSON.parse(field("data") ?? "null") as unknown,
          };
        }
        const { value, done } = await iterator.next();
        if (done) throw new Error("The stream ended.");
        buffer += decoder.decode(value, { stream: true });
      }
    },
  };
}

describe("the browser stream", () => {
  let app: FastifyInstance;
  let stub: StubEngine;
  let base: string;
  let cookie: string;
  let clock = Date.UTC(2026, 8, 1);
  const cleanup: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    const database = await testDatabase();
    const home = await testHome();
    stub = await StubEngine.open(database.pool, () => clock);
    app = await createServer({
      backend: {
        pool: database.pool,
        engine: {
          commands: stub,
          reads: new ViewReads(database.pool, STUB_VIEWS),
          events: stub,
          info: { chainId: 1, responseMode: "prepare", simulated: true },
          close: () => Promise.resolve(),
        },
      },
      home: home.home,
      passwordCost: TEST_COST,
    });
    cookie = await signIn(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    cleanup.push(
      () => app.close(),
      () => database.close(),
      () => home.remove(),
    );
  });
  afterAll(async () => {
    for (const step of cleanup) await step();
  });

  it("refuses anyone without a session, MCP tokens included", async () => {
    expect((await fetch(`${base}/api/v1/events`)).status).toBe(401);
    const agent = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mcp-tokens",
      payload: { label: "agent" },
    });
    const { token } = agent.json<{ token: string }>();
    const refused = await fetch(`${base}/api/v1/events`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(refused.status).toBe(401);
  });

  it("starts with resync, then says what changed", async () => {
    const token = "0x5555555555555555555555555555555555555555";
    await app.inject({
      method: "POST",
      url: "/api/v1/contracts",
      payload: { address: token, name: "Token", abi: [] },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/rules",
      payload: {
        rule: {
          version: 1,
          name: "Supply above one",
          contract: token,
          severity: "critical",
          when: "every_block",
          trip_when: {
            node: "compare",
            op: "gt",
            left: {
              node: "view_call",
              function: "totalSupply() returns (uint256)",
              args: [],
            },
            right: { node: "literal", value: "1" },
          },
          on_trip: { action: "notify" },
        },
      },
    });
    const ruleId = created.json<StoredRuleCheck>().id;

    const stop = new AbortController();
    const response = await fetch(`${base}/api/v1/events`, {
      headers: { cookie },
      signal: stop.signal,
    });
    expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const events = reader(response.body!);
    expect(await events.next()).toEqual({
      event: "resync",
      data: { reason: "connected" },
    });

    clock += 12_000;
    await stub.tick();
    expect(await events.next()).toMatchObject({ event: "block" });
    expect(await events.next()).toMatchObject({
      event: "violation",
      data: { ruleId, contractAddress: token, kind: "tripped" },
    });

    await app.inject({
      method: "PATCH",
      url: `/api/v1/rules/${ruleId}`,
      payload: { enabled: false },
    });
    expect(await events.next()).toMatchObject({
      event: "rule_state",
      data: { ruleId, enabled: false },
    });
    stop.abort();
  });
});

/** A response that accepts writes until told it is full. */
class FakeResponse extends EventEmitter {
  chunks: string[] = [];
  full = false;
  ended = false;
  write(chunk: string) {
    this.chunks.push(chunk);
    return !this.full;
  }
  end() {
    this.ended = true;
  }
  asResponse() {
    return this as unknown as ServerResponse;
  }
}

class FakeEngine implements EngineEvents {
  listener: EngineListener | null = null;
  listen(listener: EngineListener) {
    this.listener = listener;
    return () => (this.listener = null);
  }
}

const valid = () => Promise.resolve(true);
const named = (out: FakeResponse) =>
  out.chunks.map((c) => /event: (\w+)/.exec(c)?.[1]).filter(Boolean);

describe("the relay", () => {
  it("tells a tab that cannot keep up to resync, and closes it", () => {
    const engine = new FakeEngine();
    const relay = new BrowserRelay(engine, () => {});
    const slow = new FakeResponse();
    const fine = new FakeResponse();
    relay.open("s1", slow.asResponse(), valid);
    relay.open("s2", fine.asResponse(), valid);
    slow.full = true;
    const violation = (id: number) =>
      engine.listener!.event({
        event: "violation",
        data: { id, rule_id: 1, kind: "tripped" },
      });
    violation(0); // accepted, then the socket reports it is full
    for (let i = 1; i <= QUEUE_LIMIT; i++) violation(i);
    expect(slow.ended).toBe(false);
    violation(QUEUE_LIMIT + 1);
    expect(slow.ended).toBe(true);
    expect(slow.chunks.at(-1)).toContain('"reason":"behind"');
    expect(fine.ended).toBe(false);
    expect(named(fine)).toHaveLength(QUEUE_LIMIT + 3);
    relay.close();
  });

  it("keeps ten streams a session, closing the oldest", () => {
    const relay = new BrowserRelay(new FakeEngine(), () => {});
    const outs = Array.from({ length: STREAMS_PER_SESSION + 1 }, () => {
      const out = new FakeResponse();
      relay.open("same", out.asResponse(), valid);
      return out;
    });
    expect(outs[0]!.ended).toBe(true);
    expect(outs.slice(1).every((o) => !o.ended)).toBe(true);
    expect(relay.size).toBe(STREAMS_PER_SESSION);
    relay.close();
  });

  it("passes at most one block a second, the latest winning", () => {
    vi.useFakeTimers();
    const engine = new FakeEngine();
    const relay = new BrowserRelay(engine, () => {});
    const out = new FakeResponse();
    relay.open("s", out.asResponse(), valid);
    for (let n = 1; n <= 4; n++) {
      engine.listener!.event({
        event: "block",
        data: { number: n, hash: "0x", time: "t" },
      });
    }
    const blocks = () => out.chunks.filter((c) => c.includes("event: block"));
    expect(blocks()).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(blocks()).toHaveLength(2);
    expect(blocks()[1]).toContain('"number":4');
    relay.close();
    vi.useRealTimers();
  });

  it("turns an event it cannot read into a resync", () => {
    const engine = new FakeEngine();
    const relay = new BrowserRelay(engine, () => {});
    const out = new FakeResponse();
    relay.open("s", out.asResponse(), valid);
    engine.listener!.event({ event: "violation", data: "garbage" });
    engine.listener!.event({ event: "something_new", data: {} });
    expect(named(out)).toEqual(["resync", "resync"]);
    relay.close();
  });
});

describe("the engine's stream", () => {
  let server: Server;
  let url: string;
  let handle: (res: ServerResponse, auth: string | undefined) => void;

  beforeAll(async () => {
    server = createHttpServer((req, res) =>
      handle(res, req.headers.authorization),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const sse = (res: ServerResponse, body: string) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(body);
  };

  it("reads events, and resyncs on every connection and on garbage", async () => {
    let connections = 0;
    handle = (res) => {
      connections++;
      sse(
        res,
        connections === 1
          ? 'id: 1\nevent: block\ndata: {"number":7,\ndata: "time":"t"}\n\nevent: violation\ndata: not json\n\n'
          : ": hello\n\n",
      );
    };
    const seen: string[] = [];
    const stream = new EngineStream({
      url,
      secret: () => Promise.resolve("s"),
      log: { warn: () => {}, error: () => {} },
    });
    const stop = stream.listen({
      event: (e) => seen.push(`${e.event}:${JSON.stringify(e.data)}`),
      resync: (reason) => seen.push(`resync:${reason}`),
    });
    await vi.waitFor(() => expect(connections).toBe(2), { timeout: 3_000 });
    stop();
    expect(seen.slice(0, 4)).toEqual([
      "resync:upstream",
      'block:{"number":7,"time":"t"}',
      "resync:upstream",
      "resync:upstream",
    ]);
  });

  it("reads the secret again once when refused, then stays closed", async () => {
    let reads = 0;
    handle = (res) => {
      res.writeHead(401);
      res.end();
    };
    const resyncs: string[] = [];
    const stream = new EngineStream({
      url,
      secret: () => Promise.resolve(`s${++reads}`),
      log: { warn: () => {}, error: () => {} },
    });
    const stop = stream.listen({
      event: () => {},
      resync: (reason) => resyncs.push(reason),
    });
    await vi.waitFor(() => expect(resyncs).toEqual(["engine"]));
    expect(reads).toBe(2);
    stop();
  });
});
