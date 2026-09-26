import { rule } from "@tripwire/shared";
import { describe, expect, it } from "vitest";
import { describeAbi } from "./abi";
import {
  initialValues,
  isSuggested,
  NUMBER_PREFIX,
  recoverTemplate,
  templates,
  type Watch,
} from "./templates";

const vault = "0x83F20F44975D03b1b09e64809B757c47f942BEeA";

// Reads as rules name them: declaring what they return.
const ASSETS = "totalAssets() returns (uint256)";
const SUPPLY = "totalSupply() returns (uint256)";
const ROUND =
  "latestRoundData() returns (uint80,int256,uint256,uint256,uint80)";
const RESERVES = "getReserves() returns (uint112,uint112,uint32)";

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
      {
        signature: "transfer(address,uint256)",
        selector: "0xa9059cbb",
        inputs: [
          { name: "", type: "address" },
          { name: "", type: "uint256" },
        ],
      },
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

  it("names reads with what they return", () => {
    expect(surface.reads.find((r) => r.label === "totalAssets")?.id).toBe(
      ASSETS,
    );
    expect(
      surface.reads.find((r) => r.label === "latestRoundData.updatedAt"),
    ).toMatchObject({ method: ROUND, returns: 3 });
  });

  it("leaves out reads whose outputs cannot all be declared", () => {
    const withStruct = describeAbi([
      {
        type: "function",
        name: "position",
        stateMutability: "view",
        inputs: [],
        outputs: [
          { name: "size", type: "uint256" },
          { name: "owners", type: "address[]" },
        ],
      },
    ]);
    expect(withStruct.reads).toEqual([]);
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
      value: ASSETS,
      floor: SUPPLY,
    });
    expect(watch).toEqual({
      when: "every_block",
      trip_when: {
        node: "compare",
        op: "lt",
        left: { node: "view_call", function: ASSETS, args: [] },
        right: { node: "view_call", function: SUPPLY, args: [] },
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
      left: ASSETS,
      op,
      right: `${NUMBER_PREFIX}5`,
    });
    expect(watch?.trip_when).toMatchObject({ node: "compare", op: trips });
  });

  it("limits growth to a share of the value", () => {
    const watch = byId("growth").build({
      value: SUPPLY,
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
    expect(pick("floor", "value")).toBe(ASSETS);
    expect(pick("floor", "floor")).toBe(SUPPLY);
    expect(pick("fresh", "timestamp")).toBe(`${ROUND}#3`);
    expect(pick("compare", "left")).not.toBe("decimals() returns (uint8)");
  });

  it("returns nothing until every blank is filled", () => {
    expect(
      byId("floor").build({ value: ASSETS, floor: NUMBER_PREFIX }),
    ).toBeNull();
  });
});

describe("reading a stored rule back into blanks", () => {
  it("recovers every starting point with its blanks", () => {
    for (const template of templates) {
      const values = initialValues(template, surface);
      const watch = template.build(values)!;
      expect(watch, template.id).not.toBeNull();
      const recovered = recoverTemplate(watch, surface);
      expect(recovered?.template.build(recovered.values), template.id).toEqual(
        watch,
      );
    }
  });

  it("reads a comparison back as the sentence states it", () => {
    const compare = templates.find((t) => t.id === "compare")!;
    const values = {
      left: SUPPLY,
      op: "le",
      right: `${NUMBER_PREFIX}1000`,
    };
    expect(recoverTemplate(compare.build(values)!, surface)).toMatchObject({
      template: { id: "compare" },
      values,
    });
  });

  it("gives up on a document no starting point builds", () => {
    const either: Watch = {
      when: "every_block",
      trip_when: {
        node: "or",
        terms: [
          {
            node: "compare",
            op: "lt",
            left: { node: "view_call", function: ASSETS, args: [] },
            right: { node: "literal", value: "1" },
          },
          {
            node: "compare",
            op: "lt",
            left: { node: "view_call", function: SUPPLY, args: [] },
            right: { node: "literal", value: "1" },
          },
        ],
      },
    };
    expect(recoverTemplate(either, surface)).toBeNull();
  });

  it("gives up on a read the contract no longer offers", () => {
    const floor = templates.find((t) => t.id === "floor")!;
    const watch = floor.build({
      value: "totalBorrows() returns (uint256)",
      floor: `${NUMBER_PREFIX}1`,
    })!;
    expect(recoverTemplate(watch, surface)).toBeNull();
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
      .build({ value: `${RESERVES}#0`, floor: SUPPLY });
    expect(watch?.trip_when).toMatchObject({
      left: { function: RESERVES, returns: 0 },
      right: { function: SUPPLY },
    });
    expect(watch?.trip_when).not.toHaveProperty("right.returns");
  });

  it("matches output names, not the function they come from", () => {
    expect(pick("floor", "value")).toBe(`${RESERVES}#0`);
    expect(pick("outflow", "value")).toBe(`${RESERVES}#0`);
    expect(pick("fresh", "timestamp")).toBe(`${RESERVES}#2`);
  });

  it("does not treat a cumulative price accumulator as a price", () => {
    const band = templates.find((t) => t.id === "band")!;
    expect(isSuggested(band, pair)).toBe(false);
  });
});
