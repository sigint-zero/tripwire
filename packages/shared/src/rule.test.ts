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
/** A read declaring what it returns, a uint256 unless given. */
const read = (fn: string, returns = "uint256"): ViewCall => ({
  node: "view_call",
  function: `${fn} returns (${returns})`,
  args: [],
});
const PAIR = "uint112,uint112,uint32";

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

  it("needs reads to declare what they return", () => {
    const bare = withCondition({
      ...(floor.trip_when as object),
      left: { node: "view_call", function: "totalAssets()", args: [] },
    });
    expect(issues(bare)[0]).toMatchObject({
      path: "/trip_when/left/function",
      message: expect.stringMatching(/must declare what it returns/) as string,
    });
  });

  it("keeps a read's output within what it declares", () => {
    const beyond = withCondition({
      ...(floor.trip_when as object),
      left: { ...read("getReserves()", PAIR), returns: 3 },
    });
    expect(issues(beyond)[0]?.path).toBe("/trip_when/left/returns");
  });

  it("orders only numbers", () => {
    const owner = withCondition({
      ...(floor.trip_when as object),
      left: read("owner()", "address"),
    });
    expect(issues(owner)).toEqual([
      expect.objectContaining({
        path: "/trip_when/left",
        message: "must be a number, not address",
      }),
    ]);
  });

  it("compares equality between values of one type", () => {
    const paused = (right: object) =>
      withCondition({
        node: "compare",
        op: "eq",
        left: read("paused()", "bool"),
        right,
      });
    expect(issues(paused(read("owner()", "address")))[0]?.message).toBe(
      "compares bool with address",
    );
    expect(issues(paused(read("stopped()", "bool")))).toEqual([]);
  });

  it("averages only numbers", () => {
    const band = withCondition({
      node: "deviation_band",
      value: read("chi()"),
      center: {
        node: "metric",
        metric: "twap",
        of: read("owner()", "address"),
        window: { seconds: 600 },
      },
      tolerance_percent: "5",
      sides: "both",
    });
    expect(issues(band)[0]?.path).toBe("/trip_when/center/of");
  });

  it("checks a read's arguments against its parameters", () => {
    const balance = (args: string[]) =>
      withCondition({
        ...(floor.trip_when as object),
        left: { ...read("balanceOf(address)"), args },
      });
    expect(issues(balance([]))[0]?.path).toBe("/trip_when/left/args");
    expect(issues(balance(["0x12"]))[0]?.path).toBe("/trip_when/left/args/0");
    expect(issues(balance([vault]))).toEqual([]);
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

describe("agreeing with the engine's rule language", () => {
  const literal = (value: string) => ({ node: "literal", value });
  const against = (left: object, value: string, op = "eq") =>
    issues(withCondition({ node: "compare", op, left, right: literal(value) }));

  it("takes a literal in the form its position expects", () => {
    const owner = read("owner()", "address");
    expect(
      against(owner, "0x3000000000000000000000000000000000000003", "ne"),
    ).toEqual([]);
    expect(against(owner, "1000")).toEqual([
      expect.objectContaining({ path: "/trip_when/right/value" }),
    ]);
    expect(against(read("paused()", "bool"), "true")).toEqual([]);
    expect(against(read("totalSupply()"), "true", "gt")).toEqual([
      expect.objectContaining({
        path: "/trip_when/right/value",
        message: 'must be a decimal string, like "1.5"',
      }),
    ]);
  });

  it("keeps a scale within 77 places either way", () => {
    const scaled = (decimals: number) =>
      against({ node: "scale", expr: read("price()"), decimals }, "1", "gt");
    expect(scaled(-77)).toEqual([]);
    expect(scaled(100)).toEqual([
      expect.objectContaining({ path: "/trip_when/left/decimals" }),
    ]);
  });

  it("neither reads nor filters an indexed string, only its hash is on chain", () => {
    const uri = {
      ...floor,
      when: {
        event: "URI(string indexed value, uint256 id)",
        filters: [{ arg: "value", eq: "ipfs://x" }],
      },
      trip_when: true,
    };
    expect(issues(uri)).toEqual([
      expect.objectContaining({ path: "/when/filters/0/arg" }),
    ]);
    expect(
      issues({
        ...uri,
        when: { event: uri.when.event },
        trip_when: {
          node: "compare",
          op: "eq",
          left: { node: "event_arg", arg: "value" },
          right: literal("1"),
        },
      }),
    ).toEqual([expect.objectContaining({ path: "/trip_when/left/arg" })]);
  });

  it("checks a filter's value against its argument's type", () => {
    const minted = {
      ...floor,
      when: {
        event:
          "Transfer(address indexed from, address indexed to, uint256 value)",
        filters: [{ arg: "from", eq: "nobody" }],
      },
      trip_when: true,
    };
    expect(issues(minted)).toEqual([
      expect.objectContaining({ path: "/when/filters/0/eq" }),
    ]);
  });

  it("points at the field itself for unknown nodes, kinds and keys", () => {
    expect(against({ node: "mystery" }, "1", "gt")).toEqual([
      expect.objectContaining({ path: "/trip_when/left/node" }),
    ]);
    expect(
      against({ node: "metric", metric: "ath", of: literal("5") }, "1", "gt"),
    ).toEqual([
      expect.objectContaining({
        path: "/trip_when/left/of",
        message: "must be a view_call node",
      }),
    ]);
    expect(issues({ ...floor, note: "hi" })).toEqual([
      expect.objectContaining({
        path: "/note",
        message: "is not a field here",
      }),
    ]);
  });
});

describe("calling a function when a rule trips", () => {
  const call = (fields: object) => ({
    ...floor,
    on_trip: {
      action: "call",
      call: { function: "pause()", args: [], ...fields },
      cooldown_seconds: 300,
    },
  });

  it("accepts a call to the contract's own function", () => {
    expect(issues(call({}))).toEqual([]);
    expect(issues(call({ address: null, value: "0" }))).toEqual([]);
  });

  it("checks the call's arguments against its signature", () => {
    const setCap = call({ function: "setCap(uint8)", args: ["300"] });
    expect(issues(setCap)).toEqual([
      expect.objectContaining({
        path: "/on_trip/call/args/0",
        message: "is out of range for uint8",
      }),
    ]);
  });

  it("sends a whole number of wei", () => {
    expect(issues(call({ value: "0.5" }))[0]?.path).toBe("/on_trip/call/value");
  });

  it("verifies the effect with state readable at any block", () => {
    const paused = {
      node: "compare",
      op: "eq",
      left: read("paused()", "bool"),
      right: read("stopped()", "bool"),
    };
    expect(issues(call({ verify: paused }))).toEqual([]);
    const warming = {
      node: "compare",
      op: "gt",
      left: { node: "metric", metric: "ath", of: read("totalAssets()") },
      right: { node: "literal", value: "0" },
    };
    expect(issues(call({ verify: warming }))[0]?.path).toBe(
      "/on_trip/call/verify/left",
    );
  });

  it("reads the call back in the sentence", () => {
    expect(
      describeRule(call({ function: "setCap(uint256)", args: ["0"] }) as Rule),
    ).toBe(
      "On every block, call setCap(0) when totalAssets() falls below totalSupply() (critical, 5m cooldown).",
    );
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
      left: { ...read("getReserves()", PAIR), returns: 2 },
      right: read("totalSupply()"),
    }) as Rule;
    expect(describeRule(pair)).toMatch(/getReserves\(\)\[2\] falls below/);
    expect(
      describeRule(pair, (call) =>
        call.function === `getReserves() returns (${PAIR})` &&
        call.returns === 2
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
