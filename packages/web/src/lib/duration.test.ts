import { describe, expect, it } from "vitest";
import {
  blockSeconds,
  durationProblem,
  fromSeconds,
  humanDuration,
  toSeconds,
} from "./duration";

describe("durations", () => {
  it("reads seconds back in the roundest unit", () => {
    expect(fromSeconds(86_400)).toEqual({ amount: 1, unit: "days" });
    expect(fromSeconds(5_400)).toEqual({ amount: 90, unit: "minutes" });
    expect(fromSeconds(90)).toEqual({ amount: 90, unit: "seconds" });
  });

  it("converts blocks with the chain's block time", () => {
    expect(toSeconds(100, "blocks", blockSeconds(1))).toBe(1_200);
    expect(toSeconds(300, "blocks", blockSeconds(8453))).toBe(600);
    expect(toSeconds(10, "blocks", blockSeconds(999))).toBeNull();
    expect(toSeconds(3, "hours", null)).toBe(10_800);
  });

  it("names a duration", () => {
    expect(humanDuration(3_600)).toBe("1 hour");
    expect(humanDuration(1_200)).toBe("20 minutes");
    expect(humanDuration(172_800)).toBe("2 days");
  });

  it("keeps a duration within the engine's bounds", () => {
    expect(durationProblem(59)).toBe("At least 1 minute.");
    expect(durationProblem(60)).toBeNull();
    expect(durationProblem(2_592_001)).toBe("At most 30 days.");
    expect(durationProblem(null)).toMatch(/block time/);
  });
});
