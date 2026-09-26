import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpTokens, TOKEN_PREFIX } from "./mcp-tokens";

let home: string;
let now: number;
let tokens: McpTokens;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "tripwire-tokens-"));
  now = Date.parse("2026-09-26T00:00:00Z");
  tokens = new McpTokens(home, () => now);
});
afterEach(() => rm(home, { recursive: true, force: true }));

describe("MCP tokens", () => {
  it("shows a token once and keeps only its hash", async () => {
    const { token, record } = await tokens.create({ label: "laptop agent" });
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(token.length).toBeGreaterThan(40);
    const file = await readFile(join(home, "mcp-tokens.json"), "utf8");
    expect(file).not.toContain(token);
    expect(file).toContain(record.tokenHash);
    expect((await stat(join(home, "mcp-tokens.json"))).mode & 0o777).toBe(
      0o600,
    );
  });

  it("accepts a current token and records its use", async () => {
    const { token, record } = await tokens.create({ label: "agent" });
    expect(await tokens.verify(token)).toMatchObject({ id: record.id });
    expect((await tokens.list())[0]?.lastUsedAt).toBe(
      new Date(now).toISOString(),
    );
    expect(await tokens.verify(`${token}x`)).toBeNull();
    expect(await tokens.verify("not a token")).toBeNull();
  });

  it("refuses a token after it expires or is revoked", async () => {
    const soon = await tokens.create({
      label: "short",
      expiresAt: new Date(now + 60_000),
    });
    const kept = await tokens.create({ label: "kept" });
    now += 61_000;
    expect(await tokens.verify(soon.token)).toBeNull();

    expect(await tokens.revoke("KEPT")).toBe(true);
    expect(await tokens.verify(kept.token)).toBeNull();
    expect(await tokens.revoke("kept")).toBe(false);
  });

  it("keeps labels unique, so a label names one token", async () => {
    await tokens.create({ label: "agent" });
    await expect(tokens.create({ label: "Agent" })).rejects.toMatchObject({
      code: "label_taken",
    });
    await expect(tokens.create({ label: " " })).rejects.toMatchObject({
      code: "invalid_label",
    });
  });

  it("is unaffected by a write that never finished", async () => {
    const { token } = await tokens.create({ label: "agent" });
    await writeFile(join(home, "mcp-tokens.json.abc123.tmp"), "{ torn");
    expect(await tokens.verify(token)).not.toBeNull();
  });
});
