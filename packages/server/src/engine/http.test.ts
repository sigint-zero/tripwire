import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpEngine } from "./http";
import { EngineError } from "./types";

// The client for the engine's control interface, against a fake that
// records each request and answers as scripted.

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

let server: Server;
let base: string;
let seen: Seen[] = [];
let answer: { status: number; body?: unknown } = { status: 200, body: {} };

async function bodyOf(request: IncomingMessage) {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return text ? (JSON.parse(text) as unknown) : undefined;
}

beforeAll(async () => {
  server = createServer((request, response) => {
    void bodyOf(request).then((body) => {
      seen.push({
        method: request.method!,
        url: request.url!,
        authorization: request.headers.authorization,
        body,
      });
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(
        answer.body === undefined ? "" : JSON.stringify(answer.body),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  seen = [];
  answer = { status: 200, body: {} };
});

const engine = () => new HttpEngine({ url: `${base}/`, secret: "s3cret\n" });

describe("HttpEngine", () => {
  it("sends each command to its M6 path with the interface secret", async () => {
    const e = engine();
    await e.registerContract({ address: "0xabc", name: "Vault" });
    await e.setRulesEnabled(["4", "7"], false);
    await e.setRuleEnabled("4", true);
    await e.dryRun({ version: 1 });
    await e.deleteRule("7");
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "POST /v1/contracts",
      "POST /v1/rules/enabled",
      "PATCH /v1/rules/4",
      "POST /v1/rules/dry-run",
      "DELETE /v1/rules/7",
    ]);
    expect(seen.every((s) => s.authorization === "Bearer s3cret")).toBe(true);
    expect(seen[1]?.body).toEqual({ ids: ["4", "7"], enabled: false });
    expect(seen[3]?.body).toEqual({ document: { version: 1 } });
  });

  it("sends nothing for an empty batch", async () => {
    await engine().setRulesEnabled([], true);
    expect(seen).toEqual([]);
  });

  it("carries a refusal's status, code and issues", async () => {
    answer = {
      status: 400,
      body: {
        error: { code: "invalid_rule", message: "Invalid rule." },
        issues: [{ code: "required", message: "is required", path: "/name" }],
      },
    };
    const error = await engine()
      .dryRun({})
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({
      status: 400,
      code: "invalid_rule",
      issues: [{ path: "/name" }],
    });
  });

  it("names an engine that does not answer", async () => {
    const gone = new HttpEngine({ url: "http://127.0.0.1:1", secret: "x" });
    await expect(gone.health()).rejects.toMatchObject({
      status: 503,
      code: "engine_unreachable",
    });
  });

  it("refuses a rule id that is not a number without calling", async () => {
    await expect(engine().deleteRule("../contracts")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(seen).toEqual([]);
  });
});
