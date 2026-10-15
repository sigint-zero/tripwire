import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listedDigest, verifyMinisign, type EnginePin } from "./release";

// The engine's published contract, as the pinned release ships it: the
// rule schema and examples, the views and the control interface, kept
// beside the pin in fixtures/contract with the release's signed
// SHA256SUMS. Before using them the tests verify the signature against
// the pinned key, each file against SHA256SUMS, and that SHA256SUMS is
// the pinned version's.
// TRIPWIRE_ENGINE_CONTRACT points the tests at an engine checkout
// instead, to prove an unreleased engine against the application; such
// files are never committed as fixtures.

export interface EngineContract {
  /** The verified release version, or `checkout` for an engine checkout. */
  version: string;
  ruleSchema: JsonSchema;
  views: ViewsFile;
  openapi: OpenApi;
  /** Every example document, by file name. */
  examples: Map<string, unknown>;
}

export interface JsonSchema {
  [key: string]: unknown;
}

export interface ViewsFile {
  schema: string;
  views: { view: string; columns: { name: string; type: string }[] }[];
}

export interface OpenApi {
  paths: Record<string, Record<string, unknown>>;
}

export const CONTRACT_FIXTURES = fileURLToPath(
  new URL("./fixtures/contract/", import.meta.url),
);
export const CONTRACT_FILES = [
  "rule.schema.json",
  "views.json",
  "openapi.json",
  "rule-examples.tar.gz",
];
const PIN = fileURLToPath(new URL("../../../cli/engine.json", import.meta.url));

export async function readPin(): Promise<EnginePin> {
  return JSON.parse(await readFile(PIN, "utf8")) as EnginePin;
}

/**
 * Check a directory of release files: SHA256SUMS signed by the pinned key,
 * listing the pinned version's engine, and every contract file matching
 * it. Throws on the first problem.
 */
export async function verifyContractFiles(
  dir: string,
  pin: EnginePin,
): Promise<void> {
  const sums = await readFile(join(dir, "SHA256SUMS"));
  verifyMinisign(
    sums,
    await readFile(join(dir, "SHA256SUMS.minisig"), "utf8"),
    pin.publicKey,
  );
  const listing = sums.toString("utf8");
  if (!listing.includes(`tripwire-engine-${pin.version}-`)) {
    throw new Error(
      `SHA256SUMS is not engine ${pin.version}'s: refresh the contract fixtures`,
    );
  }
  for (const file of CONTRACT_FILES) {
    const digest = createHash("sha256")
      .update(await readFile(join(dir, file)))
      .digest("hex");
    if (digest !== listedDigest(listing, file)) {
      throw new Error(`${file} does not match the release's SHA256SUMS`);
    }
  }
}

export async function loadEngineContract(
  env: NodeJS.ProcessEnv = process.env,
): Promise<EngineContract> {
  const json = async <T>(dir: string, name: string) =>
    JSON.parse(await readFile(join(dir, name), "utf8")) as T;
  const readExamples = async (dir: string) => {
    const examples = new Map<string, unknown>();
    for (const name of (await readdir(dir)).sort()) {
      if (name.endsWith(".json")) examples.set(name, await json(dir, name));
    }
    return examples;
  };

  const checkout = env.TRIPWIRE_ENGINE_CONTRACT;
  if (checkout) {
    const dir = join(checkout, "contract");
    return {
      version: "checkout",
      ruleSchema: await json<JsonSchema>(dir, "rule.schema.json"),
      views: await json<ViewsFile>(dir, "views.json"),
      openapi: await json<OpenApi>(dir, "openapi.json"),
      examples: await readExamples(
        join(checkout, "crates/rules/tests/corpus/valid"),
      ),
    };
  }

  const pin = await readPin();
  await verifyContractFiles(CONTRACT_FIXTURES, pin);
  const work = await mkdtemp(join(tmpdir(), "tripwire-examples-"));
  try {
    execFileSync("tar", [
      "-xzf",
      join(CONTRACT_FIXTURES, "rule-examples.tar.gz"),
      "-C",
      work,
    ]);
    return {
      version: pin.version,
      ruleSchema: await json<JsonSchema>(CONTRACT_FIXTURES, "rule.schema.json"),
      views: await json<ViewsFile>(CONTRACT_FIXTURES, "views.json"),
      openapi: await json<OpenApi>(CONTRACT_FIXTURES, "openapi.json"),
      examples: await readExamples(work),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
