import type { RuleSeries, SavedRule } from "@tripwire/shared";
import { describe, expect, it } from "vitest";
import { boundaryOf, overlaysOf, type Sample } from "./overlays";

// One sample a minute for two hours, at the given values.
const minutes = (value: (i: number) => number): Sample[] =>
  Array.from({ length: 121 }, (_, i) => {
    const v = String(value(i));
    return { t: i * 60_000, last: v, min: v, max: v };
  });

describe("boundaryOf", () => {
  it("puts an outflow floor under the window's high", () => {
    const samples = minutes((i) => (i < 60 ? 100 : 50));
    const [floor] = boundaryOf(
      { kind: "drop", seriesId: "s", window: 3600, percent: 10 },
      samples,
      [],
      "",
    );
    // Before a whole hour lies behind it, it works from the history there is.
    expect(floor!.points[0]).toEqual({ t: 0, v: 90, partial: true });
    expect(floor!.points[60]).toEqual({ t: 3_600_000, v: 90, partial: false });
    // An hour after the fall, the high is 50.
    expect(floor!.points.at(-1)!.v).toBe(45);
    expect(floor!.trips).toBe("below");
  });

  it("puts a growth ceiling above the value a window ago", () => {
    const samples = minutes((i) => 100 + i);
    const [ceiling] = boundaryOf(
      { kind: "growth", seriesId: "s", window: 3600, fraction: 0.5 },
      samples,
      [],
      "",
    );
    // Short of a whole window, it measures from the first value.
    expect(ceiling!.points[30]).toEqual({
      t: 1_800_000,
      v: 200,
      partial: true,
    });
    expect(ceiling!.points[60]).toEqual({
      t: 3_600_000,
      v: 200,
      partial: false,
    });
    expect(ceiling!.points.at(-1)!.v).toBe(320);
  });

  it("centres a band on the trailing average", () => {
    const samples = minutes(() => 100);
    const edges = boundaryOf(
      {
        kind: "band",
        seriesId: "s",
        window: 1200,
        percent: 5,
        sides: "both",
      },
      samples,
      [],
      "",
    );
    expect(edges.map((e) => e.trips)).toEqual(["above", "below"]);
    expect(edges[0]!.points[0]!.v).toBeCloseTo(105);
    expect(edges[1]!.points[0]!.v).toBeCloseTo(95);
    expect(edges[0]!.label).toBe("±5% of 20m avg");
  });

  it("follows another read, and a timestamp's age", () => {
    const samples = minutes((i) => i);
    const other = minutes(() => 7);
    const [floor] = boundaryOf(
      { kind: "read", seriesId: "a", otherId: "b", op: "lt" },
      samples,
      other,
      "totalSupply()",
    );
    expect(floor!.label).toBe("< totalSupply()");
    expect(floor!.points[0]!.v).toBe(7);
    const [age] = boundaryOf(
      { kind: "age", seriesId: "s", seconds: 3600 },
      samples,
      [],
      "",
    );
    expect(age!.points.at(-1)).toEqual({ t: 7_200_000, v: 3_600 });
  });
});

describe("overlaysOf", () => {
  const vault = "0x00000000000000000000000000000000000000aa";
  const read = (fn: string) => ({
    node: "view_call" as const,
    function: `${fn}() returns (uint256)`,
    args: [],
  });
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
  const ruleOf = (trip_when: unknown) =>
    ({
      id: "1",
      rule: {
        version: 1,
        name: "r",
        contract: vault,
        severity: "warning",
        when: "every_block",
        trip_when,
        on_trip: { action: "notify" },
      },
      display: { decimals: null, unit: null },
    }) as unknown as SavedRule;
  const lit = (value: string) => ({ node: "literal" as const, value });
  const assets = series("40", "totalAssets");
  const debts = series("41", "totalLiabilities");

  it("draws a threshold on the side that trips", () => {
    const { thresholds } = overlaysOf(
      ruleOf({
        node: "compare",
        op: "lt",
        left: read("totalAssets"),
        right: lit("50"),
      }),
      [assets],
    );
    expect(thresholds).toEqual([
      { seriesId: "40", value: "50", label: "< 50", trips: "below", op: "lt" },
    ]);
  });

  it("reads a literal on the left as the same limit", () => {
    const { thresholds } = overlaysOf(
      ruleOf({
        node: "compare",
        op: "gt",
        left: lit("50"),
        right: read("totalAssets"),
      }),
      [assets],
    );
    expect(thresholds[0]).toMatchObject({ label: "< 50", trips: "below" });
  });

  it("takes another read as a moving limit", () => {
    const { derived } = overlaysOf(
      ruleOf({
        node: "compare",
        op: "lt",
        left: read("totalAssets"),
        right: read("totalLiabilities"),
      }),
      [assets, debts],
    );
    expect(derived).toEqual([
      { kind: "read", seriesId: "40", otherId: "41", op: "lt" },
    ]);
  });

  it("flips the side under not", () => {
    const { thresholds } = overlaysOf(
      ruleOf({
        node: "not",
        expr: {
          node: "compare",
          op: "ge",
          left: read("totalAssets"),
          right: lit("5"),
        },
      }),
      [assets],
    );
    expect(thresholds).toEqual([
      { seriesId: "40", value: "5", label: "< 5", trips: "below", op: "lt" },
    ]);
  });

  it("flips twice under two nots, and through and", () => {
    const inner = {
      node: "compare",
      op: "gt",
      left: read("totalAssets"),
      right: lit("9"),
    };
    const twice = overlaysOf(
      ruleOf({ node: "not", expr: { node: "not", expr: inner } }),
      [assets],
    );
    expect(twice.thresholds[0]!.trips).toBe("above");
    const through = overlaysOf(
      ruleOf({ node: "not", expr: { node: "and", terms: [inner, true] } }),
      [assets],
    );
    expect(through.thresholds[0]).toMatchObject({
      label: "≤ 9",
      trips: "below",
    });
  });

  it("draws nothing for arithmetic on both sides", () => {
    const times = (n: ReturnType<typeof read>, k: string) => ({
      node: "arithmetic",
      op: "mul",
      left: n,
      right: lit(k),
    });
    const o = overlaysOf(
      ruleOf({
        node: "compare",
        op: "lt",
        left: times(read("totalAssets"), "10"),
        right: times(read("totalLiabilities"), "9"),
      }),
      [assets, debts],
    );
    expect(o).toEqual({ thresholds: [], bands: [], derived: [] });
  });
});
