import type {
  EngineHealth,
  EngineInfo,
  EngineState,
  EngineStatus,
} from "@tripwire/shared";
import type { EngineEvents, EngineListener } from "../events/types";
import type { EngineSupervisor, SupervisorPhase } from "./supervisor";
import {
  headOf,
  type CursorRow,
  type EngineCommands,
  type EngineHealth as HealthAnswer,
  type EngineReads,
} from "./types";

/** How often the engine is asked, and how long an answer may take. */
const POLL_MS = 5_000;
const STARTING_POLL_MS = 1_000;
const ANSWER_MS = 5_000;
/** Unanswered this long, the engine counts as not answering. */
const UNRESPONSIVE_MS = 60_000;

/**
 * Whether the engine is watching, for `GET /engine` and the health strip.
 * It asks the engine's health in the background, so the answer is ready
 * even while the engine is not; then the head and cursors come from the
 * `engine_status` view, which outlives the process. State changes reach
 * listeners as `health` events. The stand-in always answers, and is asked
 * on demand. When the application supervises the engine, the supervisor
 * says what the process is doing until it runs, and health says the rest.
 */
export class EngineMonitor implements EngineEvents {
  readonly #commands: EngineCommands;
  readonly #reads: EngineReads;
  readonly #runner: "supervised" | "attached" | "stand-in";
  readonly #supervisor: EngineSupervisor | null;
  readonly #clock: () => number;
  readonly #listeners = new Set<EngineListener>();
  /** What health says, while the process runs. */
  #health: EngineState;
  #state: EngineState;
  #since: number;
  #answer: HealthAnswer | null = null;
  #answeredAt: number;
  #problem: EngineStatus["problem"] = null;
  #wake: (() => void) | null = null;

  constructor(
    commands: EngineCommands,
    reads: EngineReads,
    runner: "supervised" | "attached" | "stand-in",
    clock: () => number = Date.now,
    supervisor: EngineSupervisor | null = null,
  ) {
    this.#commands = commands;
    this.#reads = reads;
    this.#runner = runner;
    this.#supervisor = supervisor;
    this.#clock = clock;
    this.#health = runner === "stand-in" ? "stand-in" : "starting";
    this.#state = this.#health;
    this.#since = clock();
    this.#answeredAt = clock();
    supervisor?.listen({
      phase: (phase) => {
        if (phase === "running") {
          // A new process: nothing is known of it yet.
          this.#answer = null;
          this.#answeredAt = this.#clock();
          this.#health = "starting";
          this.#problem = null;
          this.#wake?.();
        }
        this.#settle();
      },
    });
    if (supervisor) this.#state = fromPhase(supervisor.phase, this.#health);
  }

  /** Whether the engine is protecting: ready or degraded. */
  get watching(): boolean {
    return this.#state === "ready" || this.#state === "degraded";
  }

  /** Asks until the returned function is called; nothing to do for the stand-in. */
  start(): () => void {
    if (this.#runner === "stand-in") return () => {};
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    const next = () => {
      if (stopped) return;
      timer = setTimeout(
        () => void this.poll().finally(next),
        this.#state === "starting" ? STARTING_POLL_MS : POLL_MS,
      );
      timer.unref();
    };
    // A new process is asked at once, not at the next tick.
    this.#wake = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void this.poll().finally(next), 200);
      timer.unref();
    };
    void this.poll().finally(next);
    return () => {
      stopped = true;
      this.#wake = null;
      clearTimeout(timer);
    };
  }

