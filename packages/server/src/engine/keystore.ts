import {
  createCipheriv,
  createDecipheriv,
  pbkdf2,
  randomBytes,
  randomUUID,
  scrypt,
} from "node:crypto";
import { keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";

// Web3 secret storage (keystore v3), as far as the stand-in keeps keys
// the way the engine does: files any Ethereum tool opens, and an import
// that must decrypt before it is kept.

export class KeystoreError extends Error {
  constructor(
    readonly code: "invalid_keystore" | "wrong_passphrase",
    message: string,
  ) {
    super(message);
    this.name = "KeystoreError";
  }
}

/** The most scrypt memory an import may ask for: the standard's 256 MB. */
const MAX_SCRYPT_BLOCKS = 2 ** 18 * 8;
const MAX_PBKDF2_ROUNDS = 10_000_000;

const hex = (value: unknown) =>
  typeof value === "string" && /^(0x)?([0-9a-f]{2})*$/i.test(value)
    ? Buffer.from(value.replace(/^0x/i, ""), "hex")
    : null;
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;

function invalid(message: string): never {
  throw new KeystoreError("invalid_keystore", message);
}

function derive(
  passphrase: string,
  kdf: unknown,
  params: Record<string, unknown>,
): Promise<Buffer> {
  const salt = hex(params.salt) ?? invalid("The salt is not hex.");
  const length = count(params.dklen) ?? invalid("No key length.");
  if (length < 32) invalid("The derived key is shorter than 32 bytes.");
  if (kdf === "scrypt") {
    const n = count(params.n);
    const r = count(params.r);
    const p = count(params.p);
    if (!n || !r || !p || (n & (n - 1)) !== 0) {
      invalid("The scrypt parameters are not valid.");
    }
    if (n * r > MAX_SCRYPT_BLOCKS) {
      invalid("The scrypt parameters ask for more memory than allowed.");
    }
    return new Promise((resolve, reject) =>
      scrypt(
        passphrase,
        salt,
        length,
        { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 },
        (error, key) => (error ? reject(error) : resolve(key)),
      ),
    );
  }
  if (kdf === "pbkdf2") {
    const rounds = count(params.c) ?? invalid("No pbkdf2 round count.");
    if (params.prf !== "hmac-sha256") invalid("Only hmac-sha256 is supported.");
    if (rounds > MAX_PBKDF2_ROUNDS) invalid("Too many pbkdf2 rounds.");
    return new Promise((resolve, reject) =>
      pbkdf2(passphrase, salt, rounds, length, "sha256", (error, key) =>
        error ? reject(error) : resolve(key),
      ),
    );
  }
  return invalid("The key derivation is neither scrypt nor pbkdf2.");
}

const macOf = (key: Buffer, ciphertext: Buffer) =>
  keccak256(Buffer.concat([key.subarray(16, 32), ciphertext]), "bytes");

/** Opens a keystore: its lowercase address, once the passphrase proves right. */
export async function openKeystore(
  keystore: unknown,
  passphrase: string,
): Promise<string> {
  if (typeof keystore !== "object" || keystore === null) {
    invalid("Not a keystore: expected a JSON object.");
  }
  const raw = keystore as Record<string, unknown>;
  const crypto = (raw.crypto ?? raw.Crypto) as
    Record<string, unknown> | undefined;
  if (typeof crypto !== "object" || crypto === null) {
    invalid("No crypto section; expected Web3 secret storage.");
  }
  if (crypto.cipher !== "aes-128-ctr")
    invalid("The cipher is not aes-128-ctr.");
  const iv =
    hex((crypto.cipherparams as { iv?: unknown } | undefined)?.iv) ??
    invalid("The iv is not hex.");
  const ciphertext = hex(crypto.ciphertext) ?? invalid("No ciphertext.");
  const mac = hex(crypto.mac) ?? invalid("No mac.");
  const params = crypto.kdfparams;
  if (typeof params !== "object" || params === null) invalid("No kdfparams.");

  const key = await derive(
    passphrase,
    crypto.kdf,
    params as Record<string, unknown>,
  );
  if (!Buffer.from(macOf(key, ciphertext)).equals(mac)) {
    throw new KeystoreError(
      "wrong_passphrase",
      "The passphrase does not open this keystore.",
    );
  }
  const decipher = createDecipheriv("aes-128-ctr", key.subarray(0, 16), iv);
  const secret = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  try {
    if (secret.length !== 32) invalid("The key is not 32 bytes.");
    return privateKeyToAddress(`0x${secret.toString("hex")}`).toLowerCase();
  } catch (error) {
    if (error instanceof KeystoreError) throw error;
    return invalid("The decrypted key is not on the curve.");
  } finally {
    secret.fill(0);
    key.fill(0);
  }
}

/**
 * A new key's keystore. `cost` is log2 of scrypt's N; the standard's is
 * 18, and the stand-in, which guards no funds, uses less.
 */
export async function newKeystore(
  passphrase: string,
  cost = 13,
): Promise<{ address: string; keystore: object }> {
  const secret = Buffer.from(generatePrivateKey().slice(2), "hex");
  const address = privateKeyToAddress(
    `0x${secret.toString("hex")}`,
  ).toLowerCase();
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const params = { n: 2 ** cost, r: 8, p: 1, dklen: 32 };
  const key = await derive(passphrase, "scrypt", {
    ...params,
    salt: salt.toString("hex"),
  });
  const cipher = createCipheriv("aes-128-ctr", key.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  const mac = Buffer.from(macOf(key, ciphertext));
  secret.fill(0);
  key.fill(0);
  return {
    address,
    keystore: {
      version: 3,
      id: randomUUID(),
      address: address.slice(2),
      crypto: {
        cipher: "aes-128-ctr",
        cipherparams: { iv: iv.toString("hex") },
        ciphertext: ciphertext.toString("hex"),
        kdf: "scrypt",
        kdfparams: { ...params, salt: salt.toString("hex") },
        mac: mac.toString("hex"),
      },
    },
  };
}
