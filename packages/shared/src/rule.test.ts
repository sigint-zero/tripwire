import { describe, expect, it } from "vitest";
import { describeRule, formatDuration, formatUint } from "./describe";
import { invariantDraft, rule, type Rule } from "./rule";

const vault = "0x83F20F44975D03b1b09e64809B757c47f942BEeA";
const read = (method: string) =>
  ({ type: "view_call", contract: vault, method }) as const;

const floor: Rule = {
  kind: "expression",
  condition: {
    type: "compare",
    op: "gte",
    left: read("totalAssets()"),
    right: read("totalSupply()"),
  },
};

describe("rule schema", () => {
  it("accepts a comparison between two reads", () => {
    expect(rule.safeParse(floor).success).toBe(true);
  });

  it("accepts nested conditions and historical values", () => {
    const nested = {
      kind: "expression",
      condition: {
        type: "and",
        conditions: [
          floor.kind === "expression" && floor.condition,
          {
            type: "deviation_band",
            value: read("chi()"),
            center: {
              type: "historical",
              key: "chi:twap",
              source: read("chi()"),
              metric: { type: "twap", window_secs: 1200 },
            },
            band_percent: 5,
          },
        ],
      },
    };
    expect(rule.safeParse(nested).success).toBe(true);
  });

  it.each([
    ["a fractional literal", { type: "literal", value: "1.5" }],
    ["a negative literal", { type: "literal", value: "-1" }],
    ["a bad address", { type: "view_call", contract: "0x12", method: "a()" }],
    ["a bare method name", { type: "view_call", contract: vault, method: "a" }],
  ])("rejects %s", (_, left) => {
    const bad = { ...floor, condition: { ...floor.condition, left } };
    expect(rule.safeParse(bad).success).toBe(false);
  });

  it("rejects a fractional band", () => {
    const band = {
      kind: "expression",
      condition: {
        type: "deviation_band",
        value: read("chi()"),
        center: read("chi()"),
        band_percent: 2.5,
      },
    };
    expect(rule.safeParse(band).success).toBe(false);
  });

  it("rejects numbers above 2^256 - 1", () => {
    const huge = (2n ** 256n).toString();
    const bad = {
      ...floor,
      condition: {
        ...floor.condition,
        right: { type: "literal", value: huge },
      },
    };
    expect(rule.safeParse(bad).success).toBe(false);
  });

  it("requires a function selector for function-scoped responses", () => {
    const draft = {
      name: "floor",
      chainId: 1,
      contract: vault,
      rule: floor,
      response: {
        mode: "autonomous",
        scope: { type: "function", selector: "0x12", signature: "exit()" },
        cooldownSecs: 60,
      },
    };
    expect(invariantDraft.safeParse(draft).success).toBe(false);
  });
});

describe("describeRule", () => {
  it("writes comparisons as equations", () => {
    expect(describeRule(floor)).toBe("totalAssets ≥ totalSupply");
  });

  it("writes rate limits in plain terms", () => {
    const growth: Rule = {
      kind: "expression",
      condition: {
        type: "compare",
        op: "lte",
        left: {
          type: "historical",
          key: "supply",
          source: read("totalSupply()"),
          metric: { type: "windowed_delta", window_secs: 86_400 },
        },
        right: {
          type: "scale",
          value: read("totalSupply()"),
          numerator: 5,
          denominator: 100,
        },
      },
    };
    expect(describeRule(growth)).toBe(
      "1d change of totalSupply ≤ 5% of totalSupply",
    );
  });

  it("names the event for log rules", () => {
    expect(
      describeRule({
        kind: "log",
        event: "OwnershipTransferred(address,address)",
        condition: "must_not_appear",
      }),
    ).toBe("OwnershipTransferred never emitted");
  });

  it("formats numbers and durations", () => {
    expect(formatUint("1234567")).toBe("1,234,567");
    expect(formatUint(10n ** 24n)).toBe("1.000e24");
    expect(formatDuration(1200)).toBe("20m");
    expect(formatDuration(86_400)).toBe("1d");
  });
});
