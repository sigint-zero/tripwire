import { rule } from "@tripwire/shared";
import { describe, expect, it } from "vitest";
import { describeAbi } from "./abi";
import { initialValues, NUMBER_PREFIX, templates } from "./templates";

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
    inputs: [{ type: "address" }, { type: "address" }],
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

  it("lists events with their signatures", () => {
    expect(surface.events).toEqual([
      {
        signature: "OwnershipTransferred(address,address)",
        name: "OwnershipTransferred",
      },
    ]);
  });
});

describe("templates", () => {
  it.each(templates.map((t) => [t.id, t] as const))(
    "%s builds a valid rule from its defaults",
    (_, template) => {
      const built = template.build(initialValues(template, surface), vault);
      expect(built).not.toBeNull();
      expect(rule.safeParse(built).success).toBe(true);
    },
  );

  it("picks sensible defaults over constants like decimals", () => {
    const pick = (id: string, key: string) => {
      const template = templates.find((t) => t.id === id)!;
      return initialValues(template, surface)[key];
    };
    expect(pick("floor", "value")).toBe("totalAssets()#0");
    expect(pick("floor", "floor")).toBe("totalSupply()#0");
    expect(pick("fresh", "timestamp")).toBe("latestRoundData()#3");
    expect(pick("compare", "left")).not.toBe("decimals()#0");
  });

  it("returns nothing until every blank is filled", () => {
    const floor = templates.find((t) => t.id === "floor")!;
    expect(
      floor.build({ value: "totalAssets()#0", floor: NUMBER_PREFIX }, vault),
    ).toBeNull();
  });
});
