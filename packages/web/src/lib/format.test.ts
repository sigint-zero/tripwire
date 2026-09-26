import { describe, expect, it } from "vitest";
import { formatUnits, timeAgo } from "./format";

describe("formatUnits", () => {
  it("shifts a raw read by the token's decimals", () => {
    expect(formatUnits("1204551250000", 6)).toBe("1,204,551.25");
    expect(formatUnits("5", 6)).toBe("0.000005");
    expect(formatUnits("1000000000000000000", 18)).toBe("1");
    expect(formatUnits("-1500", 3)).toBe("-1.5");
    expect(formatUnits("42", 0)).toBe("42");
  });

  it("keeps at most six fraction digits", () => {
    expect(formatUnits("1234567891234567891", 18)).toBe("1.234567");
  });
});

describe("timeAgo", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");
  const ago = (seconds: number) =>
    timeAgo(new Date(now - seconds * 1000).toISOString(), now);

  it("says how long ago, in the largest sensible unit", () => {
    expect(ago(10)).toBe("just now");
    expect(ago(5 * 60)).toBe("5m ago");
    expect(ago(3 * 3600)).toBe("3h ago");
    expect(ago(2 * 86_400)).toBe("2d ago");
  });
});