  /** Asks the engine once. */
  async poll(): Promise<void> {
    // Nothing runs to ask while the supervisor installs, waits or has failed.
    if (this.#supervisor && this.#supervisor.phase !== "running") return;
    let timer: NodeJS.Timeout | undefined;
    try {
      const answer = await Promise.race([
        this.#commands.health(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("no answer in 5 seconds")),
            ANSWER_MS,
          );
        }),
      ]);
      this.#answer = answer;
      this.#answeredAt = this.#clock();
      // What degrades it, in the engine's own words.
      this.#problem = answer.cause
        ? { code: "degraded", message: answer.cause }
        : null;
      this.#health = this.#runner === "stand-in" ? "stand-in" : answer.status;
      this.#settle();
      if (answer.status === "ready") this.#supervisor?.ready();
    } catch (error) {
      this.#answer = null;
      const silent = this.#clock() - this.#answeredAt;
      if (silent >= UNRESPONSIVE_MS) {
        this.#problem = {
          code: "unresponsive",
          message: error instanceof Error ? error.message : String(error),
        };
        this.#health = "unresponsive";
        this.#settle();
      }
      // At 120 seconds the supervisor kills it and starts another.
      this.#supervisor?.unanswered(silent);
    } finally {
      clearTimeout(timer);
    }
  }

  async status(info: EngineInfo): Promise<EngineStatus> {
    if (this.#runner === "stand-in") await this.poll();
    const answer = this.#answer;
    const cursors = answer ? null : await this.#cursors();
    const supervised = this.#supervisor?.report();
    const running = !this.#supervisor || this.#supervisor.phase === "running";
    return {
      ...info,
      state: this.#state,
      since: new Date(this.#since).toISOString(),
      runner: this.#runner,
      version: answer?.version ?? cursors?.[0]?.engine_version ?? null,
      pinnedVersion: supervised?.pinnedVersion ?? null,
      install: supervised?.install ?? null,
      health: answer
        ? fromAnswer(answer, this.#clock())
        : this.#fromCursors(cursors),
      restarts: supervised?.restarts ?? { last10Minutes: 0, total: 0 },
      lastExit: supervised?.lastExit ?? null,
      // While the process is not running, the supervisor knows why.
      problem: running
        ? (this.#problem ?? supervised?.problem ?? null)
        : (supervised?.problem ?? null),
    };
  }

  listen(listener: EngineListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The state as people see it: the supervisor's until the process runs, then health's. */
  #settle() {
    this.#enter(
      this.#supervisor
        ? fromPhase(this.#supervisor.phase, this.#health)
        : this.#health,
    );
  }

  #enter(state: EngineState) {
    if (state === this.#state) return;
    this.#state = state;
    this.#since = this.#clock();
    for (const l of this.#listeners) {
      l.event({ event: "health", data: { status: state } });
    }
  }

  /** What the engine last recorded, or nothing before its views exist. */
  async #cursors(): Promise<CursorRow[] | null> {
    try {
      return await this.#reads.engineStatus();
    } catch {
      return null;
    }
  }

  #fromCursors(rows: CursorRow[] | null): EngineHealth | null {
    if (!rows?.length) return null;
    const ingest = rows.find((r) => r.cursor === "ingest") ?? rows[0]!;
    const now = this.#clock();
    const at = (r: CursorRow) => new Date(r.updated_at).getTime();
    return {
      head: Number(ingest.block_number),
      headTime: new Date(at(ingest)).toISOString(),
      lagBlocks: null,
      rpc: null,
      controller: null,
      keys: null,
      cursors: rows.map((r) => ({
        name: r.cursor,
        block: Number(r.block_number),
        ageSeconds: Math.max(0, Math.round((now - at(r)) / 1000)),
      })),
    };
  }
}

/**
 * The engine's answer as the strip reads it. The head is the last block
 * evaluated, seen when the ingest cursor last moved; lag is the node's
 * head beyond the ingest cursor.
 */
function fromAnswer(answer: HealthAnswer, now: number): EngineHealth {
  const cursors = answer.cursors.map((c) => ({
    name: c.name,
    block: c.block_number,
    ageSeconds: c.age_seconds,
  }));
  const ingest = cursors.find((c) => c.name === "ingest");
  return {
    head: headOf(answer),
    headTime: ingest
      ? new Date(now - ingest.ageSeconds * 1000).toISOString()
      : null,
    lagBlocks:
      answer.observed_head !== null && ingest
        ? Math.max(0, answer.observed_head - ingest.block)
        : null,
    rpc: answer.rpc.state,
    cursors,
    controller: answer.controller
      ? {
          address: answer.controller.address,
          mirroredBlock: answer.controller.mirrored_block ?? null,
        }
      : null,
    keys: answer.keys ?? null,
  };
}

function fromPhase(phase: SupervisorPhase, health: EngineState): EngineState {
  return phase === "running" ? health : phase;
}
