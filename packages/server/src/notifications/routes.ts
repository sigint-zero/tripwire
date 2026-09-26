import {
  channelFields,
  channelTypes,
  defaultKinds,
  issuesOf,
  notificationKinds,
  severity,
  type Channel,
  type ChannelDelivery,
  type ChannelTest,
  type NotificationPage,
  type NotificationSettings,
} from "@tripwire/shared";
import type { FastifyPluginCallback } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { EngineReads } from "../engine/types";
import { refuse } from "../refuse";
import { render, toItem } from "./render";
import type { ChannelSecrets } from "./secrets";
import type { ChannelRow, ChannelStateRow, NotificationStore } from "./store";
import { missingFields, type NotificationWorker } from "./worker";

// The feed, its read marks, the channels and the links messages carry
// (NOTIFICATIONS.md, API). Secrets go in and are never read back.

const PAGE = 50;

const cursor = z.string().transform((text, ctx) => {
  const [micros, source, id] = Buffer.from(text, "base64url")
    .toString()
    .split("|");
  if (!micros || !/^\d+$/.test(micros) || !source || !id || !/^\d+$/.test(id)) {
    ctx.addIssue({ code: "custom", message: "is not a cursor" });
    return z.NEVER;
  }
  return { micros, source, id };
});

const feedQuery = z.strictObject({
  cursor: cursor.optional(),
  kind: z.enum(notificationKinds).optional(),
  severity: severity.optional(),
  unread: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const noticeId = z
  .string()
  .regex(/^(engine|app):\d+$/, "must be like engine:18342");

const readBody = z.union([
  z.strictObject({ ids: z.array(noticeId).min(1).max(500) }),
  z.strictObject({ all: z.literal(true) }),
]);

const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((u) => {
    try {
      return ["http:", "https:"].includes(new URL(u).protocol);
    } catch {
      return false;
    }
  }, "must be an http or https address");

const settingsBody = z.strictObject({
  dashboardUrl: httpUrl.nullable(),
  heartbeatUrl: httpUrl.nullable(),
});

/** A secret as entered: its value, or `env:NAME` to read it from the server's environment. */
const secretValue = z.string().trim().min(1).max(2000);

const channelBody = z
  .strictObject({
    name: z.string().trim().min(1).max(60),
    type: z.enum(channelTypes),
    enabled: z.boolean().default(true),
    kinds: z.array(z.enum(notificationKinds)).min(1).default(defaultKinds),
    minSeverity: severity.default("info"),
    stormLimit: z.number().int().min(0).max(1000).optional(),
    settings: z.record(z.string(), z.string().trim().max(500)).default({}),
    secrets: z.record(z.string(), secretValue).default({}),
  })
  .superRefine((body, ctx) => {
    const fields = channelFields[body.type];
    for (const key of Object.keys(body.settings)) {
      if (!fields.some((f) => f.key === key && !f.secret)) {
        ctx.addIssue({
          code: "custom",
          path: ["settings", key],
          message: `is not a ${body.type} setting`,
        });
      }
    }
    for (const [key, value] of Object.entries(body.secrets)) {
      if (!fields.some((f) => f.key === key && f.secret)) {
        ctx.addIssue({
          code: "custom",
          path: ["secrets", key],
          message: `is not a ${body.type} secret`,
        });
      } else if (key === "url" && !value.startsWith("env:")) {
        const valid = httpUrl.safeParse(value);
        if (!valid.success) {
          ctx.addIssue({
            code: "custom",
            path: ["secrets", key],
            message: "must be an http or https address",
          });
        }
      }
    }
    if (
      body.settings.port !== undefined &&
      !/^\d{1,5}$/.test(body.settings.port)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["settings", "port"],
        message: "must be a port number",
      });
    }
  });

type ById = { Params: { id: string } };

