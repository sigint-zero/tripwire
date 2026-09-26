import { rule } from "@tripwire/shared";
import { describe, expect, it } from "vitest";
import { describeAbi } from "./abi";
import {
  initialValues,
  isSuggested,
  NUMBER_PREFIX,
  templates,
  type Watch,
} from "./templates";

const vault = "0x83F20F44975D03b1b09e64809B757c47f942BEeA";

const abi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "totalAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [],
  },
  {
    type: "event",
    name: "OwnershipTransferred",
    inputs: [
      { name: "previousOwner", type: "address", indexed: true },
      { name: "newOwner", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "Anonymous",
    inputs: [{ type: "address" }],
  },
  {
    type: "event",
    name: "Batch",
    inputs: [{ name: "ids", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [{ type: "tuple", components: [{ type: "uint256" }] }],
    outputs: [],
  },
];

const surface = describeAbi(abi);

describe("describeAbi", () => {
  it("offers numeric no-argument reads, one per numeric output", () => {
    expect(surface.reads.map((r) => r.label)).toEqual([
      "decimals",
      "latestRoundData.answer",
      "latestRoundData.answeredInRound",
      "latestRoundData.roundId",
      "latestRoundData.startedAt",
      "latestRoundData.updatedAt",
      "totalAssets",
      "totalSupply",
    ]);
  });

  it("computes selectors for functions that can be paused", () => {
    expect(surface.writes).toEqual([
      { signature: "transfer(address,uint256)", selector: "0xa9059cbb" },
    ]);
  });

  it("lists events in declaration style, as rules name them", () => {
    expect(surface.events).toEqual([
      {
        signature:
          "OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
        name: "OwnershipTransferred",
      },
    ]);
  });

  it("leaves out what a rule cannot reference", () => {
    // Unnamed event parameters, arrays and tuples.
    expect(surface.events.map((e) => e.name)).not.toContain("Anonymous");
    expect(surface.events.map((e) => e.name)).not.toContain("Batch");
    expect(surface.writes.map((w) => w.signature)).toEqual([
      "transfer(address,uint256)",
    ]);
  });
});

/** A whole rule around what a template builds. */
const document = (watch: Watch | null) =>
  watch && {
    version: 1,
    name: "test",
    contract: vault,
    severity: "warning",
    ...watch,
    on_trip: { action: "notify" },
  };

const byId = (id: string) => templates.find((t) => t.id === id)!;

describe("templates", () => {
  it.each(templates.map((t) => [t.id, t] as const))(
    "%s builds a valid rule from its defaults",
    (_, template) => {
      const built = document(template.build(initialValues(template, surface)));
      expect(built).not.toBeNull();
      const parsed = rule.safeParse(built);
      expect(parsed.error?.issues).toBeUndefined();
    },
  );

  it("states the violation: a floor trips when the value falls below it", () => {
    const watch = byId("floor").build({
      value: "totalAssets()",
      floor: "totalSupply()",
    });
    expect(watch).toEqual({
      when: "every_block",
      trip_when: {
        node: "compare",
        op: "lt",
        left: { node: "view_call", function: "totalAssets()", args: [] },
        right: { node: "view_call", function: "totalSupply()", args: [] },
      },
    });
  });

  it.each([
    ["ge", "lt"],
    ["gt", "le"],
    ["le", "gt"],
    ["lt", "ge"],
    ["eq", "ne"],
    ["ne", "eq"],
  ])("trips a custom comparison stated as %s when %s", (op, trips) => {
    const watch = byId("compare").build({
      left: "totalAssets()",
      op,
      right: `${NUMBER_PREFIX}5`,
    });
    expect(watch?.trip_when).toMatchObject({ node: "compare", op: trips });
  });

  it("limits growth to a share of the value", () => {
    const watch = byId("growth").build({
      value: "totalSupply()",
      percent: "5",
      window: "86400",
    });
    expect(watch?.trip_when).toMatchObject({
      op: "gt",
      left: { metric: "windowed_delta", window: { seconds: 86_400 } },
      right: { op: "mul", right: { node: "literal", value: "0.05" } },
    });
  });

  it("fires an event rule on the event alone", () => {
    const signature = surface.events[0]!.signature;
    expect(byId("event").build({ event: signature })).toEqual({
      when: { event: signature },
      trip_when: true,
    });
  });

  it("picks sensible defaults over constants like decimals", () => {
    const pick = (id: string, key: string) => {
      const template = templates.find((t) => t.id === id)!;
      return initialValues(template, surface)[key];
    };
    expect(pick("floor", "value")).toBe("totalAssets()");
    expect(pick("floor", "floor")).toBe("totalSupply()");
    expect(pick("fresh", "timestamp")).toBe("latestRoundData()#3");
    expect(pick("compare", "left")).not.toBe("decimals()");
  });

  it("returns nothing until every blank is filled", () => {
    expect(
      byId("floor").build({ value: "totalAssets()", floor: NUMBER_PREFIX }),
    ).toBeNull();
  });
});

describe("suggestions", () => {
  it("suggests templates whose signals the contract has", () => {
    const suggested = templates
      .filter((t) => isSuggested(t, surface))
      .map((t) => t.id);
    expect(suggested).toEqual([
      "floor",
      "band",
      "growth",
      "outflow",
      "fresh",
      "event",
    ]);
  });

  it("never suggests the custom comparison", () => {
    expect(isSuggested(byId("compare"), surface)).toBe(false);
  });

  it("leaves example blanks empty when nothing fits", () => {
    const tokenOnly = describeAbi(
      abi.filter((e) => e.name !== "latestRoundData"),
    );
    expect(isSuggested(byId("fresh"), tokenOnly)).toBe(false);
    expect(initialValues(byId("fresh"), tokenOnly)).toEqual({ window: "3600" });
  });
});

describe("a Uniswap V2 pair", () => {
  const pair = describeAbi([
    {
      type: "function",
      name: "getReserves",
      stateMutability: "view",
      inputs: [],
      outputs: [
        { name: "_reserve0", type: "uint112" },
        { name: "_reserve1", type: "uint112" },
        { name: "_blockTimestampLast", type: "uint32" },
      ],
    },
    {
      type: "function",
      name: "price0CumulativeLast",
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: "uint256" }],
    },
    {
      type: "function",
      name: "totalSupply",
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: "uint256" }],
    },
  ]);
  const pick = (id: string, key: string) =>
    initialValues(
      templates.find((t) => t.id === id)!,
      pair,
    )[key];

  it("names the output it reads, even the first", () => {
    const watch = templates
      .find((t) => t.id === "floor")!
      .build({ value: "getReserves()#0", floor: "totalSupply()" });
    expect(watch?.trip_when).toMatchObject({
      left: { function: "getReserves()", returns: 0 },
      right: { function: "totalSupply()" },
    });
    expect(watch?.trip_when).not.toHaveProperty("right.returns");
  });

  it("matches output names, not the function they come from", () => {
    expect(pick("floor", "value")).toBe("getReserves()#0");
    expect(pick("outflow", "value")).toBe("getReserves()#0");
    expect(pick("fresh", "timestamp")).toBe("getReserves()#2");
  });

  it("does not treat a cumulative price accumulator as a price", () => {
    const band = templates.find((t) => t.id === "band")!;
    expect(isSuggested(band, pair)).toBe(false);
  });
});
