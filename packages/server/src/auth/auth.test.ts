import type { FastifyInstance } from "fastify";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../app";
import { TEST_ACCOUNT, TEST_COST, testHome, testServer } from "../testing";
import { Auth } from "./index";
import { SESSION_MAX_MS } from "./sessions";

// Authentication as AUTHENTICATION.md specifies it, against a server in
// memory with a temporary data directory.

let home: Awaited<ReturnType<typeof testHome>>;
let app: FastifyInstance;

beforeEach(async () => {
  home = await testHome();
  app = await createServer({ home: home.home, passwordCost: TEST_COST });
});
afterEach(async () => {
  await app.close();
  await home.remove();
  vi.restoreAllMocks();
});

const setup = (payload: object = TEST_ACCOUNT) =>
  app.inject({ method: "POST", url: "/api/v1/auth/setup", payload });
const login = (payload: object = TEST_ACCOUNT, remoteAddress = "127.0.0.1") =>
  app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload,
    remoteAddress,
  });
const cookieOf = (res: { headers: Record<string, unknown> }) =>
  String(res.headers["set-cookie"]).split(";")[0]!;
const as = (cookie: string, url: string, method: "GET" | "POST" = "GET") =>
  app.inject({ method, url, headers: { cookie } });

describe("the first account", () => {
  it("is created once, and opens a session", async () => {
    expect((await app.inject({ url: "/api/v1/auth/setup" })).json()).toEqual({
      required: true,
    });
    const res = await setup();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ user: { username: "tester" } });
    const session = await as(cookieOf(res), "/api/v1/auth/session");
    expect(session.statusCode).toBe(200);

    expect((await app.inject({ url: "/api/v1/auth/setup" })).json()).toEqual({
      required: false,
    });
    expect(
      (await setup({ ...TEST_ACCOUNT, username: "other" })).statusCode,
    ).toBe(409);
  });

  it("needs a valid username and a long enough password", async () => {
    expect(
      (await setup({ username: "no spaces", password: "long enough pass" }))
        .statusCode,
    ).toBe(400);
    expect(
      (await setup({ username: "ok", password: "short" })).json(),
    ).toMatchObject({ code: "invalid_password" });
  });
});

describe("logging in", () => {
  beforeEach(() => setup());

  it("sets exactly the specified cookie", async () => {
    const res = await login({ ...TEST_ACCOUNT, username: "TESTER" });
    expect(res.statusCode).toBe(204);
    expect(res.headers["set-cookie"]).toMatch(
      /^tripwire_session=[\w-]{43}; HttpOnly; SameSite=Lax; Path=\/$/,
    );
  });

  it("never says which half was wrong, and hashes for unknown users too", async () => {
    const dummy = vi.spyOn(Auth.prototype, "dummyHash");
    const wrong = await login({
      ...TEST_ACCOUNT,
      password: "not the password",
    });
    const unknown = await login({ ...TEST_ACCOUNT, username: "nobody" });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
    expect(dummy).toHaveBeenCalledTimes(1);
  });

  it("makes each attempt wait after five straight failures, until a success", async () => {
    for (let i = 0; i < 5; i++) {
      expect(
        (await login({ ...TEST_ACCOUNT, password: "wrong password!" }))
          .statusCode,
      ).toBe(401);
    }
    const held = await login();
    expect(held.statusCode).toBe(429);
    expect(held.headers["retry-after"]).toBe("1");

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect((await login()).statusCode).toBe(204);
    // The success cleared the count: a wrong password is just wrong again.
    expect(
      (await login({ ...TEST_ACCOUNT, password: "wrong password!" }))
        .statusCode,
    ).toBe(401);
  });

  it("limits attempts from one address to twenty a minute", async () => {
    for (let i = 0; i < 20; i++) await login(TEST_ACCOUNT, "10.0.0.9");
    expect((await login(TEST_ACCOUNT, "10.0.0.9")).statusCode).toBe(429);
    expect((await login(TEST_ACCOUNT, "10.0.0.10")).statusCode).toBe(204);
  });
});

