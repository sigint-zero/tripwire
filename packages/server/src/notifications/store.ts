import type { ChannelType, NotificationKind, Severity } from "@tripwire/shared";
import type pg from "pg";

// Everything notification delivery keeps (NOTIFICATIONS.md): the feed over
// the engine's notifications and the application's own, read marks,
// dispatch, deliveries and channels. The engine's rows are read from its
// view; everything written lives in the `app` schema.

/** A notification from either source, with the kind and severity it is filed under. */
export interface NoticeRow {
  source: "engine" | "app";
  id: string;
  kind: NotificationKind;
  severity: Severity;
  payload: Record<string, unknown>;
  created_at: Date;
  /** Microseconds since the epoch, exact, for paging. */
  micros: string;
  read: boolean;
}

export interface ChannelRow {
  id: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
  kinds: NotificationKind[];
  min_severity: Severity;
  storm_limit: number;
  settings: Record<string, string>;
}

export interface ChannelStateRow {
  channel_id: string;
  backlog: number;
  oldest_pending_at: Date | null;
  last_delivered_at: Date | null;
  last_error: string | null;
  failing_since: Date | null;
}

export interface DeliveryRow {
  id: string;
  source: "engine" | "app";
  notification_id: string;
  channel_id: string;
  attempts: number;
  next_attempt_at: Date | null;
  delivered_at: Date | null;
  digest_id: string | null;
  last_error: string | null;
  created_at: Date;
}

export interface FeedFilter {
  before?: { micros: string; source: string; id: string };
  kind?: NotificationKind;
  severity?: Severity;
  unread?: boolean;
  limit: number;
}

const DISPATCH_SINCE = "notifications.dispatch_since";
const DASHBOARD_URL = "notifications.dashboard_url";
const HEARTBEAT_URL = "notifications.heartbeat_url";
/** Notifications older than this are shown, never sent. */
const DISPATCH_WINDOW = "7 days";

const CHANNEL = `id::text, name, type, enabled, kinds, min_severity,
  storm_limit, settings`;
const DELIVERY = `id::text, source, notification_id::text, channel_id::text,
  attempts, next_attempt_at, delivered_at, digest_id, last_error, created_at`;

export class NotificationStore {
  readonly #pool: pg.Pool;
  readonly #notices: string;

