import type { ResponseItem, SavedRule } from "@tripwire/shared";
import { describe, expect, it } from "vitest";
import { matches, readQuery, responseText, ruleText } from "./search";

describe("matches", () => {
  const texts = [
    "Assets cover supply",
    "Treasury vault",
    "0xAbC0000000000000000000000000000000000001",
    null,
  ];

  it("finds every word anywhere, in any case", () => {
    expect(matches("vault assets", texts)).toBe(true);
    expect(matches("TREASURY", texts)).toBe(true);
    expect(matches("abc000", texts)).toBe(true);
  });

  it("needs every word", () => {
    expect(matches("vault oracle", texts)).toBe(false);
  });

  it("matches everything when empty", () => {
    expect(matches("", texts)).toBe(true);
    expect(matches("   ", texts)).toBe(true);
  });

  it("does not match across two texts", () => {
    expect(matches("supplytreasury", texts)).toBe(false);
  });
});

describe("readQuery", () => {
  it("keeps a query and drops an empty or malformed one", () => {
    expect(readQuery({ q: "vault" })).toBe("vault");
    expect(readQuery({ q: "  " })).toBeUndefined();
    expect(readQuery({ q: 5 })).toBeUndefined();
    expect(readQuery({})).toBeUndefined();
  });

  it("caps its length", () => {
    expect(readQuery({ q: "x".repeat(500) })).toHaveLength(200);
  });
});

describe("what the rows show", () => {
  const rule = {
    id: "1",
    rule: {
      version: 1,
      name: "Assets cover supply",
      contract: "0x00000000000000000000000000000000000000aa",
      severity: "critical",
      when: "every_block",
      trip_when: true,
      on_trip: { action: "trip_global" },
    },
    sentence: "On every block, trip the whole contract when …",
    enabled: true,
    status: "warming",
  } as unknown as SavedRule;
  const names = new Map([
    ["0x00000000000000000000000000000000000000aa", "Treasury vault"],
  ]);

  it("finds a rule by its action and status as shown", () => {
    expect(matches("vault pause the contract", ruleText(rule, names))).toBe(
      true,
    );
    expect(matches("warming up", ruleText(rule, names))).toBe(true);
    expect(matches("notify only", ruleText(rule, names))).toBe(false);
  });

  it("finds a response by its status and action as shown", () => {
    const item = {
      status: "submitted",
      action: "trip_function",
      rule: { id: "1", name: "Assets cover supply" },
      contract: {
        address: "0x00000000000000000000000000000000000000aa",
        name: "Treasury vault",
      },
      tx: null,
      error: null,
    } as unknown as ResponseItem;
    const pausing = {
      ...rule,
      rule: {
        ...rule.rule,
        on_trip: { action: "trip_function", function: "withdraw(uint256)" },
      },
    } as SavedRule;
    expect(matches("sent", responseText(item))).toBe(true);
    expect(matches("pause withdraw", responseText(item, pausing))).toBe(true);
  });
});
