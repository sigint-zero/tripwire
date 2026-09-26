import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "./files";

// MCP tokens: an AI agent's whole identity. A token opens the MCP
// endpoint and nothing else. Only its SHA-256 is kept, so the file yields
// no usable credential; the token itself is shown once, when minted.
// The file is read fresh on every check, so a token minted or revoked
// from the command line takes effect on the agent's next request.

export const TOKEN_PREFIX = "twm_";

/** How often a token's last use is written back, at most. */
const LAST_USED_EVERY_MS = 5 * 60_000;

export interface McpToken {
  id: string;
  label: string;
  /** The account that minted it; null until accounts exist. */
  userId: string | null;
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

interface TokenFile {
  version: 1;
  tokens: McpToken[];
}

export class TokenError extends Error {
  constructor(
    readonly code: "invalid_label" | "label_taken" | "invalid_expiry",
    message: string,
  ) {
    super(message);
    this.name = "TokenError";
  }
}

const hashOf = (token: string) =>
  `sha256:${createHash("sha256").update(token).digest("hex")}`;

export class McpTokens {
  readonly #path: string;
  readonly #clock: () => number;

  /** Tokens kept in `mcp-tokens.json` in the data directory `home`. */
  constructor(home: string, clock: () => number = Date.now) {
    this.#path = join(home, "mcp-tokens.json");
    this.#clock = clock;
  }

  async #read(): Promise<TokenFile> {
    const file = await readJsonFile<TokenFile>(this.#path, {
      version: 1,
      tokens: [],
    });
    const version: unknown = file.version;
    if (version !== 1) {
      throw new Error(
        `${this.#path} has an unknown version: ${String(version)}`,
      );
    }
    return file;
  }

  /** Mints a token. The returned `token` is the only time it is seen. */
  async create(input: {
    label: string;
    expiresAt?: Date | null;
    userId?: string | null;
  }): Promise<{ token: string; record: McpToken }> {
    const label = input.label.trim();
    if (label.length < 1 || label.length > 64) {
      throw new TokenError("invalid_label", "A label is 1 to 64 characters.");
    }
    const now = this.#clock();
    if (input.expiresAt && input.expiresAt.getTime() <= now) {
      throw new TokenError("invalid_expiry", "The expiry is in the past.");
    }
    const file = await this.#read();
    if (
      file.tokens.some((t) => t.label.toLowerCase() === label.toLowerCase())
    ) {
      throw new TokenError(
        "label_taken",
        `A token is already labelled "${label}".`,
      );
    }
    const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const record: McpToken = {
      id: `t_${randomBytes(6).toString("hex")}`,
      label,
      userId: input.userId ?? null,
      tokenHash: hashOf(token),
      createdAt: new Date(now).toISOString(),
      lastUsedAt: null,
      expiresAt: input.expiresAt?.toISOString() ?? null,
    };
    file.tokens.push(record);
    await writeJsonFile(this.#path, file);
    return { token, record };
  }

  async list(): Promise<McpToken[]> {
    return (await this.#read()).tokens;
  }

  /** Revokes by id or label; false when neither names a token. */
  async revoke(idOrLabel: string): Promise<boolean> {
    const file = await this.#read();
    const key = idOrLabel.trim().toLowerCase();
    const kept = file.tokens.filter(
      (t) => t.id !== idOrLabel && t.label.toLowerCase() !== key,
    );
    if (kept.length === file.tokens.length) return false;
    await writeJsonFile(this.#path, { ...file, tokens: kept });
    return true;
  }

  /**
   * The token's record when it is current, else null. Comparison is a
   * lookup by hash: a guess must match 256 random bits.
   */
  async verify(token: string): Promise<McpToken | null> {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const file = await this.#read();
    const hash = hashOf(token);
    const record = file.tokens.find((t) => t.tokenHash === hash);
    if (!record) return null;
    const now = this.#clock();
    if (record.expiresAt && Date.parse(record.expiresAt) <= now) return null;
    const last = record.lastUsedAt ? Date.parse(record.lastUsedAt) : 0;
    if (now - last >= LAST_USED_EVERY_MS) {
      // Re-read, so a revocation written meanwhile is not undone.
      const fresh = await this.#read();
      const current = fresh.tokens.find((t) => t.id === record.id);
      if (!current) return null;
      current.lastUsedAt = new Date(now).toISOString();
      await writeJsonFile(this.#path, fresh);
    }
    return record;
  }
}
