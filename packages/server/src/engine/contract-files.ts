import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The engine's published contract, as the pinned release ships it: the
// rule schema and examples, the views and the control interface. Kept
// beside the pin in fixtures/contract (refreshed by
// scripts/engine-contract.mjs) so the parity tests need no network.
// TRIPWIRE_ENGINE_CONTRACT points them at an engine checkout instead, to
// prove an unreleased engine against the application.

export interface EngineContract {
  /** The release version, or `checkout` for a local engine checkout. */
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

const FIXTURES = fileURLToPath(
  new URL("./fixtures/contract/", import.meta.url),
);

export async function loadEngineContract(
  env: NodeJS.ProcessEnv = process.env,
): Promise<EngineContract> {
  const checkout = env.TRIPWIRE_ENGINE_CONTRACT;
  const contractDir = checkout ? join(checkout, "contract") : FIXTURES;
  const examplesDir = checkout
    ? join(checkout, "crates/rules/tests/corpus/valid")
    : join(FIXTURES, "rule-examples");
  const version = checkout
    ? "checkout"
    : (await readFile(join(FIXTURES, "VERSION"), "utf8")).trim();
  const json = async <T>(dir: string, name: string) =>
    JSON.parse(await readFile(join(dir, name), "utf8")) as T;
  const examples = new Map<string, unknown>();
  for (const name of (await readdir(examplesDir)).sort()) {
    if (name.endsWith(".json")) {
      examples.set(name, await json(examplesDir, name));
    }
  }
  return {
    version,
    ruleSchema: await json<JsonSchema>(contractDir, "rule.schema.json"),
    views: await json<ViewsFile>(contractDir, "views.json"),
    openapi: await json<OpenApi>(contractDir, "openapi.json"),
    examples,
  };
}
