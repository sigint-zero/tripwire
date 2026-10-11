import { describe, expect, it } from "vitest";
import { matches, readQuery } from "./search";

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
