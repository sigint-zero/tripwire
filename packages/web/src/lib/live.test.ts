import { describe, expect, it } from "vitest";
import { invalidations } from "./live";

describe("what an event refreshes", () => {
  it("refreshes every violation list and the rule on a violation", () => {
    expect(invalidations("violation", { ruleId: "7" })).toEqual(
      expect.arrayContaining([["violations"], ["rules"], ["rule", "7"]]),
    );
  });

  it("refreshes everything on resync, and nothing on a block", () => {
    expect(invalidations("resync", { reason: "connected" })).toBe("all");
    expect(invalidations("block", { number: 1 })).toEqual([]);
  });

  it("refreshes violations when a response moves", () => {
    expect(invalidations("response", { id: "3" })).toEqual(
      expect.arrayContaining([
        ["responses"],
        ["response", "3"],
        ["violations"],
      ]),
    );
  });
});
