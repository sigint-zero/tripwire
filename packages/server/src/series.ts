import {
  issuesOf,
  type SeriesBucket,
  type SeriesWindow,
  type Sparkline,
} from "@tripwire/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import type { BucketRow, EngineReads } from "./engine/types";
import { refuse } from "./refuse";
import { firstSeries } from "./rule-series";

// A series over a window: its points when there are few, else buckets
// cut on the server with min and max kept, so a one-block spike shows at
// any zoom and a month of blocks never travels to the browser.

const MAX_POINTS = 500;
const DAY_MS = 86_400_000;
const SPARK_BUCKETS = 48;
const SPARK_WINDOWS: Record<string, number> = {
  "1h": 3_600_000,
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
};

const window = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  points: z.coerce.number().int().min(2).max(MAX_POINTS).optional(),
});
const sparks = z.object({
  rules: z
    .string()
    .regex(/^\d+(,\d+)*$/, "must be rule ids separated by commas")
    .transform((s) => [...new Set(s.split(","))])
    .refine((ids) => ids.length <= 200, "at most 200 rules"),
  window: z.enum(["1h", "24h", "7d"]).optional(),
});

/** Buckets as the API sends them, each starting where its stretch does. */
function toBuckets(
  rows: BucketRow[],
  from: Date,
  width: number,
): SeriesBucket[] {
  return rows.map((b) => ({
    start: new Date(from.getTime() + b.bucket * width).toISOString(),
    first: b.first,
    last: b.last,
    min: b.min,
    max: b.max,
    count: b.count,
  }));
}

export const seriesRoutes: FastifyPluginCallback<{ reads: EngineReads }> = (
  app,
  { reads },
  done,
) => {
  app.get<{ Params: { id: string } }>(
    "/series/:id/points",
    async (request, reply): Promise<SeriesWindow | undefined> => {
      const params = window.safeParse(request.query);
      if (!params.success) {
        return refuse(reply, 400, "invalid_request", "Invalid window.", {
          issues: issuesOf(params.error),
        });
      }
      const series = await reads.seriesById(request.params.id);
      if (!series) {
        return refuse(reply, 404, "not_found", "No such series.");
      }
      const to = params.data.to ? new Date(params.data.to) : new Date();
      const from = params.data.from
        ? new Date(params.data.from)
        : new Date(to.getTime() - DAY_MS);
      if (from >= to) {
        return refuse(reply, 400, "invalid_request", "from must be before to.");
      }
      const points = params.data.points ?? MAX_POINTS;
      // Points alone only when nothing in the window has been rolled up.
      const held = await reads.countPoints(series.id, from, to);
      if (held.rollups === 0 && held.raw <= points) {
        const rows = await reads.points(series.id, from, to, points);
        return {
          resolution: "block",
          points: rows.map((p) => ({
            blockNumber: p.block_number,
            blockTime: p.block_time,
            value: p.value,
          })),
        };
      }
      const width = (to.getTime() - from.getTime()) / points;
      const rows = await reads.buckets([series.id], from, to, points);
      return {
        resolution: `${Math.round(width / 1000)}s`,
        buckets: toBuckets(rows, from, width),
      };
    },
  );

  // One request for every visible row: a list of fifty rules costs the
  // same few reads as a list of one.
  app.get(
    "/sparklines",
    async (request, reply): Promise<Sparkline[] | undefined> => {
      const params = sparks.safeParse(request.query);
      if (!params.success) {
        return refuse(reply, 400, "invalid_request", "Invalid query.", {
          issues: issuesOf(params.error),
        });
      }
      const first = await firstSeries(reads, params.data.rules);
      const to = new Date();
      const span = SPARK_WINDOWS[params.data.window ?? "24h"]!;
      const from = new Date(to.getTime() - span);
      const rows = await reads.buckets(
        [...new Set(first.values())],
        from,
        to,
        SPARK_BUCKETS,
      );
      const width = span / SPARK_BUCKETS;
      return [...first].map(([ruleId, seriesId]) => ({
        ruleId,
        seriesId,
        buckets: toBuckets(
          rows.filter((b) => b.series_id === seriesId),
          from,
          width,
        ),
      }));
    },
  );

  done();
};
