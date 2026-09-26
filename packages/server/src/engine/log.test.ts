import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EngineLog, readLogTail } from "./log";

describe("EngineLog", () => {
  it("rotates at its size, keeping five files, 0600 in a 0700 directory", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "tripwire-log-")), "logs");
    const log = new EngineLog(join(dir, "engine.log"), { maxBytes: 100 });
    for (let i = 0; i < 40; i++) log.engine(`line ${i} ${"x".repeat(20)}`);
    log.close();
    expect((await readdir(dir)).sort()).toEqual([
      "engine.log",
      "engine.log.1",
      "engine.log.2",
      "engine.log.3",
      "engine.log.4",
    ]);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "engine.log"))).mode & 0o777).toBe(0o600);
    expect(readLogTail(join(dir, "engine.log.1"), 1)[0]).toMatch(/^line \d+/);
  });

  it("keeps the tail in memory, without colours, and masks URLs in its own lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tripwire-log-"));
    const log = new EngineLog(join(dir, "engine.log"), { tail: 3 });
    log.engine("\x1b[32m INFO\x1b[0m ready");
    log.tripwire("verify against https://eth.node.io/v2/secret-key failed");
    log.engine("a");
    log.engine("b");
    expect(log.lines(10)).toHaveLength(3);
    expect(log.lines(1)).toEqual(["b"]);
    log.close();
    const text = await readFile(join(dir, "engine.log"), "utf8");
    expect(text).toContain(" INFO ready");
    expect(text).not.toContain("\x1b[");
    expect(text).not.toContain("secret-key");
    expect(text).toContain("https://eth.node.io/…");
  });
});
