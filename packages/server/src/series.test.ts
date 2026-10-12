import type {
  CheckNow,
  CurrentValue,
  RulePreview,
  RuleSeries,
  SavedRule,
  SeriesWindow,
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

describe("previews", () => {
  const scaled = "0x6666666666666666666666666666666666666666";
  let reading: string;
  let decimalReads = 0;
  beforeAll(async () => {
    const read = stub.read.bind(stub);
    stub.read = (calls) => {
      decimalReads += calls.filter((c) =>
        c.function.startsWith("decimals()"),
      ).length;
      return read(calls);
    };
    await app.inject({
      method: "POST",
      url: "/api/v1/contracts",
      payload: {
        address: scaled,
        name: "Scaled token",
        abi: [
          {
            type: "function",
            name: "decimals",
            inputs: [],
            outputs: [{ name: "", type: "uint8" }],
            stateMutability: "view",
          },
        ],
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/rules",
      payload: { rule: { ...supply("Scaled supply", "lt"), contract: scaled } },
    });
    reading = res.json<StoredRuleCheck>().id;
    now += 12_000;
    await stub.tick();
  });

  it("gives each rule its series, their buckets and newest points, in one request", async () => {
    const all = await get<RulePreview[]>(
      `/previews?rules=${tripping},${holding},${reading},999`,
    );
    expect(all.map((p) => p.ruleId)).toEqual([
      tripping,
      holding,
      reading,
      "999",
    ]);
    const [first] = all;
    expect(first!.series.length).toBeGreaterThan(0);
    expect(first!.series.length).toBeLessThanOrEqual(3);
    for (const s of first!.series) {
      expect(first!.buckets[s.id]!.length).toBeGreaterThan(0);
      expect(first!.buckets[s.id]!.length).toBeLessThanOrEqual(48);
      expect(first!.latest[s.id]!.value).toMatch(/^-?\d+$/);
    }
    // An unknown rule answers empty, not an error.
    expect(all[3]).toEqual({
      ruleId: "999",
      series: [],
      buckets: {},
      history: {},
      latest: {},
      decimals: {},
      lastFired: null,
    });
  });

  it("cuts a series holding less than the window over what it holds", async () => {
    const [p] = await get<RulePreview[]>(`/previews?rules=${reading}`);
    const id = p!.series[0]!.id;
    const buckets = p!.buckets[id]!;
    // Nothing recorded within the day comes before the first bucket, so
    // the buckets begin where the series' points do. The server's window
    // ends at its own now, so this reads from a minute inside it.
    const start = Date.parse(buckets[0]!.start);
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${STUB_VIEWS}.series_points
        WHERE series_id = $1 AND block_time >= $2 AND block_time < $3`,
      [id, new Date(Date.now() - 86_400_000 + 60_000), new Date(start - 1000)],
    );
    expect(rows[0]!.n).toBe(0);
    expect(buckets.length).toBeGreaterThan(40);
  });

  it("says when a rule last tripped", async () => {
    const all = await get<RulePreview[]>(
      `/previews?rules=${tripping},${holding}`,
    );
    expect(all[0]!.lastFired).toMatchObject({
      blockNumber: expect.any(Number) as unknown,
    });
    expect(all[1]!.lastFired).toBeNull();
  });

  it("reads a contract's decimals once, and only where it has them", async () => {
    const [plain, withScale] = await get<RulePreview[]>(
      `/previews?rules=${tripping},${reading}`,
    );
    expect(plain!.decimals).toEqual({});
    expect(withScale!.decimals).toEqual({ [scaled]: 18 });
    // Three requests so far ask for the scaled token; the engine was asked once.
    expect(decimalReads).toBe(1);
  });

  it("gives a windowed rule the history before its window", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/rules",
      payload: {
        rule: {
          ...supply("Drop in an hour", "gt"),
          // A read beside the windowed metric: the stand-in links no
          // metric's base series, which the engine does.
          trip_when: {
            node: "or",
            terms: [
              supply("", "lt").trip_when,
              {
                node: "compare",
                op: "gt",
                left: {
                  node: "metric",
                  metric: "windowed_drop",
                  of: {
                    node: "view_call",
                    function: "totalSupply() returns (uint256)",
                    args: [],
                  },
                  window: { seconds: 3600 },
                },
                right: { node: "literal", value: "5" },
              },
            ],
          },
        },
      },
    });
    const id = res.json<StoredRuleCheck>().id;
    now += 12_000;
    await stub.tick();
    const [windowed, plain] = await get<RulePreview[]>(
      `/previews?rules=${id},${holding}`,
    );
    const first = windowed!.series[0]!.id;
    const before = windowed!.history[first]!;
    expect(before.length).toBeGreaterThan(0);
    // It ends where the shown buckets begin, an hour back at most.
    const start = Date.parse(windowed!.buckets[first]![0]!.start);
    expect(Date.parse(before.at(-1)!.start)).toBeLessThan(start);
    expect(Date.parse(before[0]!.start)).toBeGreaterThanOrEqual(
      start - 3_600_000 - 1000,
    );
    expect(plain!.history).toEqual({});
  });

  it("does not keep a decimals() read that failed", async () => {
    const other = "0x7777777777777777777777777777777777777777";
    await app.inject({
      method: "POST",
      url: "/api/v1/contracts",
      payload: {
        address: other,
        name: "Flaky token",
        abi: [
          {
            type: "function",
            name: "decimals",
            inputs: [],
            outputs: [{ name: "", type: "uint8" }],
            stateMutability: "view",
          },
        ],
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/rules",
      payload: { rule: { ...supply("Flaky supply", "lt"), contract: other } },
    });
    const id = res.json<StoredRuleCheck>().id;
    now += 12_000;
    await stub.tick();
    const read = stub.read.bind(stub);
    // The engine answers null for a call that failed.
    stub.read = (calls) =>
      calls.some(
        (c) => c.function.startsWith("decimals()") && c.address === other,
      )
        ? Promise.resolve(calls.map(() => null as unknown as string))
        : read(calls);
    const [failed] = await get<RulePreview[]>(`/previews?rules=${id}`);
    stub.read = read;
    expect(failed!.decimals).toEqual({});
    const [later] = await get<RulePreview[]>(`/previews?rules=${id}`);
    expect(later!.decimals).toEqual({ [other]: 18 });
  });

  it("refuses more than 64 rules, and malformed ids", async () => {
    const many = Array.from({ length: 65 }, (_, i) => i + 1).join(",");
    expect(
      (await app.inject({ url: `/api/v1/previews?rules=${many}` })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: "/api/v1/previews?rules=a" })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: `/api/v1/previews?rules=${"9".repeat(30)}` }))
        .statusCode,
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
