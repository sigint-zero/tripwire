import { describe, expect, it } from "vitest";
import { timeAxis } from "./timeAxis";

const minute = 60_000;
// A point a minute for 15 minutes, nothing for two hours, then 30 minutes more.
const times = [
  ...Array.from({ length: 15 }, (_, i) => i * minute),
  ...Array.from({ length: 30 }, (_, i) => (135 + i) * minute),
];

describe("timeAxis", () => {
  const axis = timeAxis(times, 0, 165 * minute);

  it("squeezes the stretch with nothing recorded", () => {
    expect(axis.breaks).toEqual([{ from: 14 * minute, to: 135 * minute }]);
    const gap = axis.x(135 * minute) - axis.x(14 * minute);
    expect(gap).toBeCloseTo(0.02, 5);
  });

  it("gives what was recorded the rest of the width, in order", () => {
    expect(axis.x(0)).toBe(0);
    expect(axis.x(165 * minute)).toBe(1);
    let last = -1;
    for (const t of times) {
      expect(axis.x(t)).toBeGreaterThan(last);
      last = axis.x(t);
    }
    // 15 + 30 recorded minutes share 98% of the width.
    expect(axis.x(14 * minute)).toBeCloseTo((14 / 44) * 0.98, 2);
  });

  it("reads a share of the width back to its time", () => {
    for (const t of [3 * minute, 140 * minute]) {
      expect(Math.abs(axis.time(axis.x(t)) - t)).toBeLessThan(1000);
    }
  });

  it("leaves an even series alone", () => {
    const even = timeAxis(
      [0, 1, 2, 3, 4].map((i) => i * minute),
      0,
      4 * minute,
    );
    expect(even.breaks).toEqual([]);
    expect(even.x(2 * minute)).toBeCloseTo(0.5);
  });
});
