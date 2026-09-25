import type { FastifyInstance } from "fastify";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createServer, type ServerOptions } from "./app";

/** Starts a server for the enclosing describe block and closes it after. */
function useServer(options: () => ServerOptions = () => ({})) {
  const handle = {} as { app: FastifyInstance };
  beforeAll(async () => {
    const app = await createServer(options());
    handle.app = app;
    return () => app.close();
  });
  return handle;
}

describe("API only", () => {
  const server = useServer();

  it("reports health", async () => {
    const res = await server.app.inject({ url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("returns a JSON 404 for unknown routes", async () => {
    const res = await server.app.inject({ url: "/contracts" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ statusCode: 404, error: "Not Found" });
  });
});

describe("request guard", () => {
  const server = useServer(() => ({ allowedHosts: ["tripwire.lan"] }));
  const health = (
    headers: Record<string, string>,
    method: "GET" | "POST" = "GET",
  ) => server.app.inject({ method, url: "/api/v1/health", headers });

  it("rejects unknown host names (DNS rebinding)", async () => {
    const res = await health({ host: "evil.example:4747" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ statusCode: 403 });
  });

  it.each([
    "localhost:4747",
    "app.localhost:4747",
    "127.0.0.1:4747",
    "[::1]:4747",
    "192.168.1.5:4747",
    "tripwire.lan:4747",
  ])("allows %s", async (host) => {
    expect((await health({ host })).statusCode).toBe(200);
  });

  it("rejects cross-origin requests that change state", async () => {
    const res = await health(
      { host: "127.0.0.1:4747", origin: "http://evil.example" },
      "POST",
    );
    expect(res.statusCode).toBe(403);
  });

  it("lets same-origin requests through", async () => {
    const res = await health(
      { host: "127.0.0.1:4747", origin: "http://127.0.0.1:4747" },
      "POST",
    );
    expect(res.statusCode).toBe(404); // not blocked; there is no POST route
  });

  it("forbids framing", async () => {
    const res = await health({ host: "localhost" });
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toBe(
      "frame-ancestors 'none'",
    );
  });
});

describe("with the dashboard", () => {
  let webRoot = "";
  beforeAll(async () => {
    webRoot = await mkdtemp(join(tmpdir(), "tripwire-web-"));
    const files = {
      "index.html": "<!doctype html><title>t</title>",
      "assets/app-abc123.js": "console.log(1)",
      "robots.txt": "User-agent: *",
    };
    await mkdir(join(webRoot, "assets"));
    for (const [name, body] of Object.entries(files)) {
      await writeFile(join(webRoot, name), body);
    }
    return () => rm(webRoot, { recursive: true, force: true });
  });
  const server = useServer(() => ({ webRoot }));
  const get = (url: string, headers: Record<string, string> = {}) =>
    server.app.inject({ url, headers });

  it("serves index.html at the root without caching it", async () => {
    const res = await get("/");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("serves index.html for dashboard routes", async () => {
    for (const url of ["/violations", "/contracts/0xabc"]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toContain("<title>t</title>");
    }
  });

  it("serves dashboard routes that contain a dot to browsers", async () => {
    const res = await get("/contracts/vitalik.eth", { accept: "text/html" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>t</title>");
  });

  it("answers HEAD requests for dashboard routes", async () => {
    const res = await server.app.inject({ method: "HEAD", url: "/violations" });
    expect(res.statusCode).toBe(200);
  });

  it("caches only hashed assets permanently", async () => {
    const asset = await get("/assets/app-abc123.js");
    expect(asset.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    const other = await get("/robots.txt");
    expect(other.statusCode).toBe(200);
    expect(other.headers["cache-control"]).toBe("no-cache");
  });

  it.each(["/assets/app-old.js", "/favicon.ico"])(
    "returns 404 for missing file %s",
    async (url) => {
      const res = await get(url);
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
    },
  );

  it.each(["/api", "/api/v1/nope", "/API/v1/health"])(
    "keeps %s as a JSON 404",
    async (url) => {
      const res = await get(url, { accept: "text/html" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ statusCode: 404 });
    },
  );

  it("does not answer non-GET requests with the dashboard", async () => {
    const res = await server.app.inject({ method: "POST", url: "/contracts" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });
});
