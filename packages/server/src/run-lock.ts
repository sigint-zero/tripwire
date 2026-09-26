import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { alive } from "./engine/launch";

/**
 * `TRIPWIRE_HOME/run.lock` (`ENGINE.md`, One engine only): created
 * exclusively with the server's pid, in both database modes. A lock whose
 * pid is gone is replaced; a live one stops the start.
 */

export class RunLockError extends Error {}

export async function takeRunLock(home: string): Promise<() => Promise<void>> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, "run.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      return () => rm(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number((await readFile(path, "utf8").catch(() => "")).trim());
      if (
        Number.isSafeInteger(pid) &&
        pid > 0 &&
        pid !== process.pid &&
        alive(pid)
      ) {
        throw new RunLockError(
          `Tripwire is already running as process ${pid}.`,
        );
      }
      // Left by a server that is gone.
      await rm(path, { force: true });
    }
  }
  throw new RunLockError(`Cannot take ${path}.`);
}

/** The pid holding the lock, when a server runs; for the command line. */
export async function runLockHolder(home: string): Promise<number | null> {
  const pid = Number(
    (await readFile(join(home, "run.lock"), "utf8").catch(() => "")).trim(),
  );
  return Number.isSafeInteger(pid) && pid > 0 && alive(pid) ? pid : null;
}