describe("what is protected", () => {
  it("answers the public list without a session", async () => {
    expect((await app.inject({ url: "/api/v1/health" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/auth/setup" })).statusCode).toBe(
      200,
    );
  });

  it("refuses everything else without a session, with a bad one, or with an MCP token", async () => {
    const cookie = cookieOf(await setup());
    const { token } = await (
      await Auth.open(home.home, { cost: TEST_COST })
    ).tokens.create({ label: "agent" });
    for (const headers of [
      {},
      { cookie: "tripwire_session=forged" },
      { authorization: `Bearer ${token}` },
    ]) {
      const res = await app.inject({ url: "/api/v1/auth/session", headers });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: "unauthenticated" });
    }
    // A cookie that no longer opens anything is cleared.
    const bad = await as("tripwire_session=forged", "/api/v1/auth/session");
    expect(bad.headers["set-cookie"]).toMatch(
      /^tripwire_session=; .*Max-Age=0/,
    );
    expect((await as(cookie, "/api/v1/auth/session")).statusCode).toBe(200);
  });

  it("protects the application's routes too", async () => {
    const signedIn = await testServer();
    const anonymous = await signedIn.inject({
      url: "/api/v1/contracts",
      headers: { cookie: "" },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(
      (await signedIn.inject({ url: "/api/v1/contracts" })).statusCode,
    ).toBe(200);
    await signedIn.close();
  });
});

describe("ending sessions", () => {
  it("logs out the one session", async () => {
    const first = cookieOf(await setup());
    const second = cookieOf(await login());
    const out = await as(first, "/api/v1/auth/logout", "POST");
    expect(out.statusCode).toBe(204);
    expect((await as(first, "/api/v1/auth/session")).statusCode).toBe(401);
    expect((await as(second, "/api/v1/auth/session")).statusCode).toBe(200);
  });

  it("ends every other session when the password changes", async () => {
    const first = cookieOf(await setup());
    const second = cookieOf(await login());
    const change = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      headers: { cookie: first },
      payload: {
        currentPassword: TEST_ACCOUNT.password,
        newPassword: "an entirely new passphrase",
      },
    });
    expect(change.statusCode).toBe(204);
    expect((await as(second, "/api/v1/auth/session")).statusCode).toBe(401);
    const renewed = cookieOf(change);
    expect((await as(renewed, "/api/v1/auth/session")).statusCode).toBe(200);
    expect(
      (await login({ ...TEST_ACCOUNT, password: "an entirely new passphrase" }))
        .statusCode,
    ).toBe(204);
  });

  it("lists this account's sessions and revokes one", async () => {
    const first = cookieOf(await setup());
    await login();
    const list = (await as(first, "/api/v1/auth/sessions")).json<
      { id: string; current: boolean }[]
    >();
    expect(list).toHaveLength(2);
    const other = list.find((s) => !s.current)!;
    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/sessions/${other.id}`,
      headers: { cookie: first },
    });
    expect(revoked.statusCode).toBe(204);
    expect((await as(first, "/api/v1/auth/sessions")).json()).toHaveLength(1);
  });

  it("refuses a session a day after login, even one used a minute ago", async () => {
    let now = Date.parse("2026-09-26T00:00:00Z");
    const auth = await Auth.open(home.home, {
      cost: TEST_COST,
      clock: () => now,
    });
    const user = await auth.users.add("clock", "a long enough password");
    const { token } = await auth.sessions.create(user.id, {
      address: "127.0.0.1",
      userAgent: "test",
    });
    now += SESSION_MAX_MS - 60_000;
    expect(await auth.authenticate(token)).not.toBeNull();
    now += 60_000;
    expect(await auth.authenticate(token)).toBeNull();
    await auth.close();
  });
});

describe("accounts", () => {
  it("adds and removes accounts, but never the last or your own", async () => {
    const cookie = cookieOf(await setup());
    const added = await app.inject({
      method: "POST",
      url: "/api/v1/auth/users",
      headers: { cookie },
      payload: { username: "Ops", password: "another long password" },
    });
    expect(added.json()).toMatchObject({ username: "ops" });
    const me = (await as(cookie, "/api/v1/auth/session")).json<{
      user: { id: string };
    }>().user.id;

    const self = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/users/${me}`,
      headers: { cookie },
    });
    expect(self.json()).toMatchObject({ code: "cannot_remove_self" });

    // The removed account's sessions and MCP tokens go with it.
    const ops = cookieOf(
      await login({ username: "ops", password: "another long password" }),
    );
    const minted = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mcp-tokens",
      headers: { cookie: ops },
      payload: { label: "ops agent" },
    });
    expect(minted.statusCode).toBe(201);
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/users/${added.json<{ id: string }>().id}`,
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(204);
    expect((await as(ops, "/api/v1/auth/session")).statusCode).toBe(401);
    expect((await as(cookie, "/api/v1/auth/mcp-tokens")).json()).toEqual([]);
  });

  it("keeps its files private", async () => {
    await setup();
    for (const file of ["users.json", "sessions.json"]) {
      expect((await stat(join(home.home, file))).mode & 0o777).toBe(0o600);
    }
  });
});

describe("MCP tokens in the API", () => {
  it("shows a token once, lists it without it, and revokes it", async () => {
    const cookie = cookieOf(await setup());
    const minted = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mcp-tokens",
      headers: { cookie },
      payload: { label: "laptop agent" },
    });
    const { id, token } = minted.json<{ id: string; token: string }>();
    expect(token).toMatch(/^twm_/);
    const list = (await as(cookie, "/api/v1/auth/mcp-tokens")).json<object[]>();
    expect(list).toEqual([
      expect.objectContaining({
        id,
        label: "laptop agent",
        owner: expect.objectContaining({ username: "tester" }) as unknown,
      }),
    ]);
    expect(JSON.stringify(list)).not.toContain(token);
    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/mcp-tokens/${id}`,
      headers: { cookie },
    });
    expect(revoked.statusCode).toBe(204);
  });
});
