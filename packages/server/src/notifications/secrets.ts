import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "../auth/files";

// Channel URLs and tokens are credentials, so they stay out of the
// database: one file beside the account files, keyed by channel id. A
// value may be `env:NAME`, read from the server's environment at send time.

type Stored = Record<string, Record<string, string>>;

export class ChannelSecrets {
  readonly #path: string;
  /** Writes one at a time, so two changes never overwrite each other. */
  #writing: Promise<unknown> = Promise.resolve();

  constructor(home: string) {
    this.#path = join(home, "channel-secrets.json");
  }

  /** The secrets a channel has set, by name, never their values. */
  async names(channelId: string): Promise<string[]> {
    const stored = await readJsonFile<Stored>(this.#path, {});
    return Object.keys(stored[channelId] ?? {}).sort();
  }

  async all(): Promise<Stored> {
    return readJsonFile<Stored>(this.#path, {});
  }

  /** A channel's secrets with `env:` references resolved; a missing variable is left out. */
  async resolved(
    channelId: string,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<Record<string, string>> {
    const stored = await readJsonFile<Stored>(this.#path, {});
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(stored[channelId] ?? {})) {
      const name = /^env:(.+)$/.exec(value)?.[1];
      const read = name ? env[name] : value;
      if (read) resolved[key] = read;
    }
    return resolved;
  }

  /** Sets the given secrets and keeps the rest. */
  set(channelId: string, secrets: Record<string, string>) {
    return this.#change((stored) => {
      stored[channelId] = { ...stored[channelId], ...secrets };
    });
  }

  remove(channelId: string) {
    return this.#change((stored) => {
      delete stored[channelId];
    });
  }

  #change(apply: (stored: Stored) => void): Promise<void> {
    const next = this.#writing.then(async () => {
      const stored = await readJsonFile<Stored>(this.#path, {});
      apply(stored);
      await writeJsonFile(this.#path, stored);
    });
    this.#writing = next.catch(() => {});
    return next;
  }
}
