import { describe, expect, it } from "vitest";
import type { EngineEvent } from "../events/types";
import { EngineMonitor } from "./monitor";
import type {
  CursorRow,
  EngineCommands,
  EngineHealth,
  EngineReads,
} from "./types";

const info = { chainId: 1, responseMode: "notify", simulated: false } as const;

/** An engine whose health answers what `answer` holds, or fails while it is null. */
function engine(cursors: CursorRow[] = []) {
  const state: { answer: EngineHealth | null } = { answer: null };
  const commands = {
    health: () =>
      state.answer
        ? Promise.resolve(state.answer)
        : Promise.reject(new Error("The engine is not answering")),
  } as EngineCommands;
  const reads = {
    engineStatus: () => Promise.resolve(cursors),
  } as EngineReads;
  return { state, commands, reads };
}

describe("the engine monitor", () => {
  it("starts as starting, then takes the engine's own word", async () => {
    let now = 0;
    const { state, commands, reads } = engine();
    const monitor = new EngineMonitor(commands, reads, "attached", () => now);
    expect((await monitor.status(info)).state).toBe("starting");

    state.answer = {
      status: "degraded",
      version: "1.4.2",
      chain_id: 1,
      head: 110,
      head_time: "2026-09-26T09:20:11.000Z",
      rpc: "retrying",
      cursors: [{ name: "ingest", block_number: 72, age_seconds: 400 }],
    };
    now = 1_000;
    await monitor.poll();
    expect(await monitor.status(info)).toMatchObject({
      state: "degraded",
      since: new Date(1_000).toISOString(),
      runner: "attached",
      version: "1.4.2",
      health: {
        head: 110,
        headTime: "2026-09-26T09:20:11.000Z",
        lagBlocks: 38,
        rpc: "retrying",
      },
      problem: null,
    });
  });

  it("says not answering after a minute of silence, from what the views hold", async () => {
    let now = 0;
    const { state, commands, reads } = engine([
      {
        cursor: "ingest",
        block_number: "21004512",
        updated_at: new Date(10_000),
        engine_version: "1.4.2",
      },
    ]);
    const monitor = new EngineMonitor(commands, reads, "attached", () => now);
    const heard: EngineEvent[] = [];
    monitor.listen({ event: (e) => heard.push(e), resync: () => {} });
    state.answer = { status: "ready", version: "1.4.2", chain_id: 1, head: 1 };
    await monitor.poll();
    state.answer = null;

    now = 59_000;
    await monitor.poll();
    expect((await monitor.status(info)).state).toBe("ready");

    now = 70_000;
    await monitor.poll();
    expect(await monitor.status(info)).toMatchObject({
      state: "unresponsive",
      version: "1.4.2",
      health: {
        head: 21004512,
        headTime: new Date(10_000).toISOString(),
        lagBlocks: null,
        rpc: null,
        cursors: [{ name: "ingest", block: 21004512, ageSeconds: 60 }],
      },
      problem: { code: "unresponsive" },
    });
    expect(heard.map((e) => e.data)).toEqual([
      { status: "ready" },
      { status: "unresponsive" },
    ]);
  });

  it("calls the stand-in what it is, whatever it answers", async () => {
    const { state, commands, reads } = engine();
    state.answer = {
      status: "ready",
      version: "stand-in",
      chain_id: 1,
      head: 5,
    };
    const monitor = new EngineMonitor(commands, reads, "stand-in");
    expect(await monitor.status({ ...info, simulated: true })).toMatchObject({
      state: "stand-in",
      runner: "stand-in",
      health: { head: 5 },
    });
  });
});
