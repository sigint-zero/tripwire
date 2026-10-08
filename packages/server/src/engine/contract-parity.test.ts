import { rule } from "@tripwire/shared";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { testDatabase } from "../testing";
import {
  CONTRACT_FIXTURES,
  loadEngineContract,
  readPin,
  verifyContractFiles,
  type EngineContract,
} from "./contract-files";
import { ViewReads } from "./reads";
import { differences, shapeOf } from "./schema-shape";
import { ENGINE_OPERATIONS } from "./statuses";

// The application against the engine it pins: the rule mirror against the engine's schema and examples, every
// view read against views.json, every call against openapi.json. With
// TRIPWIRE_ENGINE_CONTRACT set, against an engine checkout instead.

let contract: EngineContract;

beforeAll(async () => {
  contract = await loadEngineContract();
});

describe("the pinned engine's contract files", () => {
  it("are the pinned release's, signed and unaltered", async () => {
    await verifyContractFiles(CONTRACT_FIXTURES, await readPin());
  });

  it("are refused when altered, or when they are another release's", async () => {
    const pin = await readPin();
    const copy = async () => {
      const dir = await mkdtemp(join(tmpdir(), "tripwire-contract-"));
      await cp(CONTRACT_FIXTURES, dir, { recursive: true });
      return dir;
    };
    const altered = await copy();
    await writeFile(join(altered, "views.json"), "{}");
    await expect(verifyContractFiles(altered, pin)).rejects.toThrow(
      "views.json",
    );
    const resigned = await copy();
    const sums = await readFile(join(resigned, "SHA256SUMS"), "utf8");
    await writeFile(join(resigned, "SHA256SUMS"), `${sums}\n`);
    await expect(verifyContractFiles(resigned, pin)).rejects.toThrow();
    await expect(
      verifyContractFiles(await copy(), { ...pin, version: "9.9.9" }),
    ).rejects.toThrow("not engine 9.9.9's");
    for (const dir of [altered, resigned]) {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the rule mirror", () => {
  it("accepts every example document the engine ships", () => {
    const refused: string[] = [];
    for (const [name, document] of contract.examples) {
      const parsed = rule.safeParse(document);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        refused.push(
          `${name}: ${first?.path.join("/") ?? ""} ${first?.message ?? ""}`,
        );
      }
    }
    expect(contract.examples.size).toBeGreaterThan(0);
    expect(refused).toEqual([]);
  });

  it("states the engine's rule language: types, null, enums and bounds", () => {
    const mirror = z.toJSONSchema(rule, {
      unrepresentable: "any",
      io: "input",
    });
    expect(
      differences(shapeOf(mirror as Json), shapeOf(contract.ruleSchema)),
    ).toEqual([]);
  });

  it("reads null as absent wherever the engine does", () => {
    // The engine reads a null optional field as absent and a null
    // required one as missing; the mirror must agree on every field of
    // every example.
    const mismatched: string[] = [];
    for (const [name, document] of contract.examples) {
      for (const path of fieldPaths(document)) {
        const nulled = withField(document, path, null);
        const removed = withField(document, path, undefined);
        const a = rule.safeParse(nulled).success;
        const b = rule.safeParse(removed).success;
        if (a !== b) {
          mismatched.push(
            `${name} ${path.join("/")}: null ${a ? "accepted" : "refused"}, absent ${b ? "accepted" : "refused"}`,
          );
        }
      }
    }
    expect(mismatched).toEqual([]);
  });
});

describe("the view reads", () => {
  let database: Awaited<ReturnType<typeof testDatabase>>;
  let reads: ViewReads;
  const SCHEMA = "contract_api_v1";

  beforeAll(async () => {
    database = await testDatabase();
    // Each view as an empty table with exactly the published columns, so
    // a read naming anything else fails.
    await database.pool.query(`CREATE SCHEMA ${SCHEMA}`);
    for (const view of contract.views.views) {
      const columns = view.columns
        .map((c) => `"${c.name}" ${c.type}`)
        .join(", ");
      await database.pool.query(
        `CREATE TABLE ${SCHEMA}.${view.view} (${columns})`,
      );
    }
    reads = new ViewReads(database.pool, SCHEMA);
  });

  afterAll(() => database.close());

  it("names only published views and columns", async () => {
    const day = new Date(Date.now() - 86_400_000);
    const now = new Date();
    const address = "0x00000000000000000000000000000000000000aa";
    const hash = `0x${"11".repeat(32)}`;
    const reads_: [string, () => Promise<unknown>][] = [
      ["contracts", () => reads.contracts()],
      ["contract", () => reads.contract(address)],
      ["rules", () => reads.rules({ contractId: "1" })],
      ["rule", () => reads.rule("1")],
      [
        "violations",
        () =>
          reads.violations({
            ids: ["1"],
            ruleId: "1",
            kind: "tripped",
            contractId: "1",
            open: true,
            before: "9",
            limit: 5,
          }),
      ],
      ["violation", () => reads.violation("1")],
      [
        "responses",
        () =>
          reads.responses({
            statuses: ["submitted"],
            contractAddress: address,
            before: "9",
            limit: 5,
          }),
      ],
      ["response", () => reads.response("1")],
      ["responseCounts", () => reads.responseCounts()],
      ["tripState", () => reads.tripState()],
      ["engineStatus", () => reads.engineStatus()],
      ["actions", () => reads.actions()],
      ["controllerTimes", () => reads.controllerTimes([hash])],
      ["operators", () => reads.operators()],
      ["registrations", () => reads.registrations()],
      ["ruleActivity", () => reads.ruleActivity(["1"])],
      ["ruleSeries", () => reads.ruleSeries(["1"])],
      ["seriesById", () => reads.seriesById("1")],
      ["newestPoints", () => reads.newestPoints(["1"])],
      ["countPoints", () => reads.countPoints("1", day, now)],
      ["points", () => reads.points("1", day, now, 10)],
      ["buckets", () => reads.buckets(["1"], day, now, 10)],
    ];
    const failed: string[] = [];
    for (const [name, read] of reads_) {
      await read().catch((error: unknown) =>
        failed.push(`${name}: ${(error as Error).message}`),
      );
    }
    expect(failed).toEqual([]);
  });
});

describe("the control interface calls", () => {
  it("lists every operation the application calls", async () => {
    expect(Object.keys(ENGINE_OPERATIONS).sort()).toEqual(
      (await calledOperations()).sort(),
    );
  });

  it("maps every status the engine documents", () => {
    const published = operationsOf(contract.openapi);
    const mismatched: string[] = [];
    for (const [operation, statuses] of Object.entries(ENGINE_OPERATIONS)) {
      const documented = published.get(normalise(operation));
      if (!documented) {
        mismatched.push(`${operation}: not in openapi.json`);
        continue;
      }
      const unmapped = documented.filter((status) => !(status in statuses));
      if (unmapped.length) {
        mismatched.push(`${operation}: ${unmapped.join(", ")} not mapped`);
      }
    }
    expect(mismatched).toEqual([]);
  });
});

/** The operations named in the application's engine calls. */
async function calledOperations(): Promise<string[]> {
  const http = await readFile(new URL("./http.ts", import.meta.url), "utf8");
  const found = new Set<string>();
  const call =
    /#call(?:<[^(]*>)?\(\s*"(GET|POST|PUT|PATCH|DELETE)",\s*([`"])(\/v1\/[^`"]*)\2/g;
  for (const [, method, , path] of http.matchAll(call)) {
    found.add(`${method} ${path!.replace(/\$\{[^}]*\}/g, (m) => paramOf(m))}`);
  }
  // The two that are fetched directly: health polls and the event stream.
  found.add("GET /v1/health");
  found.add("GET /v1/events");
  return [...found];
}

function paramOf(template: string): string {
  if (/address/.test(template)) return "{address}";
  return "{id}";
}

/** `METHOD /path` → documented statuses, sorted; `{…}` kept by name. */
function operationsOf(openapi: EngineContract["openapi"]) {
  const out = new Map<string, string[]>();
  for (const [path, methods] of Object.entries(openapi.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const responses = (op as { responses?: Record<string, unknown> })
        .responses;
      if (!responses) continue;
      out.set(
        normalise(`${method.toUpperCase()} ${path}`),
        Object.keys(responses).sort(),
      );
    }
  }
  return out;
}

function normalise(operation: string): string {
  return operation.replace(/\{[^}]*\}/g, "{}");
}

type Json = Record<string, unknown>;

/** Every object field of a document, as paths. */
function fieldPaths(
  value: unknown,
  path: (string | number)[] = [],
): (string | number)[][] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => fieldPaths(v, [...path, i]));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, v]) => [
    [...path, key],
    ...fieldPaths(v, [...path, key]),
  ]);
}

/** A copy of `document` with the field at `path` set, or removed when undefined. */
function withField(
  document: unknown,
  path: (string | number)[],
  value: unknown,
): unknown {
  const copy = structuredClone(document) as Json;
  let node: Json = copy;
  for (const step of path.slice(0, -1)) node = node[step as string] as Json;
  const last = path[path.length - 1] as string;
  if (value === undefined) delete node[last];
  else node[last] = value;
  return copy;
}
