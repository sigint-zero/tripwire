import type {
  Channel,
  ChannelTest,
  NotificationPage,
  StoredRuleCheck,
} from "@tripwire/shared";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { stat } from "node:fs/promises";
import { createServer as createHttp, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../app";
import { ViewReads } from "../engine/reads";
import { STUB_VIEWS, StubEngine } from "../engine/stub";
import { signIn, TEST_COST, testDatabase, testHome } from "../testing";

// The feed, its read marks, and the channels, as the dashboard uses them.

const token = "0x5555555555555555555555555555555555555555";
const tripping = (name: string, onTrip: object) => ({
  version: 1,
  name,
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
  on_trip: onTrip,
});

let now = Date.now();
let app: FastifyInstance;
let stub: StubEngine;
let pool: pg.Pool;
let home: string;
let receiver: Server;
let hook: string;
const cleanup: (() => Promise<void>)[] = [];

const get = <T>(url: string) =>
  app.inject({ url: `/api/v1${url}` }).then((res) => res.json<T>());
const send = (
  method: "POST" | "PUT" | "DELETE",
  url: string,
  payload?: object,
) =>
  app.inject({ method, url: `/api/v1${url}`, ...(payload ? { payload } : {}) });
const block = async () => {
  now += 12_000;
  await stub.tick();
};

beforeAll(async () => {
  receiver = createHttp((request, response) => {
    request.resume();
    request.on("end", () => response.writeHead(204).end());
  });
  await new Promise<void>((resolve) =>
    receiver.listen(0, "127.0.0.1", resolve),
  );
  hook = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;

  const database = await testDatabase();
  pool = database.pool;
  const dir = await testHome();
  home = dir.home;
  stub = await StubEngine.open(database.pool, () => now, "prepare");
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
    home,
    passwordCost: TEST_COST,
  });
  cleanup.push(
    () => app.close(),
    () => database.close(),
    () => dir.remove(),
    () => new Promise((resolve) => receiver.close(() => resolve())),
  );
  await signIn(app);
  await send("POST", "/contracts", { address: token, name: "Token", abi: [] });
});
afterAll(async () => {
  for (const step of cleanup) await step();
});

