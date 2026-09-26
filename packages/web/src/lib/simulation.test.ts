import { describe, expect, it } from "vitest";
import { templates } from "./templates";
import {
  BREACH_INDEX,
  rollingLabel,
  rollingOf,
  rollingSeries,
  SAMPLES,
  type Rolling,
} from "./simulation";

const read = "totalSupply() returns (uint256)";

function ruleFor(id: string, values: Record<string, string>) {
  const template = templates.find((t) => t.id === id)!;
  const built = template.build(values)!;
  return {
    version: 1 as const,
    name: "r",
    contract: "0x0000000000000000000000000000000000000001",
    severity: "warning" as const,
    on_trip: { action: "notify" as const },
    ...built,
  };
}

/** Whether sample i is outside the limit. */
function breaks(r: Rolling, i: number) {
  const s = rollingSeries(r);
  const v = s.values[i]!;
  return (
    (s.upper !== undefined && v > s.upper[i]!) ||
    (s.lower !== undefined && v < s.lower[i]!)
  );
}

describe("rollingOf", () => {
  it("reads the band, growth and outflow templates", () => {
    expect(
      rollingOf(ruleFor("band", { value: read, percent: "5", window: "1200" })),
    ).toEqual({ kind: "band", percent: 5, window: 1200, sides: "both" });
    expect(
      rollingOf(
        ruleFor("growth", { value: read, percent: "5", window: "86400" }),
      ),
    ).toEqual({ kind: "growth", percent: 5, window: 86400 });
    expect(
      rollingOf(
        ruleFor("outflow", { value: read, percent: "10", window: "3600" }),
      ),
    ).toEqual({ kind: "drop", percent: 10, window: 3600 });
  });

  it("reads a growth percentage without float noise", () => {
    expect(
      rollingOf(
        ruleFor("growth", { value: read, percent: "7", window: "3600" }),
      ),
    ).toMatchObject({ percent: 7 });
  });

  it("leaves a fixed limit alone", () => {
    expect(
      rollingOf(ruleFor("floor", { value: read, floor: "1000" })),
    ).toBeNull();
  });
});

describe("rollingSeries", () => {
  const cases: Rolling[] = [1, 5, 10, 50].flatMap((percent) => [
    { kind: "band", percent, window: 1200, sides: "both" },
    { kind: "band", percent, window: 1200, sides: "above" },
    { kind: "band", percent, window: 1200, sides: "below" },
    { kind: "growth", percent, window: 86400 },
    { kind: "drop", percent, window: 3600 },
  ]);

  it.each(cases)("first breaks at the breach: %o", (r) => {
    expect(rollingSeries(r).values).toHaveLength(SAMPLES);
    expect(breaks(r, BREACH_INDEX)).toBe(true);
    for (let i = 0; i < BREACH_INDEX; i++) expect(breaks(r, i)).toBe(false);
  });

  it("labels the limit", () => {
    expect(
      rollingLabel({ kind: "band", percent: 5, window: 1200, sides: "both" }),
    ).toBe("±5% of 20m avg");
    expect(rollingLabel({ kind: "growth", percent: 5, window: 86400 })).toBe(
      "+5% in 1d",
    );
    expect(rollingLabel({ kind: "drop", percent: 10, window: 3600 })).toBe(
      "−10% from 1h high",
    );
  });
});
