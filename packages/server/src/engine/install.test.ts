import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  installedVersions,
  installEngine,
  installEngineFrom,
  pruneVersions,
} from "./install";
import { engineInstallDir, type EnginePin } from "./release";

const TARGET = "x86_64-unknown-linux-musl";
const ASSET = `tripwire-engine-0.1.0-${TARGET}`;
const ENGINE = Buffer.from('#!/bin/sh\necho "0.1.0"\n');

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

const key = minisignKey();
const other = minisignKey();
const sums = (engine: Buffer) =>
  Buffer.from(
    `${createHash("sha256").update(engine).digest("hex")}  ${ASSET}\n`,
  );

/** What the release server serves, per test. */
let files: Record<string, Buffer | string> = {};
let server: Server;
let pin: EnginePin;

beforeAll(async () => {
  server = createServer((req, res) => {
    const name = req.url!.split("/").pop()!;
    const body = files[name];
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-length": Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  pin = {
    version: "0.1.0",
    publicKey: key.publicKey,
    releases: `http://127.0.0.1:${port}/engine-v{version}/{asset}`,
  };
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));

const home = () => mkdtemp(join(tmpdir(), "tripwire-install-"));
const release = (engine = ENGINE, signer = key) => {
  const s = sums(ENGINE);
  return {
    SHA256SUMS: s,
    "SHA256SUMS.minisig": signer.sign(s),
    [ASSET]: engine,
  };
};

describe("installEngine", () => {
  it("downloads, verifies and installs the pinned release, with progress", async () => {
    files = release();
    const h = await home();
    const progress: number[] = [];
    const installed = await installEngine({
      home: h,
      pin,
      target: TARGET,
      onProgress: (p) => progress.push(p.bytes),
      retryDelayMs: 1,
    });
    expect(installed.binary).toBe(
      join(engineInstallDir(h, "0.1.0"), "tripwire-engine"),
    );
    expect((await stat(installed.binary)).mode & 0o777).toBe(0o755);
    expect(progress.at(-1)).toBe(ENGINE.length);
    // Nothing half-downloaded is left behind.
    expect(
      (await readdir(join(h, "engine", "bin"))).filter((n) =>
        n.startsWith("."),
      ),
    ).toEqual([]);
  });

  it("refuses an executable changed by one byte, and installs nothing", async () => {
    const changed = Buffer.from(ENGINE);
    changed[changed.length - 2] = changed[changed.length - 2]! ^ 1;
    files = release(changed);
    const h = await home();
    await expect(
      installEngine({ home: h, pin, target: TARGET, retryDelayMs: 1 }),
    ).rejects.toThrow("does not match its line in SHA256SUMS");
    expect(await readdir(join(h, "engine", "bin"))).toEqual([]);
  });

  it("refuses checksums signed by another key", async () => {
    files = release(ENGINE, other);
    await expect(
      installEngine({
        home: await home(),
        pin,
        target: TARGET,
        retryDelayMs: 1,
      }),
    ).rejects.toThrow("different key");
  });

  it("says how to fetch it by hand when the release is not there", async () => {
    files = {};
    const error = await installEngine({
      home: await home(),
      pin,
      target: TARGET,
      retryDelayMs: 1,
    }).then(
      () => new Error("installed"),
      (e: unknown) => e as Error,
    );
    expect(error.message).toContain("was not found");
    expect(error.message).toContain("curl -fL");
  });

  it("takes the release from TRIPWIRE_ENGINE_RELEASES when set", async () => {
    files = release();
    await expect(
      installEngine({
        home: await home(),
        pin: { ...pin, releases: "http://127.0.0.1:1/{version}/{asset}" },
        target: TARGET,
        env: { TRIPWIRE_ENGINE_RELEASES: pin.releases },
        retryDelayMs: 1,
      }),
    ).resolves.toMatchObject({ version: "0.1.0" });
  });
});

describe("installEngineFrom", () => {
  it("installs from a directory with the same checks", async () => {
    const dir = await home();
    for (const [name, body] of Object.entries(release())) {
      await writeFile(join(dir, name), body);
    }
    const h = await home();
    await expect(
      installEngineFrom({ dir, home: h, pin, target: TARGET }),
    ).resolves.toMatchObject({ version: "0.1.0" });
    expect(await installedVersions(h, pin, TARGET)).toEqual([
      { version: "0.1.0", verified: true, problem: null },
    ]);

    await writeFile(join(dir, ASSET), Buffer.from("#!/bin/sh\necho 0.1.1\n"));
    await expect(
      installEngineFrom({ dir, home: await home(), pin, target: TARGET }),
    ).rejects.toThrow("does not match");
  });
});

describe("pruneVersions", () => {
  it("keeps the pinned version and the one before it", async () => {
    const h = await home();
    for (const v of ["0.0.8", "0.0.9", "0.1.0", ".download-x"]) {
      await mkdir(join(h, "engine", "bin", v), { recursive: true });
    }
    await pruneVersions(h, pin);
    expect((await readdir(join(h, "engine", "bin"))).sort()).toEqual([
      ".download-x",
      "0.0.9",
      "0.1.0",
    ]);
  });
});
