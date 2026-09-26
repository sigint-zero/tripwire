import type {
  CheckNow,
  CurrentValue,
  RuleSeries,
  SavedRule,
  SeriesWindow,
  Sparkline,
  StoredRuleCheck,
} from "@tripwire/shared";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./app";
import { ViewReads } from "./engine/reads";
import { STUB_VIEWS, StubEngine } from "./engine/stub";
import { signIn, TEST_COST, testDatabase, testHome } from "./testing";

// What a rule reads, recorded at every block: its status, its newest
// values, its chart and its sparkline, all read back from the views.

const token = "0x5555555555555555555555555555555555555555";
const supply = (name: string, op: string) => ({
  version: 1,
  name,
  contract: token,
  severity: "warning",
  when: "every_block",
  trip_when: {
    node: "compare",
    op,
    left: {
      node: "view_call",
      function: "totalSupply() returns (uint256)",
      args: [],
    },
    right: { node: "literal", value: "1" },
  },
  on_trip: { action: "notify" },
});

// The stand-in's chain runs on real time here: windows end at now.
let now = Date.now();
let app: FastifyInstance;
let stub: StubEngine;
let pool: pg.Pool;
let tripping: string;
let holding: string;
const cleanup: (() => Promise<void>)[] = [];

const get = <T>(url: string) =>
  app.inject({ url: `/api/v1${url}` }).then((res) => res.json<T>());

beforeAll(async () => {
  const database = await testDatabase();
  const home = await testHome();
  pool = database.pool;
  stub = await StubEngine.open(database.pool, () => now, "notify");
  app = await createServer({
    backend: {
      pool: database.pool,
      engine: {
        commands: stub,
        reads: new ViewReads(database.pool, STUB_VIEWS),
        events: stub,
        info: { chainId: 1, responseMode: "notify", simulated: true },
        close: () => Promise.resolve(),
      },
    },
    home: home.home,
    passwordCost: TEST_COST,
  });
  cleanup.push(
    () => app.close(),
    () => database.close(),
    () => home.remove(),
  );
  await signIn(app);
  await app.inject({
    method: "POST",
    url: "/api/v1/contracts",
    payload: { address: token, name: "Token", abi: [] },
  });
  const add = (name: string, op: string) =>
    app
      .inject({
        method: "POST",
        url: "/api/v1/rules",
        payload: { rule: supply(name, op) },
      })
      .then((res) => res.json<StoredRuleCheck>().id);
  tripping = await add("Supply above one", "gt");
  holding = await add("Supply below one", "lt");
  await stub.tick();
});
afterAll(async () => {
  for (const step of cleanup) await step();
});

describe("a rule's status", () => {
  it("says tripped only while the condition holds now, with the open count", async () => {
    const rules = await get<SavedRule[]>("/rules");
    const byId = (id: string) => rules.find((r) => r.id === id)!;
    expect(byId(tripping)).toMatchObject({
      status: "tripped",
      openViolations: 1,
    });
    expect(byId(holding)).toMatchObject({
      status: "holding",
      openViolations: 0,
    });
    expect(
      (await get<SavedRule[]>("/rules?status=tripped")).map((r) => r.id),
    ).toEqual([tripping]);
    expect(
      (await app.inject({ url: "/api/v1/rules?status=soon" })).statusCode,
    ).toBe(400);
  });

  it("reads off when switched off", async () => {
    await app.inject({
      method: "PATCH",
      url: `/api/v1/rules/${holding}`,
      payload: { enabled: false },
    });
    expect((await get<SavedRule>(`/rules/${holding}`)).status).toBe("off");
    await app.inject({
      method: "PATCH",
      url: `/api/v1/rules/${holding}`,
      payload: { enabled: true },
    });
  });
});

