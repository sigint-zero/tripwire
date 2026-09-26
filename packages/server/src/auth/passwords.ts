import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// Passwords are hashed with scrypt from the standard library, so the
// single-file bundle needs no native module. The stored string carries its
// parameters, so they can be raised later and old hashes re-hashed on the
// next successful login.

/** log2 of scrypt's N: 2^17 costs about 128 MB and a few hundred ms. */
export const DEFAULT_COST = 17;
const R = 8;
const P = 1;
const KEY_BYTES = 32;

function derive(
  password: string,
  salt: Buffer,
  cost: number,
  r: number,
  p: number,
): Promise<Buffer> {
  const N = 2 ** cost;
  return new Promise((resolve, reject) =>
    scrypt(
      password.normalize("NFC"),
      salt,
      KEY_BYTES,
      { N, r, p, maxmem: 256 * N * r * p },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}

/** `scrypt$<log2 N>$<r>$<p>$<salt>$<key>`, salt and key in base64url. */
export async function hashPassword(
  password: string,
  cost = DEFAULT_COST,
): Promise<string> {
  const salt = randomBytes(32);
  const key = await derive(password, salt, cost, R, P);
  return [
    "scrypt",
    cost,
    R,
    P,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [scheme, cost, r, p, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !cost || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, "base64url");
  const actual = await derive(
    password,
    Buffer.from(salt, "base64url"),
    Number(cost),
    Number(r),
    Number(p),
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** True when a hash was made with weaker parameters than `cost`. */
export function needsRehash(stored: string, cost = DEFAULT_COST): boolean {
  const [, logN, r, p] = stored.split("$");
  return Number(logN) < cost || Number(r) !== R || Number(p) !== P;
}
