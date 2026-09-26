import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  engineAsset,
  engineInstallDir,
  EngineReleaseError,
  engineTarget,
  listedDigest,
  verifiedEngine,
  verifyMinisign,
  type EnginePin,
  type InstalledEngine,
} from "./release";

/**
 * Installing the pinned release (`ENGINE.md`, Download and verify, and
 * Offline): the signed checksums first, then the executable streamed
 * through SHA-256, renamed into place only once it matches, then the same
 * check `tripwire start` makes. A verification failure is never retried;
 * a network failure is, three times.
 */

/** A failure that waiting and trying again may fix. */
export class EngineDownloadError extends EngineReleaseError {}

export interface InstallProgress {
  bytes: number;
  total: number | null;
}

const RETRIES = 3;

/** The release asset URL: `TRIPWIRE_ENGINE_RELEASES` replaces the pin's template. */
export function assetUrl(
  pin: EnginePin,
  asset: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (env.TRIPWIRE_ENGINE_RELEASES || pin.releases)
    .replace("{version}", pin.version)
    .replace("{asset}", asset);
}

/** Downloads and installs the pinned release, unless it is already installed and checks out. */
export async function installEngine(options: {
  home: string;
  pin: EnginePin;
  target?: string;
  env?: NodeJS.ProcessEnv;
  onProgress?: (progress: InstallProgress) => void;
  /** For tests: how long to wait between attempts. */
  retryDelayMs?: number;
}): Promise<InstalledEngine> {
  const { home, pin } = options;
  const target = options.target ?? engineTarget();
  const existing = await verifiedEngine({ home, pin, target }).catch(
    () => null,
  );
  if (existing) return existing;

  const env = options.env ?? process.env;
  const asset = engineAsset(pin.version, target);
  const fetched = await withRetries(options.retryDelayMs ?? 2_000, async () => {
    const sums = await download(assetUrl(pin, "SHA256SUMS", env));
    const signature = await download(assetUrl(pin, "SHA256SUMS.minisig", env));
    return { sums, signature: signature.toString("utf8") };
  });
  verifyMinisign(fetched.sums, fetched.signature, pin.publicKey);
  const want = listedDigest(fetched.sums.toString(), asset);

  const bin = join(home, "engine", "bin");
  await mkdir(bin, { recursive: true });
  const partial = join(bin, `.download-${randomBytes(6).toString("hex")}`);
  try {
    const have = await withRetries(options.retryDelayMs ?? 2_000, () =>
      streamTo(assetUrl(pin, asset, env), partial, options.onProgress),
    );
    if (have !== want) {
      throw new EngineReleaseError(
        `The downloaded ${asset} does not match its line in SHA256SUMS: it is not the ${pin.version} release. Nothing was installed.`,
      );
    }
    await place(home, pin, partial, fetched.sums, fetched.signature);
  } finally {
    await rm(partial, { force: true });
  }
  return verifiedEngine({ home, pin, target });
}

/**
 * Removes installed versions other than the pinned one and the one before
 * it, once the pinned one has reached ready.
 */
export async function pruneVersions(home: string, pin: EnginePin) {
  const bin = join(home, "engine", "bin");
  const versions = (await readdir(bin).catch(() => [] as string[])).filter(
    (name) => !name.startsWith(".") && name !== pin.version,
  );
  const older = versions
    .filter((v) => compareVersions(v, pin.version) < 0)
    .sort(compareVersions);
  const keep = older.at(-1);
  for (const version of versions) {
    if (version !== keep) {
      await rm(join(bin, version), { recursive: true, force: true });
    }
  }
}

/** The installed versions and whether each checks out, for `tripwire engine status`. */
export async function installedVersions(
  home: string,
  pin: EnginePin,
  target?: string,
): Promise<{ version: string; verified: boolean; problem: string | null }[]> {
  const bin = join(home, "engine", "bin");
  const versions = (await readdir(bin).catch(() => [] as string[]))
    .filter((name) => !name.startsWith("."))
    .sort(compareVersions);
  const out = [];
  for (const version of versions) {
    try {
      await verifiedEngine({ home, pin: { ...pin, version }, target });
      out.push({ version, verified: true, problem: null });
    } catch (error) {
      out.push({
        version,
        verified: false,
        problem:
          error instanceof Error
            ? error.message.split("\n")[0]!
            : String(error),
      });
    }
  }
  return out;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.localeCompare(b);
}

async function place(
  home: string,
  pin: EnginePin,
  partial: string,
  sums: Buffer,
  signature: string,
) {
  const dir = engineInstallDir(home, pin.version);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SHA256SUMS"), sums);
  await writeFile(join(dir, "SHA256SUMS.minisig"), signature);
  await chmod(partial, 0o755);
  await rename(partial, join(dir, "tripwire-engine"));
}

async function download(url: string): Promise<Buffer> {
  const response = await request(url);
  return Buffer.from(await response.arrayBuffer());
}

async function streamTo(
  url: string,
  path: string,
  onProgress?: (progress: InstallProgress) => void,
): Promise<string> {
  const response = await request(url);
  const length = Number(response.headers.get("content-length"));
  const total = Number.isFinite(length) && length > 0 ? length : null;
  const hash = createHash("sha256");
  let bytes = 0;
  onProgress?.({ bytes, total });
  const body = Readable.fromWeb(
    response.body as import("node:stream/web").ReadableStream,
  );
  body.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    bytes += chunk.length;
    onProgress?.({ bytes, total });
  });
  await pipeline(body, createWriteStream(path, { mode: 0o600 }));
  return hash.digest("hex");
}

async function request(url: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    throw new EngineDownloadError(
      `Cannot reach ${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status === 404) {
    // Not something waiting fixes: the file is not there to anonymous
    // requests, which is what a private release repository answers.
    throw new EngineReleaseError(
      `${new URL(url).pathname.split("/").pop()} was not found at ${new URL(url).host} (404). The release may not be published, or its repository is private.`,
    );
  }
  if (!response.ok || !response.body) {
    throw new EngineDownloadError(
      `${new URL(url).host} answered ${response.status} for ${new URL(url).pathname.split("/").pop()}.`,
    );
  }
  return response;
}

async function withRetries<T>(
  delayMs: number,
  attempt: () => Promise<T>,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i <= RETRIES; i++) {
    try {
      return await attempt();
    } catch (error) {
      last = error;
      if (!(error instanceof EngineDownloadError)) break;
      if (i < RETRIES) {
        await new Promise((done) => setTimeout(done, delayMs * 2 ** i));
      }
    }
  }
  throw last;
}