describe("series", () => {
  let series: RuleSeries[];

  it("finds the rule's reads among the recorded series, shared between rules", async () => {
    series = await get<RuleSeries[]>(`/rules/${tripping}/series`);
    expect(series).toEqual([
      expect.objectContaining({
        role: "read",
        call: expect.objectContaining({
          function: "totalSupply() returns (uint256)",
        }) as unknown,
      }),
    ]);
    expect(await get<RuleSeries[]>(`/rules/${holding}/series`)).toEqual(series);
  });

  it("gives the newest value of each", async () => {
    const [current] = await get<CurrentValue[]>(`/rules/${tripping}/current`);
    expect(current).toMatchObject({ seriesId: series[0]!.id });
    expect(BigInt(current!.value)).toBeGreaterThan(1n);
  });

  it("returns points for a short window and buckets for a long one", async () => {
    const id = series[0]!.id;
    const recent = await get<SeriesWindow>(
      `/series/${id}/points?from=${new Date(now - 5 * 60_000).toISOString()}`,
    );
    expect(recent.resolution).toBe("block");
    const day = await get<SeriesWindow>(`/series/${id}/points`);
    if (!("buckets" in day)) throw new Error("expected buckets");
    expect(day.buckets.length).toBeLessThanOrEqual(500);
    expect(day.buckets.reduce((n, b) => n + b.count, 0)).toBeGreaterThanOrEqual(
      1_440,
    );
    for (const b of day.buckets) {
      expect(BigInt(b.min)).toBeLessThanOrEqual(BigInt(b.last));
      expect(BigInt(b.last)).toBeLessThanOrEqual(BigInt(b.max));
    }
  });

  it("keeps a one-block spike visible in a month", async () => {
    const id = series[0]!.id;
    const spike = "999999999999999999999999999999";
    await pool.query(
      `INSERT INTO stub.series_points (series_id, block_number, block_time, value)
       VALUES ($1, 1, $2, $3)`,
      [id, new Date(now - 10 * 86_400_000).toISOString(), spike],
    );
    const month = await get<SeriesWindow>(
      `/series/${id}/points?from=${new Date(now - 30 * 86_400_000).toISOString()}&points=100`,
    );
    if (!("buckets" in month)) throw new Error("expected buckets");
    expect(month.buckets.some((b) => b.max === spike)).toBe(true);
  });

  it("combines rollups and raw points in the same bucket, leaving no seam", async () => {
    const id = series[0]!.id;
    const start = new Date(now - 2 * 86_400_000);
    await pool.query(
      `INSERT INTO stub.series_rollups
         (series_id, bucket_start, first, last, min, max, avg, samples)
       VALUES ($1, $2, 5, 7, 3, 9, 6, 300)`,
      [id, start.toISOString()],
    );
    const window = await get<SeriesWindow>(
      `/series/${id}/points?from=${new Date(start.getTime() - 3_600_000).toISOString()}&to=${new Date(start.getTime() + 3_600_000).toISOString()}&points=2`,
    );
    if (!("buckets" in window)) throw new Error("expected buckets");
    expect(window.buckets).toEqual([
      expect.objectContaining({ min: "3", max: "9", count: 300 }),
    ]);
  });

  it("refuses an unknown series and a backwards window", async () => {
    expect(
      (await app.inject({ url: "/api/v1/series/999/points" })).statusCode,
    ).toBe(404);
    const id = series[0]!.id;
    const backwards = await app.inject({
      url: `/api/v1/series/${id}/points?from=${new Date(now).toISOString()}&to=${new Date(now - 1000).toISOString()}`,
    });
    expect(backwards.statusCode).toBe(400);
  });
});

describe("sparklines", () => {
  it("draws every asked rule's first series in one request", async () => {
    const lines = await get<Sparkline[]>(
      `/sparklines?rules=${tripping},${holding},999`,
    );
    expect(lines.map((l) => l.ruleId).sort()).toEqual(
      [tripping, holding].sort(),
    );
    for (const line of lines) {
      expect(line.buckets.length).toBeGreaterThan(0);
      expect(line.buckets.length).toBeLessThanOrEqual(48);
    }
    expect(
      (await app.inject({ url: "/api/v1/sparklines?rules=a" })).statusCode,
    ).toBe(400);
  });
});

describe("check now", () => {
  it("evaluates the stored rule at the head and records nothing", async () => {
    const count = async () =>
      (
        await pool.query<{ n: number }>(
          "SELECT (SELECT count(*) FROM stub.violations) + (SELECT count(*) FROM stub.series_points) AS n",
        )
      ).rows[0]!.n;
    const before = await count();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rules/${tripping}/check`,
    });
    expect(res.json<CheckNow>()).toMatchObject({
      wouldTripNow: true,
      warming: false,
      warmupSecondsLeft: 0,
      evidence: { node: "compare", value: true },
    });
    expect(await count()).toEqual(before);
    now += 1;
  });
});
