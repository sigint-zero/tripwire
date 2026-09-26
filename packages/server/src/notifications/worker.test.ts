import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ViewReads } from "../engine/reads";
import { STUB_VIEWS, StubEngine } from "../engine/stub";
import { testDatabase, testHome } from "../testing";
import { ChannelSecrets } from "./secrets";
import { NotificationStore } from "./store";
import { NotificationWorker, retryDelayMs } from "./worker";

// Delivery against a local receiver: dispatch by filter, signed webhooks,
// retries that keep every message, and a storm folded into one digest.

const token = "0x5555555555555555555555555555555555555555";

interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let receiver: Server;
let url: string;
let received: Received[] = [];
let failWith = 0;

let now = Date.now();
let pool: pg.Pool;
let stub: StubEngine;
let store: NotificationStore;
let secrets: ChannelSecrets;
let worker: NotificationWorker;
const cleanup: (() => Promise<void>)[] = [];

const rule = (name: string, severity: string, cooldown = 0) => ({
  version: 1,
  name,
  contract: token,
  severity,
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
  on_trip: { action: "notify", cooldown_seconds: cooldown },
});

/** Every rule trips once more. */
async function block() {
  now += 12_000;
  await stub.tick();
}

async function channel(
  name: string,
  change: Partial<{
    kinds: string[];
    min_severity: string;
    storm_limit: number;
  }> = {},
) {
  const id = await store.createChannel({
    name,
    type: "webhook",
    enabled: true,
    kinds: (change.kinds ?? [
      "violation",
      "response",
      "health",
      "system",
    ]) as never,
    min_severity: (change.min_severity ?? "info") as never,
    storm_limit: change.storm_limit ?? 0,
    settings: {},
  });
  await secrets.set(id, { url, signingKey: `key-${id}` });
  return id;
}

beforeAll(async () => {
  receiver = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      received.push({ headers: request.headers, body });
      response.writeHead(failWith || 200);
      response.end(failWith ? "down for maintenance" : "ok");
    });
  });
  await new Promise<void>((resolve) =>
    receiver.listen(0, "127.0.0.1", resolve),
  );
  url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;

  const database = await testDatabase();
  const home = await testHome();
  pool = database.pool;
  stub = await StubEngine.open(pool, () => now, "notify");
  const reads = new ViewReads(pool, STUB_VIEWS);
  store = new NotificationStore(pool, STUB_VIEWS);
  secrets = new ChannelSecrets(home.home);
  worker = new NotificationWorker({
    store,
    secrets,
    reads,
    clock: () => now,
    log: () => {},
  });
  cleanup.push(
    () => database.close(),
    () => home.remove(),
    () => new Promise((resolve) => receiver.close(() => resolve())),
  );
  await stub.registerContract({
    address: token,
    name: "Treasury vault",
    abi: [],
  });
});
afterAll(async () => {
  for (const step of cleanup) await step();
});
beforeEach(() => {
  received = [];
  failWith = 0;
});

describe("delivery", () => {
  let critical: string;
  let warningRule: string;

  it("sends a signed envelope to each matching channel, once", async () => {
    const all = await channel("Everything");
    const loud = await channel("Critical only", { min_severity: "critical" });
    critical = (
      await stub.createRule({
        document: rule("Supply floor", "critical") as never,
        enabled: true,
        origin: "app",
      })
    ).id;
    await block();
    await worker.tick();
    await worker.tick();

    expect(received).toHaveLength(2);
    for (const [i, id] of [all, loud].entries()) {
      const { headers, body } = received.find(
        (r) =>
          r.headers["tripwire-signature"] ===
          `sha256=${createHmac("sha256", `key-${id}`)
            .update(`${String(r.headers["tripwire-timestamp"])}.${r.body}`)
            .digest("hex")}`,
      ) ?? { headers: {}, body: "" };
      expect(headers["tripwire-timestamp"], `channel ${i}`).toBeDefined();
      expect(JSON.parse(body)).toMatchObject({
        id: expect.stringMatching(/^engine:\d+$/) as unknown,
        source: "engine",
        kind: "violation",
        severity: "critical",
        title: "Treasury vault: Supply floor tripped",
        event: { rule_id: Number(critical) },
      });
    }
  });

  it("holds to the filters: severity and kind", async () => {
    await stub.setRuleEnabled(critical, false);
    warningRule = (
      await stub.createRule({
        document: rule("Soft floor", "warning") as never,
        enabled: true,
        origin: "app",
      })
    ).id;
    await block();
    await worker.tick();
    // Only the unfiltered channel hears a warning.
    expect(
      received.map((r) => JSON.parse(r.body) as { title: string }),
    ).toEqual([
      expect.objectContaining({ title: "Treasury vault: Soft floor tripped" }),
    ]);
  });

  it("keeps a message the receiver refuses, and retries it later", async () => {
    failWith = 503;
    await block();
    await worker.tick();
    const [row] = (
      await pool.query<{ attempts: number; last_error: string; wait: number }>(
        `SELECT attempts, last_error,
                extract(epoch FROM next_attempt_at - now())::float AS wait
           FROM app.deliveries WHERE delivered_at IS NULL`,
      )
    ).rows;
    expect(row).toMatchObject({ attempts: 1 });
    expect(row!.last_error).toMatch(/answered 503: down for maintenance/);
    expect(row!.wait).toBeGreaterThan(20);
    expect(row!.wait).toBeLessThan(40);

    // Due again, it goes through, and nothing was lost.
    failWith = 0;
    received = [];
    await pool.query(
      "UPDATE app.deliveries SET next_attempt_at = now() WHERE delivered_at IS NULL",
    );
    await worker.tick();
    expect(received).toHaveLength(1);
    const { rows } = await pool.query(
      "SELECT 1 FROM app.deliveries WHERE delivered_at IS NULL",
    );
    expect(rows).toEqual([]);
    await stub.setRuleEnabled(warningRule, false);
  });

  it("folds a storm into one digest at the end of the minute", async () => {
    await pool.query("DELETE FROM app.channels");
    await channel("Stormy", { storm_limit: 2 });
    for (let i = 0; i < 5; i++) {
      await stub.createRule({
        document: rule(`Storm ${i}`, "critical") as never,
        enabled: true,
        origin: "app",
      });
    }
    await block();
    await worker.tick();
    expect(received).toHaveLength(2);

    // The next minute: the three held back go out together.
    received = [];
    now += 60_000;
    await pool.query(
      "UPDATE app.deliveries SET next_attempt_at = now() WHERE delivered_at IS NULL",
    );
    await worker.tick();
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!.body)).toMatchObject({
      kind: "digest",
      title: "3 more notifications in the last minute",
      text: "3 violations on Treasury vault.",
    });
    const { rows } = await pool.query<{ digest_id: string | null }>(
      "SELECT digest_id FROM app.deliveries WHERE delivered_at IS NOT NULL AND digest_id IS NOT NULL",
    );
    expect(rows).toHaveLength(3);
  });
});

describe("retries", () => {
  it("wait 30 seconds, doubling to an hour, a tenth either way", () => {
    const middle = () => 0.5;
    expect(retryDelayMs(1, middle)).toBe(30_000);
    expect(retryDelayMs(2, middle)).toBe(60_000);
    expect(retryDelayMs(20, middle)).toBe(3_600_000);
    expect(retryDelayMs(1, () => 0)).toBe(27_000);
    expect(retryDelayMs(1, () => 1)).toBe(33_000);
  });
});
