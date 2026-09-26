import type { Rule } from "@tripwire/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../testing";
import { ViewReads } from "./reads";
import { STUB_VIEWS, StubEngine } from "./stub";
import { EngineError, EngineNotReady } from "./types";

// The stand-in answers the engine's commands, and the application reads it
// back through the same view queries it will use against the engine.

const token = "0x5555555555555555555555555555555555555555";
const read = (fn: string) => ({
  node: "view_call" as const,
  function: `${fn} returns (uint256)`,
  args: [],
});
const rule = (name: string, trip_when: Rule["trip_when"]): Rule => ({
  version: 1,
  name,
  contract: token,
  severity: "warning",
  when: "every_block",
  trip_when,
  on_trip: { action: "notify" },
});
const below = (value: string) => ({
  node: "compare" as const,
  op: "lt" as const,
  left: read("totalSupply()"),
  right: { node: "literal" as const, value },
});

let database: Awaited<ReturnType<typeof testDatabase>>;
let stub: StubEngine;
let reads: ViewReads;

beforeAll(async () => {
  database = await testDatabase();
  stub = await StubEngine.open(database.pool);
  reads = new ViewReads(database.pool, STUB_VIEWS);
  return () => database.close();
});

describe("the stand-in behind the views", () => {
  it("registers a contract and reads it back from the views", async () => {
    const row = await stub.registerContract({
      address: token.toUpperCase().replace("0X", "0x"),
      name: "Token",
      abi: [],
    });
    expect(row).toMatchObject({ address: token, name: "Token", rule_count: 0 });
    expect(await reads.contract(token)).toMatchObject({
      id: row.id,
      name: "Token",
      rule_count: 0,
      enabled_count: 0,
    });
    await expect(
      stub.registerContract({ address: token, name: "Again" }),
    ).rejects.toMatchObject({ status: 409, code: "already_registered" });
  });

  it("stores rules canonically with the engine's sentence", async () => {
    const created = await stub.createRule({
      document: rule("Floor", below("1")),
      enabled: true,
      origin: "app",
    });
    expect(created.description).toBe(
      "On every block, notify when totalSupply() falls below 1 (warning).",
    );
    const row = await reads.rule(created.id);
    expect(row).toMatchObject({
      contract_address: token,
      name: "Floor",
      severity: "warning",
      enabled: true,
      origin: "app",
      warming: false,
    });
    await expect(
      stub.createRule({
        document: rule("Floor", below("2")),
        enabled: true,
        origin: "app",
      }),
    ).rejects.toMatchObject({ status: 409, code: "name_taken" });
  });

  it("refuses an invalid document with every issue", async () => {
    const error = await stub
      .dryRun({ ...rule("", below("1")), severity: "loud" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).issues?.map((i) => i.path).sort()).toEqual([
      "/name",
      "/severity",
    ]);
  });

  it("switches a batch all together, or not at all", async () => {
    const second = await stub.createRule({
      document: rule("Cap", { ...below("1"), op: "gt" }),
      enabled: true,
      origin: "app",
    });
    const ids = (await reads.rules()).map((r) => r.id);
    await expect(
      stub.setRulesEnabled([...ids, "999999"], false),
    ).rejects.toMatchObject({ code: "not_found" });
    expect((await reads.rules()).every((r) => r.enabled)).toBe(true);

    await stub.setRulesEnabled(ids, false);
    expect((await reads.rules()).some((r) => r.enabled)).toBe(false);
    expect(await reads.contract(token)).toMatchObject({
      rule_count: 2,
      enabled_count: 0,
    });
    await stub.setRuleEnabled(second.id, true);
    expect((await reads.rule(second.id))?.enabled).toBe(true);
  });

  it("deletes a contract with its rules", async () => {
    await stub.deleteContract(token);
    expect(await reads.contract(token)).toBeNull();
    expect(await reads.rules()).toEqual([]);
  });

  it("reports views that do not exist yet as the engine not being ready", async () => {
    await expect(
      new ViewReads(database.pool).contracts(),
    ).rejects.toBeInstanceOf(EngineNotReady);
  });
});

describe("a dry run", () => {
  it("mirrors the condition with every value the evaluation saw", async () => {
    const dry = await stub.dryRun(rule("Floor", below("1")));
    expect(dry.evaluation.would_trip).toBe(false);
    expect(dry.evaluation.warming).toBe(false);
    expect(dry.evaluation.evidence).toMatchObject({
      node: "compare",
      value: false,
      left: { node: "view_call" },
      right: { node: "literal", value: "1" },
    });
    const left = (dry.evaluation.evidence as { left: { value: string } }).left;
    expect(left.value).toMatch(/^\d+$/);
  });

  it("marks branches past the deciding term unevaluated", async () => {
    const dry = await stub.dryRun(
      rule("Either", {
        node: "or",
        terms: [{ ...below("1"), op: "gt" }, below("1")],
      }),
    );
    expect(dry.evaluation.would_trip).toBe(true);
    const terms = (dry.evaluation.evidence as { terms: object[] }).terms;
    expect(terms[0]).toMatchObject({ value: true });
    expect(terms[1]).toMatchObject({ state: "unevaluated" });
  });

  it("reports a metric without history as warming, never tripping", async () => {
    const dry = await stub.dryRun(
      rule("Drop", {
        node: "compare",
        op: "gt",
        left: {
          node: "metric",
          metric: "windowed_drop",
          of: read("totalSupply()"),
          window: { seconds: 3600 },
        },
        right: { node: "literal", value: "10" },
      }),
    );
    expect(dry.evaluation).toMatchObject({ would_trip: false, warming: true });
    expect(dry.needs.warmup_seconds).toBe(3600);
  });
});