export const notificationRoutes: FastifyPluginCallback<{
  store: NotificationStore;
  secrets: ChannelSecrets;
  reads: EngineReads;
  worker: NotificationWorker;
}> = (app, { store, secrets, reads, worker }, done) => {
  const names = async () =>
    new Map(
      (await reads.contracts().catch(() => [])).map((c) => [
        c.address.toLowerCase(),
        c.name,
      ]),
    );
  const noChannel = (reply: Parameters<typeof refuse>[0]) =>
    refuse(reply, 404, "not_found", "No such channel.");

  app.get("/notifications", async (request, reply) => {
    const query = feedQuery.safeParse(request.query);
    if (!query.success) {
      return refuse(reply, 400, "invalid_request", "Invalid query.", {
        issues: issuesOf(query.error),
      });
    }
    const limit = query.data.limit ?? PAGE;
    const [rows, named] = await Promise.all([
      store.feed({
        before: query.data.cursor,
        kind: query.data.kind,
        severity: query.data.severity,
        unread: query.data.unread === "true",
        limit: limit + 1,
      }),
      names(),
    ]);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => toItem(row, named)),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(`${last.micros}|${last.source}|${last.id}`).toString(
              "base64url",
            )
          : null,
    } satisfies NotificationPage;
  });

  app.get("/notifications/unread-count", async () => ({
    count: await store.unreadCount(),
  }));

  app.post("/notifications/read", async (request, reply) => {
    const body = readBody.safeParse(request.body);
    if (!body.success) {
      return refuse(reply, 400, "invalid_request", "Invalid request.", {
        issues: issuesOf(body.error),
      });
    }
    await store.markRead(
      "all" in body.data
        ? "all"
        : body.data.ids.map((id) => {
            const [source, n] = id.split(":");
            return { source: source!, id: n! };
          }),
    );
    return { count: await store.unreadCount() };
  });

  app.get("/notification-settings", async (): Promise<NotificationSettings> => {
    const urls = await store.urls();
    return { dashboardUrl: urls.dashboard, heartbeatUrl: urls.heartbeat };
  });

  app.put("/notification-settings", async (request, reply) => {
    const body = settingsBody.safeParse(request.body);
    if (!body.success) {
      return refuse(reply, 400, "invalid_settings", "Invalid settings.", {
        issues: issuesOf(body.error),
      });
    }
    await store.setUrls({
      dashboard: body.data.dashboardUrl,
      heartbeat: body.data.heartbeatUrl,
    });
    request.log.info(
      { username: request.account?.username },
      "notification settings changed",
    );
    return body.data satisfies NotificationSettings;
  });

  const shown = async (
    rows: ChannelRow[],
    states?: ChannelStateRow[],
  ): Promise<Channel[]> => {
    const [allStates, stored] = await Promise.all([
      states ?? store.channelStates(),
      secrets.all(),
    ]);
    return rows.map((row) => {
      const state = allStates.find((s) => s.channel_id === row.id);
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        enabled: row.enabled,
        kinds: row.kinds,
        minSeverity: row.min_severity,
        stormLimit: row.storm_limit,
        settings: row.settings,
        secretsSet: Object.keys(stored[row.id] ?? {}).sort(),
        state: {
          backlog: state?.backlog ?? 0,
          oldestPendingAt: state?.oldest_pending_at?.toISOString() ?? null,
          lastDeliveredAt: state?.last_delivered_at?.toISOString() ?? null,
          lastError: state?.last_error ?? null,
          failingSince: state?.failing_since?.toISOString() ?? null,
        },
      };
    });
  };

  app.get("/channels", async () => shown(await store.channels()));

  /** Stores a checked body as channel `id`, or as a new one. */
  const save = async (
    request: { body: unknown },
    reply: Parameters<typeof refuse>[0],
    existing: ChannelRow | null,
  ) => {
    const body = channelBody.safeParse(request.body);
    if (!body.success) {
      return {
        refused: refuse(reply, 400, "invalid_channel", "Invalid channel.", {
          issues: issuesOf(body.error),
        }),
      };
    }
    const data = body.data;
    if (existing && existing.type !== data.type) {
      return {
        refused: refuse(
          reply,
          400,
          "invalid_channel",
          "A channel keeps its type; add a new channel instead.",
        ),
      };
    }
    const others = (await store.channels()).filter(
      (c) => c.id !== existing?.id,
    );
    if (others.some((c) => c.name.toLowerCase() === data.name.toLowerCase())) {
      return {
        refused: refuse(reply, 409, "name_taken", "A channel has that name."),
      };
    }
    // A webhook's signing key is generated, once, and shown once.
    const signingKey =
      data.type === "webhook" && !existing
        ? randomBytes(32).toString("hex")
        : null;
    const setAfter = [
      ...new Set([
        ...(existing ? await secrets.names(existing.id) : []),
        ...Object.keys(data.secrets),
        ...(signingKey ? ["signingKey"] : []),
      ]),
    ];
    const missing = missingFields(data.type, data.settings, setAfter);
    if (missing.length > 0) {
      return {
        refused: refuse(
          reply,
          400,
          "invalid_channel",
          `A ${data.type} channel needs: ${missing.join(", ")}.`,
        ),
      };
    }
    const row = {
      name: data.name,
      type: data.type,
      enabled: data.enabled,
      kinds: data.kinds,
      min_severity: data.minSeverity,
      // Webhooks are read by programs, which want every message.
      storm_limit: data.stormLimit ?? (data.type === "webhook" ? 0 : 10),
      settings: data.settings,
    };
    let id: string;
    if (existing) {
      await store.updateChannel(existing.id, row);
      id = existing.id;
    } else {
      id = await store.createChannel(row);
    }
    const newSecrets = {
      ...data.secrets,
      ...(signingKey ? { signingKey } : {}),
    };
    if (Object.keys(newSecrets).length > 0) await secrets.set(id, newSecrets);
    return { id, signingKey };
  };

  app.post("/channels", async (request, reply) => {
    const saved = await save(request, reply, null);
    if ("refused" in saved) return saved.refused;
    const [channel] = await shown([(await store.channel(saved.id))!]);
    request.log.info(
      { username: request.account?.username, channel: channel!.name },
      "channel created",
    );
    return reply.code(201).send({
      ...channel,
      ...(saved.signingKey ? { signingKey: saved.signingKey } : {}),
    });
  });

  app.put<ById>("/channels/:id", async (request, reply) => {
    const existing = await store.channel(request.params.id);
    if (!existing) return noChannel(reply);
    const saved = await save(request, reply, existing);
    if ("refused" in saved) return saved.refused;
    const [channel] = await shown([(await store.channel(saved.id))!]);
    request.log.info(
      { username: request.account?.username, channel: channel!.name },
      "channel changed",
    );
    worker.wake();
    return channel;
  });

  app.delete<ById>("/channels/:id", async (request, reply) => {
    const existing = await store.channel(request.params.id);
    if (!existing) return noChannel(reply);
    const dropped = await store.deleteChannel(existing.id);
    await secrets.remove(existing.id);
    request.log.info(
      { username: request.account?.username, channel: existing.name, dropped },
      "channel deleted",
    );
    return { dropped };
  });

  app.post<ById>(
    "/channels/:id/test",
    async (request, reply): Promise<ChannelTest | undefined> => {
      const channel = await store.channel(request.params.id);
      if (!channel) return noChannel(reply);
      return worker.test(channel);
    },
  );

  app.get<ById & { Querystring: { cursor?: string } }>(
    "/channels/:id/deliveries",
    async (request, reply) => {
      const channel = await store.channel(request.params.id);
      if (!channel) return noChannel(reply);
      const before = request.query.cursor;
      if (before !== undefined && !/^\d+$/.test(before)) {
        return refuse(reply, 400, "invalid_request", "Invalid cursor.");
      }
      const rows = await store.deliveries(channel.id, before, PAGE + 1);
      const page = rows.slice(0, PAGE);
      const [notices, named] = await Promise.all([
        store.notices(
          page.map((r) => ({ source: r.source, id: r.notification_id })),
        ),
        names(),
      ]);
      const titles = new Map(
        notices.map((n) => [`${n.source}:${n.id}`, render(n, named).title]),
      );
      return {
        items: page.map((r): ChannelDelivery => ({
          id: r.id,
          notificationId: `${r.source}:${r.notification_id}`,
          title: titles.get(`${r.source}:${r.notification_id}`) ?? null,
          attempts: r.attempts,
          nextAttemptAt: r.delivered_at
            ? null
            : (r.next_attempt_at?.toISOString() ?? null),
          deliveredAt: r.delivered_at?.toISOString() ?? null,
          digestId: r.digest_id,
          lastError: r.last_error,
          createdAt: r.created_at.toISOString(),
        })),
        nextCursor: rows.length > PAGE ? page.at(-1)!.id : null,
      };
    },
  );

  done();
};
