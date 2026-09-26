import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EngineReleaseError,
  engineInstallDir,
  engineTarget,
  listedDigest,
  verifiedEngine,
  verifyMinisign,
  type EnginePin,
} from "./release";

const fixtures = new URL("./fixtures/engine-0.1.0/", import.meta.url);
const RELEASE_KEY = "RWSoM+vf95ORaF6HNTzIuR3dLJTdGRkZtNA+Knh6VeqT57s6rMkL25db";

/** A minisign key pair of our own, signing as minisign does (prehashed). */
function minisignKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const id = randomBytes(8);
  return {
    publicKey: Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64"),
    sign(file: Buffer, trusted = "timestamp:0\tfile:SHA256SUMS\thashed") {
      const digest = createHash("blake2b512").update(file).digest();
      const body = sign(null, digest, privateKey);
      const global = sign(
        null,
        Buffer.concat([body, Buffer.from(trusted)]),
        privateKey,
      );
      return [
        "untrusted comment: signature from minisign secret key",
        Buffer.concat([Buffer.from("ED"), id, body]).toString("base64"),
        `trusted comment: ${trusted}`,
        global.toString("base64"),
        "",
      ].join("\n");
    },
  };
}

describe("verifyMinisign", () => {
  it("accepts the published 0.1.0 checksums with the release key", async () => {
    const sums = await readFile(new URL("SHA256SUMS", fixtures));
    const sig = await readFile(new URL("SHA256SUMS.minisig", fixtures), "utf8");
    expect(verifyMinisign(sums, sig, RELEASE_KEY)).toContain("file:SHA256SUMS");
  });

  it("refuses a checksum file changed by one byte", async () => {
    const sums = await readFile(new URL("SHA256SUMS", fixtures));
    const sig = await readFile(new URL("SHA256SUMS.minisig", fixtures), "utf8");
    sums[0] = sums[0] === 0x30 ? 0x31 : 0x30;
    expect(() => verifyMinisign(sums, sig, RELEASE_KEY)).toThrow(
      "does not verify",
    );
  });

  it("refuses a signature from another key", async () => {
    const sums = await readFile(new URL("SHA256SUMS", fixtures));
    const other = minisignKey();
    expect(() => verifyMinisign(sums, other.sign(sums), RELEASE_KEY)).toThrow(
      "different key",
    );
  });

  it("refuses a trusted comment that was edited", () => {
    const key = minisignKey();
    const file = Buffer.from("x");
    const edited = key
      .sign(file)
      .replace("trusted comment: timestamp:0", "trusted comment: timestamp:1");
    expect(() => verifyMinisign(file, edited, key.publicKey)).toThrow(
      "trusted comment",
    );
  });
});

describe("listedDigest and engineTarget", () => {
  it("finds an asset's line and refuses one that is missing", () => {
    const sums = `${"a".repeat(64)}  tripwire-engine-0.1.0-x86_64-unknown-linux-musl\n`;
    expect(
      listedDigest(sums, "tripwire-engine-0.1.0-x86_64-unknown-linux-musl"),
    ).toBe("a".repeat(64));
    expect(() => listedDigest(sums, "views.json")).toThrow("does not list");
  });

  it("names the Linux targets and refuses other platforms", () => {
    expect(engineTarget("linux", "x64")).toBe("x86_64-unknown-linux-musl");
    expect(engineTarget("linux", "arm64")).toBe("aarch64-unknown-linux-musl");
    expect(() => engineTarget("darwin", "arm64")).toThrow(
      "not built for darwin/arm64",
    );
  });
});

describe("verifiedEngine", () => {
  const target = "x86_64-unknown-linux-musl";

  /** An install directory holding a script that reports `reports`, signed by `key`. */
  async function install(options: { reports: string; tamper?: boolean }) {
    const home = await mkdtemp(join(tmpdir(), "tripwire-release-"));
    const key = minisignKey();
    const pin: EnginePin = {
      version: "0.1.0",
      publicKey: key.publicKey,
      releases:
        "https://github.com/sigint-zero/tripwire/releases/download/engine-v{version}/{asset}",
    };
    const dir = engineInstallDir(home, pin.version);
    await mkdir(dir, { recursive: true });
    const script = `#!/bin/sh\necho ${options.reports}\n`;
    const binary = join(dir, "tripwire-engine");
    await writeFile(binary, script);
    await chmod(binary, 0o755);
    const digest = createHash("sha256")
      .update(options.tamper ? `${script}#` : script)
      .digest("hex");
    const sums = Buffer.from(`${digest}  tripwire-engine-0.1.0-${target}\n`);
    await writeFile(join(dir, "SHA256SUMS"), sums);
    await writeFile(join(dir, "SHA256SUMS.minisig"), key.sign(sums));
    return { home, pin, binary };
  }

  it("returns the installed binary when signature, checksum and version hold", async () => {
    const { home, pin, binary } = await install({ reports: "0.1.0" });
    await expect(verifiedEngine({ home, pin, target })).resolves.toEqual({
      version: "0.1.0",
      binary,
    });
  });

  it("says how to install the release when it is not installed", async () => {
    const home = await mkdtemp(join(tmpdir(), "tripwire-release-"));
    const { pin } = await install({ reports: "0.1.0" });
    const error = await verifiedEngine({ home, pin, target }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(EngineReleaseError);
    const message = (error as Error).message;
    expect(message).toContain("Engine 0.1.0 is not installed");
    expect(message).toContain("tripwire engine install");
  });

  it("refuses a binary that does not match its checksum", async () => {
    const { home, pin } = await install({ reports: "0.1.0", tamper: true });
    await expect(verifiedEngine({ home, pin, target })).rejects.toThrow(
      "does not match its SHA256SUMS line",
    );
  });

  it("refuses a binary that reports another version", async () => {
    const { home, pin } = await install({ reports: "0.0.9" });
    await expect(verifiedEngine({ home, pin, target })).rejects.toThrow(
      'reports version "0.0.9"',
    );
  });
});
