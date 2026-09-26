import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "./files";
import { DEFAULT_COST, hashPassword } from "./passwords";

// Local accounts, all equal, in `users.json` in the data directory. The
// file is re-read whenever it changes on disk, so `tripwire user` run
// beside a live server takes effect on the next request with no restart.

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
  /** Sessions opened before this are no longer valid. */
  passwordChangedAt: string;
  failedLogins: number;
  lastFailedLoginAt: string | null;
}

interface UserFile {
  version: 1;
  users: User[];
}

export class AccountError extends Error {
  constructor(
    readonly code:
      | "invalid_username"
      | "invalid_password"
      | "username_taken"
      | "last_account"
      | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "AccountError";
  }
}

/** Usernames compare case-insensitively, so they are kept in lower case. */
export function normalUsername(username: string): string {
  return username.trim().toLowerCase();
}

function checkUsername(username: string): string {
  const name = normalUsername(username);
  if (!/^[a-z0-9._-]{1,64}$/.test(name)) {
    throw new AccountError(
      "invalid_username",
      "A username is 1 to 64 characters: letters, digits, dots, dashes and underscores.",
    );
  }
  return name;
}

export function checkPassword(password: string) {
  if (password.length < 12 || password.length > 1024) {
    throw new AccountError(
      "invalid_password",
      "A password is 12 to 1024 characters.",
    );
  }
}

export class Users {
  readonly #path: string;
  readonly #cost: number;
  readonly #clock: () => number;
  #cache: { mtimeMs: number; file: UserFile } | null = null;

  /** `cost` is log2 of scrypt's N; it is lowered only in tests. */
  constructor(
    home: string,
    options: { cost?: number; clock?: () => number } = {},
  ) {
    this.#path = join(home, "users.json");
    this.#cost = options.cost ?? DEFAULT_COST;
    this.#clock = options.clock ?? Date.now;
  }

  get cost() {
    return this.#cost;
  }

  async #read(): Promise<UserFile> {
    const mtimeMs = await stat(this.#path).then(
      (s) => s.mtimeMs,
      () => -1,
    );
    if (this.#cache?.mtimeMs === mtimeMs) return this.#cache.file;
    const file = await readJsonFile<UserFile>(this.#path, {
      version: 1,
      users: [],
    });
    const version: unknown = file.version;
    if (version !== 1) {
      throw new Error(
        `${this.#path} has an unknown version: ${String(version)}`,
      );
    }
    this.#cache = { mtimeMs, file };
    return file;
  }

  async #change(apply: (file: UserFile) => void) {
    this.#cache = null;
    const file = structuredClone(await this.#read());
    apply(file);
    await writeJsonFile(this.#path, file);
    this.#cache = null;
  }

  async all(): Promise<User[]> {
    return (await this.#read()).users;
  }

  async find(username: string): Promise<User | null> {
    const name = normalUsername(username);
    return (await this.all()).find((u) => u.username === name) ?? null;
  }

  async byId(id: string): Promise<User | null> {
    return (await this.all()).find((u) => u.id === id) ?? null;
  }

  async add(username: string, password: string): Promise<User> {
    const name = checkUsername(username);
    checkPassword(password);
    if (await this.find(name)) {
      throw new AccountError("username_taken", `"${name}" is already taken.`);
    }
    const now = new Date(this.#clock()).toISOString();
    const user: User = {
      id: `u_${randomBytes(6).toString("hex")}`,
      username: name,
      passwordHash: await hashPassword(password, this.#cost),
      createdAt: now,
      passwordChangedAt: now,
      failedLogins: 0,
      lastFailedLoginAt: null,
    };
    await this.#change((file) => {
      if (file.users.some((u) => u.username === name)) {
        throw new AccountError("username_taken", `"${name}" is already taken.`);
      }
      file.users.push(user);
    });
    return user;
  }

  /**
   * Sets a new password. Every session opened before it ends; `rehash`
   * only upgrades the stored hash and leaves sessions alone.
   */
  async setPassword(id: string, password: string, rehash = false) {
    checkPassword(password);
    const passwordHash = await hashPassword(password, this.#cost);
    const now = new Date(this.#clock()).toISOString();
    await this.#change((file) => {
      const user = file.users.find((u) => u.id === id);
      if (!user) throw new AccountError("not_found", "No such account.");
      user.passwordHash = passwordHash;
      if (!rehash) user.passwordChangedAt = now;
    });
  }

  /** Removes an account; the last one cannot go. */
  async remove(id: string) {
    await this.#change((file) => {
      if (!file.users.some((u) => u.id === id)) {
        throw new AccountError("not_found", "No such account.");
      }
      if (file.users.length === 1) {
        throw new AccountError(
          "last_account",
          "The last account cannot be removed.",
        );
      }
      file.users = file.users.filter((u) => u.id !== id);
    });
  }

  async recordFailure(id: string) {
    const now = new Date(this.#clock()).toISOString();
    await this.#change((file) => {
      const user = file.users.find((u) => u.id === id);
      if (!user) return;
      user.failedLogins += 1;
      user.lastFailedLoginAt = now;
    });
  }

  async clearFailures(id: string) {
    const user = await this.byId(id);
    if (!user || (user.failedLogins === 0 && !user.lastFailedLoginAt)) return;
    await this.#change((file) => {
      const found = file.users.find((u) => u.id === id);
      if (!found) return;
      found.failedLogins = 0;
      found.lastFailedLoginAt = null;
    });
  }
}
