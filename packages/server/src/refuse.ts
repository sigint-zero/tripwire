import type { FastifyReply } from "fastify";

const reasons: Record<number, string> = {
  400: "Bad Request",
  404: "Not Found",
  409: "Conflict",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

/** Sends the API's error envelope: a status, a stable code and a message. */
export function refuse(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  extra: object = {},
) {
  return reply.code(status).send({
    statusCode: status,
    error: reasons[status] ?? "Error",
    code,
    message,
    ...extra,
  });
}
