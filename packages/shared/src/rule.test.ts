import { describe, expect, it } from "vitest";
import { describeRule, formatDuration, formatNumber } from "./describe";
import {
  issuesOf,
  rule,
  type BoolNode,
  type Rule,
  type ViewCall,
} from "./rule";

const vault = "0x83F20F44975D03b1b09e64809B757c47f942BEeA";
const read = (fn: string): ViewCall => ({
  node: "view_call",
  function: fn,
  args: [],
});

const floor: Rule = {
  version: 1,
  name: "totalAssets floor",
  contract: vault,
  severity: "critical",
  when: "every_block",
  trip_when: {
    node: "compare",
    op: "lt",
    left: read("totalAssets()"),
    right: read("totalSupply()"),
  },
  on_trip: { action: "notify" },
};

const withCondition = (trip_when: unknown) => ({ ...floor, trip_when });

const issues = (doc: unknown) => {
  const parsed = rule.safeParse(doc);
  return parsed.success ? [] : issuesOf(parsed.error);
};

describe("rule schema", () => {
  it("accepts a comparison between two reads", () => {
    expect(issues(floor)).toEqual([]);
  });

  it("accepts nested conditions and metrics", () => {
    const nested = withCondition({
      node: "or",
      terms: [
        floor.trip_when,
        {
          node: "deviation_band",
          value: read("chi()"),
          center: {
            node: "metric",
            metric: "twap",
            of: read("chi()"),
            window: { seconds: 1200 },
          },
          tolerance_percent: "2.5",
          sides: "both",
        },
      ],
    });
    expect(issues(nested)).toEqual([]);
  });

  it("accepts an event rule that fires on presence alone", () => {
    const event = {
      ...floor,
      when: {
        event:
          "OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
      },
      trip_when: true,
    };
    expect(issues(event)).toEqual([]);
  });

  it("accepts fractional and negative literals", () => {
    const left = { node: "literal", value: "-0.03" };
    expect(
      issues(withCondition({ ...(floor.trip_when as object), left })),
    ).toEqual([]);
  });

  it.each([
    ["a bad address", { ...read("a()"), address: "0x12" }],
    ["a bare method name", read("totalAssets")],
    ["an array parameter", read("balances(address[])")],
    ["a number that is not a string", { node: "literal", value: 1 }],
    ["an unknown field", { ...read("a()"), contract: vault }],
  ])("rejects %s", (_, left) => {
    const bad = withCondition({ ...(floor.trip_when as object), left });
    expect(issues(bad).length).toBeGreaterThan(0);
  });

  it("locates problems with a JSON pointer", () => {
    const bad = withCondition({
      node: "compare",
      op: "gt",
      left: {
        node: "metric",
        metric: "windowed_drop",
        of: read("totalAssets()"),
        window: { seconds: 30 },
      },
      right: { node: "literal", value: "10" },
    });
    expect(issues(bad)).toEqual([
      expect.objectContaining({
        path: "/trip_when/left/window/seconds",
        message: "must be at least 60 seconds",
      }),
    ]);
  });

  it("requires a window exactly when the metric reads one", () => {
    const metric = (m: string, window?: object) =>
      withCondition({
        node: "compare",
        op: "gt",
        left: { node: "metric", metric: m, of: read("a()"), window },
        right: { node: "literal", value: "1" },
      });
    expect(issues(metric("twap"))[0]?.path).toBe("/trip_when/left/window");
    expect(issues(metric("ath", { seconds: 600 }))[0]?.path).toBe(
      "/trip_when/left/window",
    );
    expect(issues(metric("ath"))).toEqual([]);
  });

  it("rejects a band of zero percent", () => {
    const band = withCondition({
      node: "deviation_band",
      value: read("chi()"),
      center: read("rho()"),
      tolerance_percent: "0",
      sides: "both",
    });
    expect(issues(band)[0]?.path).toBe("/trip_when/tolerance_percent");
  });

  it("takes a function only for a function trip", () => {
    expect(
      issues({ ...floor, on_trip: { action: "trip_function" } }).length,
    ).toBeGreaterThan(0);
    expect(
      issues({
        ...floor,
        on_trip: { action: "trip_global", function: "exit()" },
      }).length,
    ).toBeGreaterThan(0);
    expect(
      issues({
        ...floor,
        on_trip: { action: "trip_function", function: "exit()" },
      }),
    ).toEqual([]);
  });

  it("keeps event arguments to event triggers that have them", () => {
    const arg: BoolNode = {
      node: "compare",
      op: "gt",
      left: { node: "event_arg", arg: "value" },
      right: { node: "literal", value: "1000" },
    };
    expect(issues(withCondition(arg))[0]?.message).toMatch(/event trigger/);
    const transfer = {
      ...floor,
      when: {
        event:
          "Transfer(address indexed from, address indexed to, uint256 value)",
      },
      trip_when: arg,
    };
    expect(issues(transfer)).toEqual([]);
    expect(
      issues({
        ...transfer,
        trip_when: { ...arg, left: { node: "event_arg", arg: "amount" } },
      })[0]?.message,
    ).toMatch(/does not have/);
  });

  it("rejects event signatures without parameter names", () => {
    const event = {
      ...floor,
      when: { event: "Paused(address)" },
      trip_when: true,
    };
    expect(issues(event)[0]?.path).toBe("/when/event");
  });
});

describe("describeRule", () => {
  it("reads a rule back as one sentence", () => {
    expect(describeRule(floor)).toBe(
      "On every block, notify when totalAssets() falls below totalSupply() (critical).",
    );
  });

  it("writes metrics, actions and cooldowns in plain terms", () => {
    const outflow: Rule = {
      ...floor,
      severity: "warning",
      trip_when: {
        node: "compare",
        op: "gt",
        left: {
          node: "metric",
          metric: "windowed_drop",
          of: read("totalAssets()"),
          window: { seconds: 3_600 },
        },
        right: { node: "literal", value: "10" },
      },
      on_trip: {
        action: "trip_function",
        function: "withdraw(uint256)",
        cooldown_seconds: 300,
      },
    };
    expect(describeRule(outflow)).toBe(
      "On every block, trip withdraw(uint256) when the 1h percent drop in totalAssets() rises above 10 (warning, 5m cooldown).",
    );
  });

  it("uses names supplied for contract reads", () => {
    const pair: Rule = withCondition({
      node: "compare",
      op: "lt",
      left: { ...read("getReserves()"), returns: 2 },
      right: read("totalSupply()"),
    }) as Rule;
    expect(describeRule(pair)).toMatch(/getReserves\(\)\[2\] falls below/);
    expect(
      describeRule(pair, (call) =>
        call.function === "getReserves()" && call.returns === 2
          ? "getReserves._blockTimestampLast"
          : undefined,
      ),
    ).toMatch(/getReserves._blockTimestampLast falls below/);
  });

  it("names the event for presence rules", () => {
    expect(
      describeRule({
        ...floor,
        when: {
          event:
            "OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
        },
        trip_when: true,
        on_trip: { action: "trip_global" },
      }),
    ).toBe(
      "On each OwnershipTransferred event, trip the whole contract (critical).",
    );
  });

  it("formats numbers and durations", () => {
    expect(formatNumber("1234567")).toBe("1,234,567");
    expect(formatNumber("-1234.5")).toBe("-1,234.5");
    expect(formatNumber(10n ** 24n)).toBe("1.000e24");
    expect(formatDuration(1200)).toBe("20m");
    expect(formatDuration(86_400)).toBe("1d");
  });
});
