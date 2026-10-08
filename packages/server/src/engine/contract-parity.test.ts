import { rule } from "@tripwire/shared";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { testDatabase } from "../testing";
import { loadEngineContract, type EngineContract } from "./contract-files";
import { ViewReads } from "./reads";
import { ENGINE_OPERATIONS } from "./statuses";

// The application against the engine it pins: the rule mirror against the engine's schema and examples, every
// view read against views.json, every call against openapi.json. With
// TRIPWIRE_ENGINE_CONTRACT set, against an engine checkout instead.

let contract: EngineContract;

beforeAll(async () => {
  contract = await loadEngineContract();
});

describe("the pinned engine's contract files", () => {
  it("are the pinned release's", async () => {
    if (contract.version === "checkout") return;
    const pin = JSON.parse(
      await readFile(
        new URL("../../../cli/engine.json", import.meta.url),
        "utf8",
      ),
    ) as { version: string };
    expect(contract.version).toBe(pin.version);
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

  it("has the engine schema's top-level fields", () => {
    const mirror = z.toJSONSchema(rule, { unrepresentable: "any" });
    expect(fieldsOf(mirror)).toEqual(fieldsOf(contract.ruleSchema));
  });

  it("has the engine schema's nodes, field for field", () => {
    const mirror = z.toJSONSchema(rule, { unrepresentable: "any" });
    expect(variantsOf(mirror, "node")).toEqual(
      variantsOf(contract.ruleSchema, "node"),
    );
  });

  it("has the engine schema's actions and their fields", () => {
    const mirror = z.toJSONSchema(rule, { unrepresentable: "any" });
    expect(actionsOf(mirror)).toEqual(actionsOf(contract.ruleSchema));
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

  it("maps every status the engine documents, and only those", () => {
    const published = operationsOf(contract.openapi);
    const mismatched: string[] = [];
    for (const [operation, statuses] of Object.entries(ENGINE_OPERATIONS)) {
      const documented = published.get(normalise(operation));
      if (!documented) {
        mismatched.push(`${operation}: not in openapi.json`);
        continue;
      }
      const mapped = Object.keys(statuses).sort();
      if (documented.join() !== mapped.join()) {
        mismatched.push(
          `${operation}: documents ${documented.join(", ")}, mapped ${mapped.join(", ")}`,
        );
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

type Node = Record<string, unknown>;

/** The top-level fields of the rule object. */
function fieldsOf(schema: Node): string[] {
  const root = resolveRoot(schema);
  return Object.keys((root.properties as Node | undefined) ?? {}).sort();
}

function resolveRoot(schema: Node): Node {
  if (schema.properties) return schema;
  const ref = schema.$ref as string | undefined;
  if (ref) return resolve(schema, ref);
  throw new Error("no root object in the schema");
}

function resolve(root: Node, ref: string): Node {
  let node: unknown = root;
  for (const part of ref.replace(/^#\//, "").split("/")) {
    node = (node as Node)[part];
  }
  return node as Node;
}

/** Every object in a schema, skipping `if` conditions (not shapes). */
function objectsOf(schema: Node): Node[] {
  const out: Node[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as Node;
    if (node.properties) out.push(node);
    for (const [key, child] of Object.entries(node)) {
      if (key !== "if") visit(child);
    }
  };
  visit(schema);
  return out;
}

/** Every object told apart by a constant `tag`, as `view_call` → its fields. */
function variantsOf(schema: Node, tag: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const node of objectsOf(schema)) {
    const properties = node.properties as Node;
    const constant = constOf(properties[tag]);
    if (constant !== undefined) out[constant] = Object.keys(properties).sort();
  }
  return out;
}

/**
 * The actions and every field any action takes. The engine states them as
 * one object with conditions, the mirror as one object per action.
 */
function actionsOf(schema: Node): { actions: string[]; fields: string[] } {
  const actions = new Set<string>();
  const fields = new Set<string>();
  for (const node of objectsOf(schema)) {
    const properties = node.properties as Node;
    const action = properties.action as Node | undefined;
    if (!action) continue;
    const values =
      constOf(action) !== undefined
        ? [constOf(action)!]
        : ((action.enum as string[] | undefined) ?? []);
    if (!values.length) continue;
    values.forEach((v) => actions.add(v));
    Object.keys(properties).forEach((f) => fields.add(f));
  }
  return { actions: [...actions].sort(), fields: [...fields].sort() };
}

function constOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const node = value as Node;
  if (typeof node.const === "string") return node.const;
  const options = node.enum as unknown[] | undefined;
  if (options?.length === 1 && typeof options[0] === "string") {
    return options[0];
  }
  return undefined;
}
