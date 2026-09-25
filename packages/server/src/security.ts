import type { FastifyInstance, FastifyReply } from "fastify";
import { isIP } from "node:net";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Protects a server that is only meant to be reached from this machine:
 * - rejects unknown Host names, which blocks DNS rebinding from web pages;
 * - rejects cross-origin requests that change state;
 * - forbids other sites from framing the dashboard.
 */
export function guardRequests(
  app: FastifyInstance,
  allowedHosts: readonly string[] = [],
) {
  const extraHosts = new Set(
    allowedHosts.map(hostnameOf).filter((h): h is string => h !== undefined),
  );

  app.addHook("onRequest", (request, reply, done) => {
    reply.raw.setHeader("X-Frame-Options", "DENY");
    reply.raw.setHeader("Content-Security-Policy", "frame-ancestors 'none'");

    const host = request.headers.host;
    if (host !== undefined && !isAllowedHost(host, extraHosts)) {
      return void forbid(reply, `Host "${host}" is not allowed`);
    }

    const origin = request.headers.origin;
    if (
      !SAFE_METHODS.has(request.method) &&
      origin !== undefined &&
      !isSameOrigin(origin, host)
    ) {
      return void forbid(reply, "Cross-origin request rejected");
    }

    done();
  });
}

function isAllowedHost(host: string, extraHosts: ReadonlySet<string>) {
  const hostname = hostnameOf(host);
  if (hostname === undefined) return false;
  // A literal IP cannot be used for DNS rebinding.
  if (isIP(hostname.replace(/^\[|\]$/g, "")) !== 0) return true;
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    extraHosts.has(hostname)
  );
}

function isSameOrigin(origin: string, host: string | undefined) {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function hostnameOf(host: string) {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return undefined;
  }
}

function forbid(reply: FastifyReply, message: string) {
  return reply.code(403).send({ statusCode: 403, error: "Forbidden", message });
}
