import type { RulePreview, RuleSeries, SavedRule } from "@tripwire/shared";
import { describe, expect, it } from "vitest";
import {
  compact,
  eventOf,
  headroomOf,
  previewOf,
  rangeOf,
  scaleOf,
  toneOf,
  WINDOW_MS,
} from "./preview";

const vault = "0x00000000000000000000000000000000000000aa";
const E18 = 10n ** 18n;
const read = (fn: string) => ({
  node: "view_call" as const,
  function: `${fn}() returns (uint256)`,
  args: [],
});
const lit = (value: string) => ({ node: "literal" as const, value });
const series = (id: string, fn: string): RuleSeries => ({
  id,
  call: {
    address: vault,
    function: `${fn}() returns (uint256)`,
    args: [],
    returns: null,
  },
  metric: null,
  windowSeconds: null,
  role: "read",
});
const ruleOf = (
  trip_when: unknown,
  when: unknown = "every_block",
  decimals: number | null = null,
) =>
  ({
    id: "1",
    rule: {
      version: 1,
      name: "r",
      contract: vault,
      severity: "warning",
      when,
      trip_when,
      on_trip: { action: "notify" },
    },
    sentence: "…",
    enabled: true,
    status: "holding",
    display: { decimals, unit: null },
  }) as unknown as SavedRule;
const now = Date.UTC(2026, 9, 11, 12);
const previewWith = (
  values: Record<string, bigint[]>,
  s: RuleSeries[],
  decimals: Record<string, number> = {},
): RulePreview => ({
  ruleId: "1",
  series: s,
  buckets: Object.fromEntries(
    Object.entries(values).map(([id, vs]) => [
      id,
      vs.map((v, i) => ({
        start: new Date(now - WINDOW_MS + i * 1_800_000).toISOString(),
        first: String(v),
        last: String(v),
        min: String(v),
        max: String(v),
        count: 1,
      })),
    ]),
  ),
  latest: Object.fromEntries(
    Object.entries(values).map(([id, vs]) => [
      id,
      {
        value: String(vs.at(-1)),
        blockNumber: 1,
        blockTime: new Date(now).toISOString(),
      },
    ]),
  ),
  decimals,
  lastFired: null,
});

describe("compact", () => {
  it("shows a scaled value short", () => {
    const scale = { decimals: 18, unit: null, auto: true };
    expect(compact(String((1002n * E18) / 10n), scale)).toBe("100.2");
    expect(compact(String((34175n * E18) / 10n), scale)).toBe("3,417.5");
    expect(compact(String(1_234_567n * E18), scale)).toBe("1.2M");
    expect(compact(String(E18 / 2000n), scale)).toBe("0.0005");
  });

  it("shows a raw value as the rest of the dashboard does", () => {
    const raw = { decimals: null, unit: null, auto: false };
    expect(compact(String(100n * E18), raw)).toBe("1.000 × 10²⁰");
    expect(compact("1234", raw)).toBe("1,234");
  });

  it("reads raw chosen as no decimals like no scale once it is long", () => {
    const zero = { decimals: 0, unit: null, auto: false };
    expect(compact(String(100n * E18), zero)).toBe("1.000 × 10²⁰");
    expect(compact("1234", zero)).toBe("1,234");
  });
});

describe("headroom and tone", () => {
  it("is positive on the safe side of a limit", () => {
    expect(headroomOf(100, 50, "below")).toBe(1);
    expect(headroomOf(40, 50, "below")).toBeCloseTo(-0.2);
    expect(headroomOf(45, 50, "above")).toBeCloseTo(0.1);
    expect(headroomOf(5, 0, "below")).toBe(Infinity);
    expect(headroomOf(5, 5, null)).toBeNull();
  });

  it("is amber within a tenth, red past the limit", () => {
    expect(toneOf(0.5)).toBe("safe");
    expect(toneOf(0.05)).toBe("near");
    expect(toneOf(-0.01)).toBe("breached");
    expect(toneOf(null)).toBe("none");
  });
});

