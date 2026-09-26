import { McpTokens } from "./mcp-tokens";
import { hashPassword } from "./passwords";
import { Sessions, type Session } from "./sessions";
import { Users } from "./users";

// Who is talking to the server. Accounts, sessions and MCP tokens live in
// files in the data directory, never the database, so a person can log in
// to see that the engine or the database is down.

export interface Account {
  id: string;
  username: string;
}

export class Auth {
  readonly users: Users;
  readonly sessions: Sessions;
  readonly tokens: McpTokens;
  #dummy: Promise<string> | null = null;

  private constructor(users: Users, sessions: Sessions, tokens: McpTokens) {
    this.users = users;
    this.sessions = sessions;
    this.tokens = tokens;
  }

  /** `cost` is log2 of scrypt's N; it is lowered only in tests. */
  static async open(
    home: string,
    options: { cost?: number; clock?: () => number } = {},
  ): Promise<Auth> {
    return new Auth(
      new Users(home, options),
      await Sessions.open(home, options.clock),
      new McpTokens(home, options.clock),
    );
  }

  /**
   * A hash to check a password against when the username does not exist,
   * so the time taken does not reveal which usernames do.
   */
  dummyHash(): Promise<string> {
    this.#dummy ??= hashPassword(
      "no account has this password",
      this.users.cost,
    );
    return this.#dummy;
  }

  /** The session a token opens, while its account exists and its password has not changed. */
  async authenticate(
    token: string | null,
  ): Promise<{ session: Session; account: Account } | null> {
    if (!token) return null;
    const session = this.sessions.find(token);
    if (!session) return null;
    const user = await this.users.byId(session.userId);
    if (
      !user ||
      Date.parse(session.createdAt) < Date.parse(user.passwordChangedAt)
    ) {
      return null;
    }
    return { session, account: { id: user.id, username: user.username } };
  }

  close() {
    return this.sessions.close();
  }
}
