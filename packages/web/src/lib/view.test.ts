import { describe, expect, it } from "vitest";
import { readView } from "./view";

describe("readView", () => {
  const kept = (value: string | null) => ({ getItem: () => value });

  it("reads a saved choice", () => {
    expect(readView(kept("cards"))).toBe("cards");
    expect(readView(kept("rows"))).toBe("rows");
  });

  it("falls back to rows for nothing, junk, or no site data", () => {
    expect(readView(kept(null))).toBe("rows");
    expect(readView(kept("grid"))).toBe("rows");
    expect(readView(null)).toBe("rows");
    expect(
      readView({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe("rows");
  });
});
