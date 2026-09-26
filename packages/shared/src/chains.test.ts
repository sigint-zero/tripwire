import { describe, expect, it } from "vitest";
import { chainCurrency, explorerUrl } from "./chains";

describe("chains", () => {
  it("links an address and a transaction on the chain's explorer", () => {
    expect(explorerUrl(1, "address", "0xabc")).toBe(
      "https://etherscan.io/address/0xabc",
    );
    expect(explorerUrl(8453, "tx", "0xdef")).toBe(
      "https://basescan.org/tx/0xdef",
    );
    expect(explorerUrl(999, "tx", "0xdef")).toBeNull();
  });

  it("names what gas is paid in", () => {
    expect(chainCurrency(1)).toBe("ETH");
    expect(chainCurrency(137)).toBe("POL");
    expect(chainCurrency(999)).toBe("ETH");
  });
});