describe("the feed", () => {
  let ruleId: string;

  it("shows a trip once per quiet period, rendered to read at 3am", async () => {
    ruleId = (
      await send("POST", "/rules", {
        rule: tripping("Supply floor", {
          action: "notify",
          cooldown_seconds: 300,
        }),
      })
    ).json<StoredRuleCheck>().id;
    await block();
    await block();
    const feed = await get<NotificationPage>("/notifications");
    expect(feed.items).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^engine:\d+$/) as unknown,
        source: "engine",
        kind: "violation",
        severity: "critical",
        title: "Token: Supply floor tripped",
        link: `/violations?rule=${ruleId}`,
        read: false,
      }),
    ]);
    expect(feed.items[0]!.text).toMatch(/Block \d+\./);
    expect(await get("/notifications/unread-count")).toEqual({ count: 1 });
  });

  it("says a response is waiting, as the moment a person must act", async () => {
    await send("POST", "/rules", {
      rule: tripping("Pause it", { action: "trip_global" }),
    });
    await block();
    const feed = await get<NotificationPage>("/notifications?kind=response");
    expect(feed.items).toEqual([
      expect.objectContaining({
        severity: "critical",
        title: "Token: pause waiting for approval",
        link: expect.stringMatching(
          /^\/responses\?tab=waiting&open=\d+$/,
        ) as unknown,
      }),
    ]);
  });

  it("names the rule behind a settled response, and a pause by hand", async () => {
    const [waiting] = (
      await get<NotificationPage>("/notifications?kind=response")
    ).items;
    const responseId = /open=(\d+)/.exec(waiting!.link!)![1]!;
    await send("POST", `/responses/${responseId}/approve`);
    await block();
    await block();
    // Settled, the engine's note names only the response and its receipt.
    const confirmed = (
      await get<NotificationPage>("/notifications?kind=response")
    ).items[0]!;
    expect(confirmed).toMatchObject({
      severity: "info",
      title: "Token: pause confirmed",
      link: `/responses?tab=history&open=${responseId}`,
    });
    expect(confirmed.text).toMatch(
      /^From Pause it\. Transaction 0x[0-9a-f]+\. Block \d+\.$/,
    );

    // A locked signing key holds a response up.
    await pool.query(
      "INSERT INTO stub.notifications (kind, payload) VALUES ('response', $1)",
      [
        JSON.stringify({
          response_id: Number(responseId),
          rule_id: 1,
          rule: "Pause it",
          severity: "critical",
          contract: token,
          action: "trip_global",
          status: "pending",
          detail: "the signing key is locked",
        }),
      ],
    );
    // A person paused the contract from the dashboard.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO stub.actions (kind, target, note, status)
       VALUES ('trip_global', $1, 'Draining, pausing now', 'confirmed') RETURNING id::text`,
      [token],
    );
    await pool.query(
      "INSERT INTO stub.notifications (kind, payload) VALUES ('action', $1)",
      [
        JSON.stringify({
          id: Number(rows[0]!.id),
          status: "confirmed",
          tx_hash: "0xab",
          block_number: 7,
        }),
      ],
    );
    const items = (await get<NotificationPage>("/notifications?kind=response"))
      .items;
    const manual = items.find((i) => i.title.includes("by hand"));
    const held = items.find((i) => i.title.includes("held up"));
    expect(manual).toMatchObject({
      kind: "response",
      severity: "info",
      title: "Token: pause by hand confirmed",
      text: "“Draining, pausing now” Transaction 0xab. Block 7.",
      link: "/activity",
    });
    expect(held).toMatchObject({
      severity: "critical",
      title: "Token: pause held up",
      text: "From Pause it. The signing key is locked.",
      link: `/responses?tab=in_flight&open=${responseId}`,
    });
  });

  it("reads the engine's health and a broken rule as it records them", async () => {
    const record = (kind: string, payload: object) =>
      pool.query(
        "INSERT INTO stub.notifications (kind, payload) VALUES ($1, $2)",
        [kind, JSON.stringify(payload)],
      );
    await record("health", { status: "starting", cause: null, previous: null });
    await record("health", {
      status: "degraded",
      cause: "the RPC stopped answering",
      previous: "ready",
    });
    await record("health", {
      status: "ready",
      cause: null,
      previous: "degraded",
    });
    await record("violation", {
      violation_id: 99,
      rule_id: 1,
      rule: "Pause it",
      contract: token,
      severity: "critical",
      kind: "evaluation_error",
      block_number: 12,
      tx_hash: null,
      evidence: { path: "/trip_when/left", error: "execution reverted" },
    });
    await record("violation", {
      violation_id: 100,
      rule_id: 1,
      rule: "Pause it",
      contract: token,
      severity: "critical",
      kind: "pending",
      block_number: 12,
      tx_hash: "0xfeed",
    });
    const pending = (
      await get<NotificationPage>("/notifications?kind=violation")
    ).items.find((i) => i.title.endsWith("would trip"));
    expect(pending).toMatchObject({
      severity: "critical",
      title: "Token: Pause it would trip",
      text: "Seen in the mempool, not yet on chain; a landing is recorded as its own violation. Transaction 0xfeed.",
    });
    const health = (await get<NotificationPage>("/notifications?kind=health"))
      .items;
    expect(health.map((i) => [i.title, i.severity]).sort()).toEqual([
      ["Engine caught up", "info"],
      ["Engine degraded: the RPC stopped answering", "warning"],
      ["Engine starting", "info"],
    ]);
    const [broken] = (
      await get<NotificationPage>("/notifications?kind=evaluation_error")
    ).items;
    expect(broken).toMatchObject({
      title: "Token: Pause it could not be evaluated",
      text: "Block 12. Execution reverted at /trip_when/left.",
    });
  });

  it("pages with a cursor, and filters by severity and unread", async () => {
    const first = await get<NotificationPage>("/notifications?limit=1");
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await get<NotificationPage>(
      `/notifications?limit=1&cursor=${first.nextCursor}`,
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    const info = (await get<NotificationPage>("/notifications?severity=info"))
      .items;
    expect(info.length).toBeGreaterThan(0);
    expect(info.every((i) => i.severity === "info")).toBe(true);
    expect(
      (await app.inject({ url: "/api/v1/notifications?cursor=nope" }))
        .statusCode,
    ).toBe(400);
  });

  it("marks one read, then all", async () => {
    const { items } = await get<NotificationPage>("/notifications");
    const before = items.length;
    const one = await send("POST", "/notifications/read", {
      ids: [items[0]!.id],
    });
    expect(one.json()).toEqual({ count: before - 1 });
    expect(
      (await get<NotificationPage>("/notifications?unread=true")).items,
    ).toHaveLength(before - 1);
    expect(
      (await send("POST", "/notifications/read", { all: true })).json(),
    ).toEqual({ count: 0 });
  });
});

describe("channels", () => {
  let id: string;

  it("creates a webhook, generating a signing key it shows once", async () => {
    const res = await send("POST", "/channels", {
      name: "Ops webhook",
      type: "webhook",
      secrets: { url: hook },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<Channel & { signingKey: string }>();
    id = created.id;
    expect(created).toMatchObject({
      kinds: ["violation", "response", "health", "system"],
      minSeverity: "info",
      stormLimit: 0,
      secretsSet: ["signingKey", "url"],
    });
    expect(created.signingKey).toMatch(/^[0-9a-f]{64}$/);

    // Never read back, and kept where only the owner can read them.
    const listed = await app.inject({ url: "/api/v1/channels" });
    expect(listed.body).not.toContain(hook);
    expect(listed.body).not.toContain(created.signingKey);
    const file = await stat(join(home, "channel-secrets.json"));
    expect(file.mode & 0o777).toBe(0o600);
    // The first-run checklist ticks its channel step.
    expect(
      (await get<{ steps: { channel: boolean } }>("/setup")).steps.channel,
    ).toBe(true);
  });

  it("refuses a taken name, a missing secret, and a setting another type has", async () => {
    expect(
      (
        await send("POST", "/channels", {
          name: "ops webhook",
          type: "slack",
          secrets: { url: hook },
        })
      ).statusCode,
    ).toBe(409);
    const missing = await send("POST", "/channels", {
      name: "Chat",
      type: "telegram",
      secrets: { botToken: "123:abc" },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json<{ message: string }>().message).toMatch(/Chat id/);
    expect(
      (
        await send("POST", "/channels", {
          name: "Mail",
          type: "slack",
          settings: { host: "smtp.example.com" },
          secrets: { url: hook },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("keeps a secret a change leaves out", async () => {
    const res = await send("PUT", `/channels/${id}`, {
      name: "Ops webhook",
      type: "webhook",
      minSeverity: "warning",
    });
    expect(res.json<Channel>()).toMatchObject({
      minSeverity: "warning",
      secretsSet: ["signingKey", "url"],
    });
  });

  it("sends a test, and says why one did not arrive", async () => {
    expect(
      (await send("POST", `/channels/${id}/test`)).json<ChannelTest>(),
    ).toEqual({ delivered: true, error: null });
    const dead = await send("POST", "/channels", {
      name: "Nowhere",
      type: "slack",
      secrets: { url: "http://127.0.0.1:1/hook" },
    });
    const test = (
      await send("POST", `/channels/${dead.json<Channel>().id}/test`)
    ).json<ChannelTest>();
    expect(test.delivered).toBe(false);
    expect(test.error).toMatch(/Could not reach 127\.0\.0\.1:1/);
  });

  it("deletes a channel and says how many messages went with it", async () => {
    const res = await send("DELETE", `/channels/${id}`);
    expect(res.json()).toEqual({ dropped: expect.any(Number) as unknown });
    expect((await get<Channel[]>("/channels")).some((c) => c.id === id)).toBe(
      false,
    );
  });
});

describe("notification settings", () => {
  it("keeps the dashboard and heartbeat addresses, and refuses anything else", async () => {
    expect(await get("/notification-settings")).toEqual({
      dashboardUrl: null,
      heartbeatUrl: null,
    });
    const set = {
      dashboardUrl: "https://tripwire.example",
      heartbeatUrl: null,
    };
    expect((await send("PUT", "/notification-settings", set)).json()).toEqual(
      set,
    );
    expect(await get("/notification-settings")).toEqual(set);
    expect(
      (
        await send("PUT", "/notification-settings", {
          dashboardUrl: "ftp://nope",
          heartbeatUrl: null,
        })
      ).statusCode,
    ).toBe(400);
  });
});
