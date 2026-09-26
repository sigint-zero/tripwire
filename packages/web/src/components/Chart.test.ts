import { describe, expect, it } from "vitest";
import { boundaryOf, type Sample } from "./Chart";

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