describe("rangeOf", () => {
  it("pads a flat line so it sits mid-chart, its limit in view", () => {
    const r = rangeOf([100, 100], [{ v: [50], words: "below 50" }]);
    expect(r.low).toBeLessThan(50);
    expect(r.high).toBeGreaterThan(100);
    expect(r.off).toEqual([]);
  });

  it("leaves a far limit off the range and names it", () => {
    const r = rangeOf([1e20, 1.01e20], [{ v: [0], words: "below 0" }]);
    expect(r.low).toBeGreaterThan(0);
    expect(r.off).toEqual([{ words: "below 0", side: "below" }]);
  });
});

describe("scaleOf", () => {
  const s = [series("40", "totalAssets")];
  it("prefers the rule's own scale, then the contract's decimals", () => {
    expect(
      scaleOf(
        ruleOf(true, "every_block", 6),
        previewWith({}, s, { [vault]: 18 }),
      ),
    ).toEqual({ decimals: 6, unit: null, auto: false });
    expect(scaleOf(ruleOf(true), previewWith({}, s, { [vault]: 18 }))).toEqual({
      decimals: 18,
      unit: null,
      auto: true,
    });
    expect(scaleOf(ruleOf(true), previewWith({}, s))).toEqual({
      decimals: null,
      unit: null,
      auto: false,
    });
  });
});

describe("previewOf", () => {
  const assets = series("40", "totalAssets");
  const debts = series("41", "totalLiabilities");

  it("draws a threshold and is green far from it", () => {
    const m = previewOf(
      ruleOf({
        node: "compare",
        op: "lt",
        left: read("totalAssets"),
        right: lit(String(50n * E18)),
      }),
      previewWith({ "40": [100n * E18, 101n * E18] }, [assets], {
        [vault]: 18,
      }),
      now,
    );
    expect(m.lines.map((l) => [l.trips, l.words])).toEqual([
      ["below", "below 50"],
    ]);
    expect(m.tone).toBe("safe");
    expect(m.headroom).toBeCloseTo(1.02);
  });

  it("turns amber near a limit and red past it", () => {
    const rule = ruleOf({
      node: "compare",
      op: "lt",
      left: read("totalAssets"),
      right: lit("100"),
    });
    expect(
      previewOf(rule, previewWith({ "40": [200n, 105n] }, [assets]), now).tone,
    ).toBe("near");
    expect(
      previewOf(rule, previewWith({ "40": [200n, 90n] }, [assets]), now).tone,
    ).toBe("breached");
  });

  it("draws another read as the limit", () => {
    const m = previewOf(
      ruleOf({
        node: "compare",
        op: "lt",
        left: read("totalAssets"),
        right: read("totalLiabilities"),
      }),
      previewWith({ "40": [100n, 100n], "41": [50n, 60n] }, [assets, debts]),
      now,
    );
    expect(m.lines.map((l) => l.words)).toEqual(["below totalLiabilities()"]);
    expect(m.lines[0]!.points.at(-1)!.v).toBe(60);
    expect(m.headroom).toBeCloseTo(40 / 60);
  });

  it("has no line for an event rule with nothing recorded, and names its event", () => {
    const m = previewOf(
      ruleOf(true, {
        event:
          "Transfer(address indexed from, address indexed to, uint256 amount)",
      }),
      previewWith({}, []),
      now,
    );
    expect(m.primary).toBeNull();
    expect(m.event).toBe("Transfer");
    expect(eventOf(ruleOf(true))).toBeNull();
  });

  it("draws no limit for arithmetic on both sides, and no headroom", () => {
    const times = (n: unknown, k: string) => ({
      node: "arithmetic",
      op: "mul",
      left: n,
      right: lit(k),
    });
    const m = previewOf(
      ruleOf({
        node: "compare",
        op: "lt",
        left: times(read("totalAssets"), "10"),
        right: times(read("totalLiabilities"), "9"),
      }),
      previewWith({ "40": [100n, 100n], "41": [50n, 50n] }, [assets, debts]),
      now,
    );
    expect(m.primary).not.toBeNull();
    expect(m.lines).toEqual([]);
    expect(m.headroom).toBeNull();
    expect(m.tone).toBe("none");
  });

  it("is red when an equality limit is hit", () => {
    const m = previewOf(
      ruleOf({
        node: "compare",
        op: "eq",
        left: read("totalAssets"),
        right: lit("0"),
      }),
      previewWith({ "40": [5n, 0n] }, [assets]),
      now,
    );
    expect(m.lines[0]!.words).toBe("at 0");
    expect(m.tone).toBe("breached");
  });
});
