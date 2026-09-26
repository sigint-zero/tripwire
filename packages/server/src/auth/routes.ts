import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import { refuse } from "../refuse";
import { readCookie, SESSION_COOKIE, sessionCookie } from "./cookies";
import type { Account, Auth } from "./index";
import { TokenError } from "./mcp-tokens";
import { needsRehash, verifyPassword } from "./passwords";
import { AccountError } from "./users";

declare module "fastify" {
  interface FastifyRequest {
    /** The logged-in account, on every protected route. */
    account: Account | null;
    sessionId: string | null;
  }
}

/** Routes that answer without a session, as exact method and path. */
const PUBLIC = new Set([
  "GET /api/v1/health",
  "GET /api/v1/auth/setup",
  "POST /api/v1/auth/setup",
  "POST /api/v1/auth/login",
]);

/** Login attempts allowed per client address per minute. */
const LOGINS_PER_MINUTE = 20;
/** Consecutive failures an account takes before each attempt must wait. */
const FREE_FAILURES = 5;

const credentials = z.object({
  username: z.string().max(256),
  password: z.string().max(1024),
});
const newAccount = z.object({ username: z.string(), password: z.string() });
const passwordChange = z.object({
  currentPassword: z.string().max(1024),
  newPassword: z.string(),
});
const newToken = z.object({
  label: z.string(),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

type ById = { Params: { id: string } };

const accountError = (reply: FastifyReply, error: unknown) => {
  if (error instanceof AccountError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "username_taken" || error.code === "last_account"
          ? 409
          : 400;
    return refuse(reply, status, error.code, error.message);
  }
  throw error;
};

const secure = (request: FastifyRequest) => request.protocol === "https";

/**
 * Requires a session on every route of `app` except the few public ones.
 * Called on the API instance itself, so the hook covers all its routes.
 */
export function requireSession(app: FastifyInstance, auth: Auth) {
  // Fail closed: anything not on the public list needs a session, and a
  // missing, expired or malformed one all get the same answer.
  app.decorateRequest("account", null);
  app.decorateRequest("sessionId", null);
  app.addHook("onRequest", async (request, reply) => {
    const [path = ""] = request.url.split("?");
    if (PUBLIC.has(`${request.method} ${path}`)) return;
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    const found = await auth.authenticate(token);
    if (!found) {
      if (token !== null) {
        reply.header("Set-Cookie", sessionCookie("", secure(request)));
      }
      return refuse(reply, 401, "unauthenticated", "Log in to continue.");
    }
    request.account = found.account;
    request.sessionId = found.session.id;
  });
}

/** The routes under /auth: first account, login, sessions, accounts, MCP tokens. */
export const authRoutes: FastifyPluginCallback<{ auth: Auth }> = (
  app,
  { auth },
  done,
) => {
  const client = (request: FastifyRequest) => ({
    address: request.ip,
    userAgent: request.headers["user-agent"] ?? "",
  });
  const open = async (
    request: FastifyRequest,
    reply: FastifyReply,
    userId: string,
  ) => {
    const { token } = await auth.sessions.create(userId, client(request));
    reply.header("Set-Cookie", sessionCookie(token, secure(request)));
  };

  // First account: allowed only while there is none.
  app.get("/auth/setup", async () => ({
    required: (await auth.users.all()).length === 0,
  }));

  app.post("/auth/setup", async (request, reply) => {
    if ((await auth.users.all()).length > 0) {
      return refuse(
        reply,
        409,
        "already_set_up",
        "Tripwire already has an account.",
      );
    }
    const body = newAccount.safeParse(request.body);
    if (!body.success) {
      return refuse(
        reply,
        400,
        "invalid_request",
        "Expected { username, password }.",
      );
    }
    try {
      const user = await auth.users.add(body.data.username, body.data.password);
      request.log.info(
        { username: user.username, address: request.ip },
        "first account created",
      );
      await open(request, reply, user.id);
      return reply
        .code(201)
        .send({ user: { id: user.id, username: user.username } });
    } catch (error) {
      return accountError(reply, error);
    }
  });

  // Login: never says which half was wrong, and runs scrypt for unknown
  // usernames too, so neither the answer nor its timing reveals accounts.
  const attempts = new Map<string, number[]>();
  app.post("/auth/login", async (request, reply) => {
    const now = Date.now();
    const recent = (attempts.get(request.ip) ?? []).filter(
      (t) => now - t < 60_000,
    );
    if (recent.length >= LOGINS_PER_MINUTE) {
      const wait = Math.ceil((recent[0]! + 60_000 - now) / 1000);
      return refuse(
        reply.header("Retry-After", String(wait)),
        429,
        "too_many_attempts",
        `Too many login attempts. Try again in ${wait} seconds.`,
      );
    }
    attempts.set(request.ip, [...recent, now]);

    const body = credentials.safeParse(request.body);
    if (!body.success) {
      return refuse(
        reply,
        400,
        "invalid_request",
        "Expected { username, password }.",
      );
    }
    const user = await auth.users.find(body.data.username);

    // After five straight failures, each attempt waits 2^(n-5) seconds, up to a minute.
    if (user && user.failedLogins >= FREE_FAILURES && user.lastFailedLoginAt) {
      const delay =
        Math.min(2 ** (user.failedLogins - FREE_FAILURES), 60) * 1000;
      const until = Date.parse(user.lastFailedLoginAt) + delay;
      if (now < until) {
        const wait = Math.ceil((until - now) / 1000);
        return refuse(
          reply.header("Retry-After", String(wait)),
          429,
          "too_many_attempts",
          `Too many failed attempts. Try again in ${wait} seconds.`,
        );
      }
    }

    const ok = await verifyPassword(
      body.data.password,
      user?.passwordHash ?? (await auth.dummyHash()),
    );
    if (!user || !ok) {
      if (user) await auth.users.recordFailure(user.id);
      request.log.info(
        { username: body.data.username.slice(0, 64), address: request.ip },
        "failed login",
      );
      return refuse(
        reply,
        401,
        "invalid_credentials",
        "Wrong username or password.",
      );
    }
    await auth.users.clearFailures(user.id);
    if (needsRehash(user.passwordHash, auth.users.cost)) {
      await auth.users.setPassword(user.id, body.data.password, true);
    }
    request.log.info({ username: user.username, address: request.ip }, "login");
    await open(request, reply, user.id);
    return reply.code(204).send();
  });

  app.post("/auth/logout", async (request, reply) => {
    await auth.sessions.revoke(request.sessionId!);
    request.log.info({ username: request.account!.username }, "logout");
    reply.header("Set-Cookie", sessionCookie("", secure(request)));
    return reply.code(204).send();
  });

  app.get("/auth/session", (request) => {
    const session = auth.sessions
      .list(request.account!.id)
      .find((s) => s.id === request.sessionId)!;
    return {
      user: request.account,
      createdAt: session.createdAt,
      expiresAt: auth.sessions.expiresAt(session).toISOString(),
    };
  });

  // A new password ends every session of the account; this one is reopened.
  app.post("/auth/password", async (request, reply) => {
    const body = passwordChange.safeParse(request.body);
    if (!body.success) {
      return refuse(
        reply,
        400,
        "invalid_request",
        "Expected { currentPassword, newPassword }.",
      );
    }
    const user = await auth.users.byId(request.account!.id);
    if (
      !user ||
      !(await verifyPassword(body.data.currentPassword, user.passwordHash))
    ) {
      return refuse(
        reply,
        403,
        "wrong_password",
        "The current password is wrong.",
      );
    }
    try {
      await auth.users.setPassword(user.id, body.data.newPassword);
    } catch (error) {
      return accountError(reply, error);
    }
    await auth.sessions.revokeUser(user.id);
    request.log.info({ username: user.username }, "password changed");
    await open(request, reply, user.id);
    return reply.code(204).send();
  });

  app.get("/auth/sessions", (request) =>
    auth.sessions.list(request.account!.id).map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: auth.sessions.expiresAt(s).toISOString(),
      address: s.address,
      userAgent: s.userAgent,
      current: s.id === request.sessionId,
    })),
  );

  app.delete<ById>("/auth/sessions/:id", async (request, reply) => {
    const own = auth.sessions
      .list(request.account!.id)
      .some((s) => s.id === request.params.id);
    if (!own) return refuse(reply, 404, "not_found", "No such session.");
    await auth.sessions.revoke(request.params.id);
    if (request.params.id === request.sessionId) {
      reply.header("Set-Cookie", sessionCookie("", secure(request)));
    }
    return reply.code(204).send();
  });

  // Accounts: all equal.
  app.get("/auth/users", async () =>
    (await auth.users.all()).map((u) => ({
      id: u.id,
      username: u.username,
      createdAt: u.createdAt,
    })),
  );

  app.post("/auth/users", async (request, reply) => {
    const body = newAccount.safeParse(request.body);
    if (!body.success) {
      return refuse(
        reply,
        400,
        "invalid_request",
        "Expected { username, password }.",
      );
    }
    try {
      const user = await auth.users.add(body.data.username, body.data.password);
      request.log.info(
        { username: user.username, by: request.account!.username },
        "account added",
      );
      return reply.code(201).send({
        id: user.id,
        username: user.username,
        createdAt: user.createdAt,
      });
    } catch (error) {
      return accountError(reply, error);
    }
  });

  // Removing an account ends its sessions and revokes its MCP tokens.
  app.delete<ById>("/auth/users/:id", async (request, reply) => {
    if (request.params.id === request.account!.id) {
      return refuse(
        reply,
        409,
        "cannot_remove_self",
        "You cannot remove your own account.",
      );
    }
    try {
      await auth.users.remove(request.params.id);
    } catch (error) {
      return accountError(reply, error);
    }
    await auth.sessions.revokeUser(request.params.id);
    await auth.tokens.revokeUser(request.params.id);
    return reply.code(204).send();
  });

  // MCP tokens: listed without the token, which is shown once at creation.
  app.get("/auth/mcp-tokens", async () => {
    const [tokens, users] = await Promise.all([
      auth.tokens.list(),
      auth.users.all(),
    ]);
    return tokens.map((t) => {
      const owner = users.find((u) => u.id === t.userId);
      return {
        id: t.id,
        label: t.label,
        owner: owner ? { id: owner.id, username: owner.username } : null,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
        expiresAt: t.expiresAt,
      };
    });
  });

  app.post("/auth/mcp-tokens", async (request, reply) => {
    const body = newToken.safeParse(request.body);
    if (!body.success) {
      return refuse(
        reply,
        400,
        "invalid_request",
        "Expected { label, expiresAt }.",
      );
    }
    try {
      const { token, record } = await auth.tokens.create({
        label: body.data.label,
        expiresAt: body.data.expiresAt ? new Date(body.data.expiresAt) : null,
        userId: request.account!.id,
      });
      request.log.info(
        { label: record.label, by: request.account!.username },
        "MCP token created",
      );
      return reply.code(201).send({ id: record.id, token });
    } catch (error) {
      if (error instanceof TokenError) {
        return refuse(
          reply,
          error.code === "label_taken" ? 409 : 400,
          error.code,
          error.message,
        );
      }
      throw error;
    }
  });

  app.delete<ById>("/auth/mcp-tokens/:id", async (request, reply) => {
    const known = (await auth.tokens.list()).some(
      (t) => t.id === request.params.id,
    );
    if (!known) return refuse(reply, 404, "not_found", "No such token.");
    await auth.tokens.revoke(request.params.id);
    request.log.info(
      { id: request.params.id, by: request.account!.username },
      "MCP token revoked",
    );
    return reply.code(204).send();
  });

  done();
};
