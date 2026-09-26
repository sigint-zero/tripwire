import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "./files";

// Dashboard sessions. A session is 32 random bytes handed to the browser
// in a cookie; the server keeps only its SHA-256, with who opened it,
// when and from where. The file is the server's alone: loaded at start,
// held in memory, flushed on every change.

/** Sessions end this long after login, however busy. */
export const SESSION_MAX_MS = 24 * 3_600_000;
/** How often a session's last-seen time is written back, at most. */
const LAST_SEEN_EVERY_MS = 5 * 60_000;

export interface Session {
  id: string;
  tokenHash: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  address: string;
  userAgent: string;
}

interface SessionFile {
  version: 1;
  sessions: Session[];
}

const hashOf = (token: string) =>
  `sha256:${createHash("sha256").update(token).digest("hex")}`;

export class Sessions {
  readonly #path: string;
  readonly #clock: () => number;
  readonly #byHash = new Map<string, Session>();
  #writing: Promise<unknown> = Promise.resolve();
  #pruner: NodeJS.Timeout | null = null;

  private constructor(path: string, clock: () => number) {
    this.#path = path;
    this.#clock = clock;
  }

  /** Loads `sessions.json`, dropping expired sessions, and prunes hourly. */
  static async open(
    home: string,
    clock: () => number = Date.now,
  ): Promise<Sessions> {
    const sessions = new Sessions(join(home, "sessions.json"), clock);
    const file = await readJsonFile<SessionFile>(sessions.#path, {
      version: 1,
      sessions: [],
    });
    for (const s of file.sessions) sessions.#byHash.set(s.tokenHash, s);
    await sessions.prune();
    sessions.#pruner = setInterval(() => void sessions.prune(), 3_600_000);
    sessions.#pruner.unref();
    return sessions;
  }

  expiresAt(session: Session): Date {
    return new Date(Date.parse(session.createdAt) + SESSION_MAX_MS);
  }

  #expired(session: Session) {
    return this.expiresAt(session).getTime() <= this.#clock();
  }

  /** Writes the current set; writes run one after another. */
  #flush() {
    const file: SessionFile = {
      version: 1,
      sessions: [...this.#byHash.values()],
    };
    this.#writing = this.#writing
      .catch(() => {})
      .then(() => writeJsonFile(this.#path, file));
    return this.#writing;
  }

  async prune() {
    let dropped = false;
    for (const [hash, s] of this.#byHash) {
      if (this.#expired(s)) {
        this.#byHash.delete(hash);
        dropped = true;
      }
    }
    if (dropped) await this.#flush();
  }

  async create(
    userId: string,
    client: { address: string; userAgent: string },
  ): Promise<{ token: string; session: Session }> {
    const token = randomBytes(32).toString("base64url");
    const now = new Date(this.#clock()).toISOString();
    const session: Session = {
      id: `s_${randomBytes(6).toString("hex")}`,
      tokenHash: hashOf(token),
      userId,
      createdAt: now,
      lastSeenAt: now,
      address: client.address,
      userAgent: client.userAgent.slice(0, 256),
    };
    this.#byHash.set(session.tokenHash, session);
    await this.#flush();
    return { token, session };
  }

  /** The session a token names, while it is current; notes it was seen. */
  find(token: string): Session | null {
    const session = this.#byHash.get(hashOf(token));
    if (!session) return null;
    if (this.#expired(session)) {
      this.#byHash.delete(session.tokenHash);
      void this.#flush();
      return null;
    }
    const now = this.#clock();
    if (now - Date.parse(session.lastSeenAt) >= LAST_SEEN_EVERY_MS) {
      session.lastSeenAt = new Date(now).toISOString();
      void this.#flush();
    }
    return session;
  }

  list(userId: string): Session[] {
    return [...this.#byHash.values()]
      .filter((s) => s.userId === userId && !this.#expired(s))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async revoke(id: string) {
    for (const [hash, s] of this.#byHash) {
      if (s.id === id) this.#byHash.delete(hash);
    }
    await this.#flush();
  }

  /** Ends every session of an account. */
  async revokeUser(userId: string) {
    for (const [hash, s] of this.#byHash) {
      if (s.userId === userId) this.#byHash.delete(hash);
    }
    await this.#flush();
  }

  async close() {
    if (this.#pruner) clearInterval(this.#pruner);
    await this.#writing.catch(() => {});
  }
}
