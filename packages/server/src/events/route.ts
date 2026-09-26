import type { FastifyPluginCallback } from "fastify";
import type { Auth } from "../auth";
import { readCookie, SESSION_COOKIE } from "../auth/cookies";
import type { BrowserRelay } from "./relay";

/**
 * `GET /events`: the browser's live stream. The session guard has already
 * refused anyone without a session, MCP tokens included.
 */
export const eventRoutes: FastifyPluginCallback<{
  relay: BrowserRelay;
  auth: Auth;
}> = (app, { relay, auth }, done) => {
  app.get("/events", (request, reply) => {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE) ?? "";
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });
    const stream = relay.open(
      request.sessionId!,
      reply.raw,
      async () => (await auth.authenticate(token)) !== null,
    );
    request.raw.on("close", () => stream.end());
  });
  done();
};
