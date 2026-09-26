import { describe, expect, it } from "vitest";
import { KeystoreError, newKeystore, openKeystore } from "./keystore";

// Keystore v3 as other tools write it: the Web3 Secret Storage
// definition's own test vector, and our keys opened back.

const vector = {
  crypto: {
    cipher: "aes-128-ctr",
    cipherparams: { iv: "6087dab2f9fdbbfaddc31a909735c1e6" },
    ciphertext:
      "5318b4d5bcd28de64ee5559e671353e16f075ecae9f99c7a79a38af5f869aa46",
    kdf: "pbkdf2",
    kdfparams: {
      c: 262144,
      dklen: 32,
      prf: "hmac-sha256",
      salt: "ae3cd4e7013836a3df6bd7241b12db061dbe2c6785853cce422d148a624ce0bd",
    },
    mac: "517ead924a9d0dc3124507e3393d175ce3ff7c1e96529c6c555ce9e51205e9b2",
  },
  id: "3198bc9c-6672-5ab3-d995-4942343ae5b6",
  version: 3,
};

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error instanceof KeystoreError ? error.code : error),
  );

describe("keystores", () => {
  it("opens the definition's test vector to its address", async () => {
    expect(await openKeystore(vector, "testpassword")).toBe(
      "0x008aeeda4d805471df9b2a5b0f38a0c3bcba786b",
    );
  });

  it("says a wrong passphrase is wrong, and nothing more", async () => {
    await expect(openKeystore(vector, "testpassworD")).rejects.toThrow(
      /^The passphrase does not open this keystore\.$/,
    );
    expect(await code(openKeystore(vector, "nope"))).toBe("wrong_passphrase");
  });

  it("writes keys that open with their passphrase, and name their address", async () => {
    const { address, keystore } = await newKeystore("a long passphrase", 10);
    expect(address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(keystore).toMatchObject({ version: 3, address: address.slice(2) });
    expect(await openKeystore(keystore, "a long passphrase")).toBe(address);
  });

  it("refuses what is not a keystore, or asks too much to open", async () => {
    expect(await code(openKeystore("text", "x"))).toBe("invalid_keystore");
    expect(await code(openKeystore({ version: 3 }, "x"))).toBe(
      "invalid_keystore",
    );
    const greedy = {
      crypto: {
        ...vector.crypto,
        kdf: "scrypt",
        kdfparams: { n: 2 ** 22, r: 8, p: 1, dklen: 32, salt: "00" },
      },
    };
    expect(await code(openKeystore(greedy, "x"))).toBe("invalid_keystore");
  });
});
