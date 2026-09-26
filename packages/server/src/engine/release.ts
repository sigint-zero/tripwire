import { spawn } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The pinned engine release and the check an installed copy must pass
 * before it runs (`ENGINE.md`, Installing). A release fetched by hand into
 * `TRIPWIRE_HOME/engine/bin/<version>/` is checked exactly as a download
 * would be.
 */

/** `engine.json`, shipped beside the command line. */
export interface EnginePin {
  version: string;
  /** The minisign public key the engine's releases are signed with. */
  publicKey: string;
  /** Asset URL template: `{version}` and `{asset}` are substituted. */
  releases: string;
}

export class EngineReleaseError extends Error {}

/** The release target for this machine; the engine is built for Linux only for now. */
export function engineTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === "linux" && arch === "x64")
    return "x86_64-unknown-linux-musl";
  if (platform === "linux" && arch === "arm64") {
    return "aarch64-unknown-linux-musl";
  }
  throw new EngineReleaseError(
    `The engine is not built for ${platform}/${arch}. Run Tripwire on Linux (a container or WSL works).`,
  );
}

/** Where a release is installed. */
export function engineInstallDir(home: string, version: string): string {
  return join(home, "engine", "bin", version);
}

/** The release asset name of the executable for `target`. */
export function engineAsset(version: string, target: string): string {
  return `tripwire-engine-${version}-${target}`;
}

/** The commands that put a release where `tripwire start` looks for it. */
export function installInstructions(
  pin: EnginePin,
  home: string,
  target: string,
) {
  const dir = engineInstallDir(home, pin.version);
  const asset = engineAsset(pin.version, target);
  const lines = [
    `Put engine ${pin.version} in ${dir}:`,
    "",
    `  mkdir -p ${dir}`,
    ...["SHA256SUMS", "SHA256SUMS.minisig", asset].map(
      (name) =>
        `  curl -fL -o ${join(dir, name)} ${pin.releases
          .replace("{version}", pin.version)
          .replace("{asset}", name)}`,
    ),
    `  mv ${join(dir, asset)} ${join(dir, "tripwire-engine")}`,
    `  chmod +x ${join(dir, "tripwire-engine")}`,
  ];
  // A private release repository answers plain downloads with 404; the
  // GitHub CLI fetches the same files with the user's own login.
  const github =
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/{]*)\{version\}\//.exec(
      pin.releases,
    );
  if (github) {
    lines.push(
      "",
      "Or, with the GitHub CLI (also when the release repository is private):",
      "",
      `  gh release download ${github[2]}${pin.version} -R ${github[1]} -D ${dir} -p SHA256SUMS -p SHA256SUMS.minisig -p ${asset}`,
      `  mv ${join(dir, asset)} ${join(dir, "tripwire-engine")} && chmod +x ${join(dir, "tripwire-engine")}`,
    );
  }
  return lines.join("\n");
}

/**
 * Verify a minisign signature: the key id matches, the Ed25519 signature
 * over the file (BLAKE2b-512 prehashed for algorithm `ED`) holds, and the
 * global signature over the signature and its trusted comment holds.
 * Returns the trusted comment.
 */
export function verifyMinisign(
  file: Buffer,
  signature: string,
  publicKey: string,
): string {
  const key = Buffer.from(publicKey.trim(), "base64");
  if (key.length !== 42 || key.subarray(0, 2).toString() !== "Ed") {
    throw new EngineReleaseError(
      "The pinned public key is not a minisign key.",
    );
  }
  const lines = signature.split(/\r?\n/);
  const sig = Buffer.from(lines[1] ?? "", "base64");
  const trusted = /^trusted comment: (.*)$/.exec(lines[2] ?? "")?.[1];
  const global = Buffer.from(lines[3] ?? "", "base64");
  if (sig.length !== 74 || trusted === undefined || global.length !== 64) {
    throw new EngineReleaseError(
      "SHA256SUMS.minisig is not a minisign signature.",
    );
  }
  if (!sig.subarray(2, 10).equals(key.subarray(2, 10))) {
    throw new EngineReleaseError(
      "SHA256SUMS is signed with a different key than the one this application trusts.",
    );
  }
  const algorithm = sig.subarray(0, 2).toString();
  if (algorithm !== "ED" && algorithm !== "Ed") {
    throw new EngineReleaseError(`Unknown minisign algorithm "${algorithm}".`);
  }
  const ed25519 = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      key.subarray(10),
    ]),
    format: "der",
    type: "spki",
  });
  const signed =
    algorithm === "ED" ? createHash("blake2b512").update(file).digest() : file;
  const body = sig.subarray(10);
  if (!verify(null, signed, ed25519, body)) {
    throw new EngineReleaseError(
      "The signature on SHA256SUMS does not verify.",
    );
  }
  if (
    !verify(null, Buffer.concat([body, Buffer.from(trusted)]), ed25519, global)
  ) {
    throw new EngineReleaseError(
      "The trusted comment on SHA256SUMS does not verify.",
    );
  }
  return trusted;
}

/** The digest `SHA256SUMS` lists for `asset`. */
export function listedDigest(sums: string, asset: string): string {
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match && match[2] === asset) return match[1]!;
  }
  throw new EngineReleaseError(`SHA256SUMS does not list ${asset}.`);
}

export interface InstalledEngine {
  version: string;
  binary: string;
}

/**
 * The pinned release as installed under `home`, checked: signature,
 * checksum, then the version it reports. Refuses with what to do when it
 * is missing or does not check out.
 */
export async function verifiedEngine(options: {
  home: string;
  pin: EnginePin;
  target?: string;
}): Promise<InstalledEngine> {
  const { home, pin } = options;
  const target = options.target ?? engineTarget();
  const dir = engineInstallDir(home, pin.version);
  const binary = join(dir, "tripwire-engine");

  const [sums, signature] = await Promise.all([
    readFile(join(dir, "SHA256SUMS")).catch(() => null),
    readFile(join(dir, "SHA256SUMS.minisig"), "utf8").catch(() => null),
  ]);
  const present = await readFile(binary).then(
    () => true,
    () => false,
  );
  if (!sums || !signature || !present) {
    throw new EngineReleaseError(
      `Engine ${pin.version} is not installed.\n\n${installInstructions(pin, home, target)}`,
    );
  }

  verifyMinisign(sums, signature, pin.publicKey);
  const want = listedDigest(sums.toString(), engineAsset(pin.version, target));
  const have = await sha256(binary);
  if (have !== want) {
    throw new EngineReleaseError(
      `${binary} does not match its SHA256SUMS line: it is not the ${pin.version} release. Fetch it again.`,
    );
  }
  const reported = await versionOf(binary);
  if (reported !== pin.version) {
    throw new EngineReleaseError(
      `${binary} reports version "${reported}", not ${pin.version}.`,
    );
  }
  return { version: pin.version, binary };
}

function sha256(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("error", fail)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => done(hash.digest("hex")));
  });
}

function versionOf(binary: string): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(binary, ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: process.env.PATH },
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.once("error", (error) =>
      fail(new EngineReleaseError(`${binary} cannot run: ${error.message}`)),
    );
    child.once("close", () => done(out.trim()));
  });
}
