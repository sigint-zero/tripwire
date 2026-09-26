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

/** A health answer as the engine gives it. */
const answer = (change: Partial<EngineHealth> = {}): EngineHealth => ({
  status: "ready",
  version: "1.4.2",
  chain_id: 1,
  observed_head: 1,
  evaluated_block: 1,
  cursors: [],
  rpc: {
    state: "ok",
    observed_head: 1,
    last_success_unix_ms: 0,
    last_failure_unix_ms: null,
  },
  ...change,
});

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

    state.answer = answer({
      status: "degraded",
      observed_head: 110,
      evaluated_block: 72,
      cursors: [
        {
          name: "ingest",
          block_number: 72,
          block_hash: "0x48",
          age_seconds: 400,
        },
      ],
      rpc: {
        state: "failing",
        observed_head: 110,
        last_success_unix_ms: 0,
        last_failure_unix_ms: 1,
      },
      cause: "RPC failing: connection refused",
    });
    now = 1_000_000;
    await monitor.poll();
    expect(await monitor.status(info)).toMatchObject({
      state: "degraded",
      since: new Date(1_000_000).toISOString(),
      runner: "attached",
      version: "1.4.2",
      health: {
        head: 72,
        headTime: new Date(600_000).toISOString(),
        lagBlocks: 38,
        rpc: "failing",
      },
      // The engine names what degrades it.
      problem: { code: "degraded", message: "RPC failing: connection refused" },
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
    state.answer = answer();
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
    state.answer = answer({ evaluated_block: 5 });
    const monitor = new EngineMonitor(commands, reads, "stand-in");
    expect(await monitor.status({ ...info, simulated: true })).toMatchObject({
      state: "stand-in",
      runner: "stand-in",
      health: { head: 5 },
    });
  });
});