  /** `views` is the schema the engine's `notifications` view is read from. */
  constructor(pool: pg.Pool, views: string) {
    if (!/^[a-z_][a-z0-9_]*$/.test(views)) {
      throw new Error(`Not a schema name: ${views}`);
    }
    this.#pool = pool;
    // Both sources as one, each row filed under the feed's kind and
    // severity: an evaluation error is a violation row of that kind, a
    // person's pause or unpause is a response, and a response or health
    // row takes its severity from what it reports. A settled transaction
    // names only its response or action, so their rows fill in the rest.
    const idOf = (kind: string, key: string) =>
      `(CASE WHEN n.kind = '${kind}' AND coalesce(n.payload->>'${key}', n.payload->>'id') ~ '^[0-9]+$'
             THEN coalesce(n.payload->>'${key}', n.payload->>'id')::bigint END)`;
    this.#notices = `(
      SELECT 'engine' AS source, n.id,
             CASE WHEN n.kind = 'violation' AND n.payload->>'kind' = 'evaluation_error'
                    THEN 'evaluation_error'
                  WHEN n.kind = 'action' THEN 'response'
                  ELSE n.kind END AS kind,
             CASE
               WHEN n.kind = 'violation' AND n.payload->>'kind' = 'evaluation_error' THEN 'warning'
               WHEN n.kind = 'violation' THEN
                 CASE WHEN n.payload->>'severity' IN ('info', 'warning', 'critical')
                      THEN n.payload->>'severity' ELSE 'warning' END
               WHEN n.kind IN ('response', 'action') THEN
                 CASE n.payload->>'status' WHEN 'confirmed' THEN 'info'
                                           WHEN 'abandoned' THEN 'warning'
                                           ELSE 'critical' END
               WHEN n.kind = 'health' THEN
                 CASE WHEN n.payload->>'status' IN ('ready', 'starting') THEN 'info'
                      ELSE 'warning' END
               ELSE 'info' END AS severity,
             CASE
               WHEN r.id IS NOT NULL THEN jsonb_build_object(
                 'response_id', r.id::text, 'rule_id', r.rule_id::text,
                 'rule', r.rule_name, 'contract', r.contract_address,
                 'action', r.action) || n.payload
               WHEN a.id IS NOT NULL THEN jsonb_build_object(
                 'action_id', a.id::text, 'kind', a.kind, 'target', a.target,
                 'selector', a.selector, 'note', a.note) || n.payload
               ELSE n.payload END AS payload,
             n.created_at
        FROM ${views}.notifications n
        LEFT JOIN ${views}.responses r ON r.id = ${idOf("response", "response_id")}
        LEFT JOIN ${views}.actions a ON a.id = ${idOf("action", "action_id")}
      UNION ALL
      SELECT 'app', id, kind, severity, payload, created_at
        FROM app.local_notifications
    )`;
  }

  // The feed

  async feed(filter: FeedFilter): Promise<NoticeRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (filter.kind) where.push(`n.kind = ${param(filter.kind)}`);
    if (filter.severity) where.push(`n.severity = ${param(filter.severity)}`);
    if (filter.unread) where.push("r.read_at IS NULL");
    if (filter.before) {
      where.push(
        `(${MICROS}, n.source, n.id) < (${param(filter.before.micros)}::bigint, ${param(filter.before.source)}::text, ${param(filter.before.id)}::bigint)`,
      );
    }
    const { rows } = await this.#pool.query<NoticeRow>(
      `SELECT n.source, n.id::text, n.kind, n.severity, n.payload, n.created_at,
              ${MICROS}::text AS micros, r.read_at IS NOT NULL AS read
         FROM ${this.#notices} n
         LEFT JOIN app.notification_reads r
           ON r.source = n.source AND r.notification_id = n.id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY ${MICROS} DESC, n.source DESC, n.id DESC
        LIMIT ${param(filter.limit)}`,
      params,
    );
    return rows;
  }

  async unreadCount(): Promise<number> {
    const { rows } = await this.#pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${this.#notices} n
        WHERE NOT EXISTS (
          SELECT 1 FROM app.notification_reads r
           WHERE r.source = n.source AND r.notification_id = n.id)`,
    );
    return rows[0]?.n ?? 0;
  }

  /** Marks these read, or every notification there is. */
  async markRead(keys: { source: string; id: string }[] | "all") {
    if (keys === "all") {
      await this.#pool.query(
        `INSERT INTO app.notification_reads (source, notification_id)
         SELECT source, id FROM ${this.#notices} n
         ON CONFLICT DO NOTHING`,
      );
      return;
    }
    if (keys.length === 0) return;
    await this.#pool.query(
      `INSERT INTO app.notification_reads (source, notification_id)
       SELECT s, i FROM unnest($1::text[], $2::bigint[]) AS k(s, i)
       ON CONFLICT DO NOTHING`,
      [keys.map((k) => k.source), keys.map((k) => k.id)],
    );
  }

  /** The application's own notification, about itself. */
  async raise(
    kind: "system",
    severity: Severity,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const { rows } = await this.#pool.query<{ id: string }>(
      `INSERT INTO app.local_notifications (kind, severity, payload)
       VALUES ($1, $2, $3) RETURNING id::text`,
      [kind, severity, JSON.stringify(payload)],
    );
    return rows[0]!.id;
  }

  // Dispatch

  /** Notifications not yet fanned out, oldest first, inside the window that may still be sent. */
  async undispatched(limit: number): Promise<NoticeRow[]> {
    const { rows } = await this.#pool.query<NoticeRow>(
      `SELECT n.source, n.id::text, n.kind, n.severity, n.payload, n.created_at,
              ${MICROS}::text AS micros, false AS read
         FROM ${this.#notices} n
        WHERE NOT EXISTS (
                SELECT 1 FROM app.dispatches d
                 WHERE d.source = n.source AND d.notification_id = n.id)
          AND n.created_at >= greatest(
                now() - interval '${DISPATCH_WINDOW}',
                COALESCE((SELECT (value #>> '{}')::timestamptz FROM app.settings
                           WHERE key = '${DISPATCH_SINCE}'), '-infinity'))
        ORDER BY n.created_at, n.source, n.id
        LIMIT $1`,
      [limit],
    );
    return rows;
  }

  /** One delivery row per channel and the dispatch mark, together. */
  async dispatch(notice: NoticeRow, channelIds: string[]) {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const marked = await client.query(
        `INSERT INTO app.dispatches (source, notification_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [notice.source, notice.id],
      );
      // Another process got here first: it fans out, not this one.
      if (marked.rowCount && channelIds.length > 0) {
        await client.query(
          `INSERT INTO app.deliveries (source, notification_id, channel_id, next_attempt_at)
           SELECT $1, $2, c, now() FROM unnest($3::bigint[]) AS c`,
          [notice.source, notice.id, channelIds],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // Deliveries

  /**
   * Claims due deliveries on enabled channels, oldest first, by pushing
   * their next attempt out for the length of a send: another process
   * skips them, and a crash mid-send makes them due again.
   */
  async claimDue(limit: number, leaseSeconds: number): Promise<DeliveryRow[]> {
    const { rows } = await this.#pool.query<DeliveryRow>(
      `UPDATE app.deliveries d
          SET next_attempt_at = now() + make_interval(secs => $2)
        WHERE d.id IN (
          SELECT d2.id FROM app.deliveries d2
            JOIN app.channels c ON c.id = d2.channel_id AND c.enabled
           WHERE d2.delivered_at IS NULL AND d2.next_attempt_at <= now()
           ORDER BY d2.id
           LIMIT $1
           FOR UPDATE OF d2 SKIP LOCKED)
        RETURNING d.id::text, d.source, d.notification_id::text,
                  d.channel_id::text, d.attempts, d.next_attempt_at,
                  d.delivered_at, d.digest_id, d.last_error, d.created_at`,
      [limit, leaseSeconds],
    );
    return rows.sort((a, b) => Number(a.id) - Number(b.id));
  }

  /** Holds deliveries back until the next minute starts, keeping their attempts. */
  async deferToNextMinute(ids: string[]) {
    if (ids.length === 0) return;
    await this.#pool.query(
      `UPDATE app.deliveries
          SET next_attempt_at = date_trunc('minute', now()) + interval '1 minute'
        WHERE id = ANY($1::bigint[])`,
      [ids],
    );
  }

  async delivered(ids: string[], digestId: string | null = null) {
    if (ids.length === 0) return;
    await this.#pool.query(
      `UPDATE app.deliveries
          SET delivered_at = now(), attempts = attempts + 1, digest_id = $2,
              last_error = NULL, next_attempt_at = NULL
        WHERE id = ANY($1::bigint[])`,
      [ids, digestId],
    );
  }

  /** Records a failed attempt; the next is `retryMs` from now, by the database's clock like every claim. */
  async failed(ids: string[], error: string, retryMs: number) {
    if (ids.length === 0) return;
    await this.#pool.query(
      `UPDATE app.deliveries
          SET attempts = attempts + 1, last_error = $2,
              next_attempt_at = now() + make_interval(secs => $3)
        WHERE id = ANY($1::bigint[])`,
      [ids, error.slice(0, 500), retryMs / 1000],
    );
  }

  /** The notifications these deliveries carry. */
  async notices(keys: { source: string; id: string }[]): Promise<NoticeRow[]> {
    if (keys.length === 0) return [];
    const { rows } = await this.#pool.query<NoticeRow>(
      `SELECT n.source, n.id::text, n.kind, n.severity, n.payload, n.created_at,
              ${MICROS}::text AS micros, false AS read
         FROM ${this.#notices} n
         JOIN unnest($1::text[], $2::bigint[]) AS k(s, i)
           ON n.source = k.s AND n.id = k.i`,
      [keys.map((k) => k.source), keys.map((k) => k.id)],
    );
    return rows;
  }

  /** A channel's recent deliveries, newest first. */
  async deliveries(
    channelId: string,
    before: string | undefined,
    limit: number,
  ): Promise<DeliveryRow[]> {
    const { rows } = await this.#pool.query<DeliveryRow>(
      `SELECT ${DELIVERY} FROM app.deliveries
        WHERE channel_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint)
        ORDER BY id DESC LIMIT $3`,
      [channelId, before ?? null, limit],
    );
    return rows;
  }

  // Channels

  async channels(): Promise<ChannelRow[]> {
    const { rows } = await this.#pool.query<ChannelRow>(
      `SELECT ${CHANNEL} FROM app.channels ORDER BY id`,
    );
    return rows;
  }

  async channel(id: string): Promise<ChannelRow | null> {
    if (!/^\d+$/.test(id)) return null;
    const { rows } = await this.#pool.query<ChannelRow>(
      `SELECT ${CHANNEL} FROM app.channels WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** Each channel's backlog and how its deliveries are going. */
  async channelStates(): Promise<ChannelStateRow[]> {
    const { rows } = await this.#pool.query<ChannelStateRow>(
      `SELECT c.id::text AS channel_id,
              count(d.id) FILTER (WHERE d.delivered_at IS NULL)::int AS backlog,
              min(d.created_at) FILTER (WHERE d.delivered_at IS NULL) AS oldest_pending_at,
              max(d.delivered_at) AS last_delivered_at,
              (SELECT last_error FROM app.deliveries e
                WHERE e.channel_id = c.id AND e.last_error IS NOT NULL
                  AND e.delivered_at IS NULL
                ORDER BY e.id DESC LIMIT 1) AS last_error,
              min(d.created_at) FILTER (
                WHERE d.delivered_at IS NULL AND d.attempts > 0) AS failing_since
         FROM app.channels c
         LEFT JOIN app.deliveries d ON d.channel_id = c.id
        GROUP BY c.id`,
    );
    return rows;
  }

  async createChannel(channel: Omit<ChannelRow, "id">): Promise<string> {
    const { rows } = await this.#pool.query<{ id: string }>(
      `INSERT INTO app.channels
         (name, type, enabled, kinds, min_severity, storm_limit, settings)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text`,
      [
        channel.name,
        channel.type,
        channel.enabled,
        channel.kinds,
        channel.min_severity,
        channel.storm_limit,
        JSON.stringify(channel.settings),
      ],
    );
    return rows[0]!.id;
  }

  async updateChannel(id: string, channel: Omit<ChannelRow, "id">) {
    await this.#pool.query(
      `UPDATE app.channels
          SET name = $2, type = $3, enabled = $4, kinds = $5, min_severity = $6,
              storm_limit = $7, settings = $8, updated_at = now()
        WHERE id = $1`,
      [
        id,
        channel.name,
        channel.type,
        channel.enabled,
        channel.kinds,
        channel.min_severity,
        channel.storm_limit,
        JSON.stringify(channel.settings),
      ],
    );
  }

  /** Removes a channel and what it had not yet delivered; returns how many. */
  async deleteChannel(id: string): Promise<number> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const dropped = await client.query(
        "DELETE FROM app.deliveries WHERE channel_id = $1 AND delivered_at IS NULL",
        [id],
      );
      await client.query("DELETE FROM app.channels WHERE id = $1", [id]);
      await client.query("COMMIT");
      return dropped.rowCount ?? 0;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // Settings

  async urls(): Promise<{
    dashboard: string | null;
    heartbeat: string | null;
  }> {
    const { rows } = await this.#pool.query<{ key: string; value: unknown }>(
      "SELECT key, value FROM app.settings WHERE key = ANY($1::text[])",
      [[DASHBOARD_URL, HEARTBEAT_URL]],
    );
    const read = (key: string) => {
      const value = rows.find((r) => r.key === key)?.value;
      return typeof value === "string" && value ? value : null;
    };
    return { dashboard: read(DASHBOARD_URL), heartbeat: read(HEARTBEAT_URL) };
  }

  async setUrls(urls: { dashboard: string | null; heartbeat: string | null }) {
    await this.#pool.query(
      `INSERT INTO app.settings (key, value)
       SELECT k, v FROM unnest($1::text[], $2::jsonb[]) AS s(k, v)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
      [
        [DASHBOARD_URL, HEARTBEAT_URL],
        [JSON.stringify(urls.dashboard), JSON.stringify(urls.heartbeat)],
      ],
    );
  }
}

/** A notification's time as exact microseconds, which a JavaScript date cannot hold. */
const MICROS = "(extract(epoch FROM n.created_at) * 1000000)::bigint";
