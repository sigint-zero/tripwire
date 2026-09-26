import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { maskUrls } from "../config";

/**
 * `TRIPWIRE_HOME/logs/engine.log` (`ENGINE.md`, Logs): the engine's
 * output line by line, and the supervisor's own lines prefixed
 * `[tripwire]`. Rotated at 10 MB, five files kept; the directory is 0700
 * and the files 0600. The last lines are kept in memory for the API.
 */
export class EngineLog {
  readonly path: string;
  readonly #maxBytes: number;
  readonly #keep: number;
  readonly #tail: string[] = [];
  readonly #tailSize: number;
  #fd: number | null = null;
  #size = 0;

  constructor(
    path: string,
    options: { maxBytes?: number; keep?: number; tail?: number } = {},
  ) {
    this.path = path;
    this.#maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    this.#keep = options.keep ?? 5;
    this.#tailSize = options.tail ?? 1000;
  }

  /** A line of the engine's own output, without its terminal colours. */
  engine(line: string) {
    // eslint-disable-next-line no-control-regex
    this.#write(line.replace(/\x1b\[[0-9;]*m/g, ""));
  }

  /** A line of the supervisor's; URLs in it are masked. */
  tripwire(line: string) {
    this.#write(`[tripwire] ${new Date().toISOString()} ${maskUrls(line)}`);
  }

  /** The last `n` lines, oldest first. */
  lines(n = 200): string[] {
    return this.#tail.slice(-Math.max(0, Math.min(n, this.#tailSize)));
  }

  /** The lines written since the mark, for an engine's startup error. */
  mark(): number {
    return this.#written;
  }

  since(mark: number): string[] {
    const count = Math.min(this.#written - mark, this.#tail.length);
    return count > 0 ? this.#tail.slice(-count) : [];
  }

  #written = 0;

  #write(line: string) {
    this.#tail.push(line);
    if (this.#tail.length > this.#tailSize) this.#tail.shift();
    this.#written++;
    try {
      const data = `${line}\n`;
      const bytes = Buffer.byteLength(data);
      // Rotated before the line that would cross the size, so the current
      // file always exists once anything is written.
      this.#open();
      if (this.#size > 0 && this.#size + bytes > this.#maxBytes) {
        this.#rotate();
      }
      writeSync(this.#open(), data);
      this.#size += bytes;
    } catch {
      // A log that cannot be written must not stop the engine.
    }
  }

  #open(): number {
    if (this.#fd !== null) return this.#fd;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.#fd = openSync(this.path, "a", 0o600);
    this.#size = fstatSync(this.#fd).size;
    return this.#fd;
  }

  #rotate() {
    this.close();
    // engine.log.4 falls off; the rest move up one.
    for (let i = this.#keep - 1; i >= 1; i--) {
      const from = i === 1 ? this.path : `${this.path}.${i - 1}`;
      if (existsSync(from)) renameSync(from, `${this.path}.${i}`);
    }
    this.#size = 0;
  }

  close() {
    if (this.#fd !== null) {
      closeSync(this.#fd);
      this.#fd = null;
    }
  }
}

/** The last lines of the log on disk, for the command line while no server runs. */
export function readLogTail(path: string, n: number): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-n);
}
