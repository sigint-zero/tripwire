import {
  issuesOf,
  type RulePreview,
  type SeriesBucket,
  type SeriesWindow,
  type Sparkline,
} from "@tripwire/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import type { BucketRow, EngineCommands, EngineReads } from "./engine/types";
import { refuse } from "./refuse";
import { firstSeries, seriesByRule } from "./rule-series";

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
// 64 rules × 3 series × 48 buckets stays inside the bucket read's rows.
const PREVIEW_RULES = 64;
const PREVIEW_SERIES = 3;
const previews = z.object({
  rules: z
    .string()
    .regex(/^\d+(,\d+)*$/, "must be rule ids separated by commas")
    .transform((s) => [...new Set(s.split(","))])
    .refine(
      (ids) => ids.length <= PREVIEW_RULES,
      `at most ${PREVIEW_RULES} rules`,
    ),
  window: z.enum(["1h", "24h", "7d"]).optional(),
});

/** A no-argument `decimals()` in an ABI, as a read names it, or null. */
function decimalsCall(abi: unknown[] | null): string | null {
  for (const item of abi ?? []) {
    const f = item as {
      type?: string;
      name?: string;
      inputs?: unknown[];
      outputs?: { type?: string }[];
    };
    const out = f.outputs?.[0]?.type;
    if (
      f.type === "function" &&
      f.name === "decimals" &&
      (f.inputs?.length ?? 0) === 0 &&
      f.outputs?.length === 1 &&
      out &&
      /^uint\d*$/.test(out)
    ) {
      return `decimals() returns (${out})`;
    }
  }
  return null;
}

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

export const seriesRoutes: FastifyPluginCallback<{
  reads: EngineReads;
  commands: EngineCommands;
}> = (app, { reads, commands }, done) => {
  // A contract's decimals, read once through the engine and kept while the
  // server runs; null when it has none. A read that failed is not kept, so
  // it is tried again on the next request.
  const decimals = new Map<string, number | null>();
  const decimalsOf = async (addresses: string[]) => {
    const missing = addresses.filter((a) => !decimals.has(a));
    await Promise.all(
      missing.map(async (address) => {
        const call = decimalsCall((await reads.contract(address))?.abi ?? null);
        if (!call) return decimals.set(address, null);
        try {
          const [value] = await commands.read([
            { address, function: call, args: [] },
          ]);
          const n = Number(value);
          decimals.set(
            address,
            Number.isInteger(n) && n >= 0 && n <= 77 ? n : null,
          );
        } catch {
          // The engine is starting or stopped: no scale this time.
        }
      }),
    );
    return Object.fromEntries(
      addresses.flatMap((a) => {
        const d = decimals.get(a);
        return d === undefined || d === null ? [] : [[a, d]];
      }),
    );
  };

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

  // Everything a page of rule previews draws, in a fixed number of reads
  // however many rules are on it.
  app.get(
    "/previews",
    async (request, reply): Promise<RulePreview[] | undefined> => {
      const params = previews.safeParse(request.query);
      if (!params.success) {
        return refuse(reply, 400, "invalid_request", "Invalid query.", {
          issues: issuesOf(params.error),
        });
      }
      const ids = params.data.rules;
      const [byRule, tripped] = await Promise.all([
        seriesByRule(reads, ids),
        reads.lastTripped(ids),
      ]);
      const kept = new Map(
        [...byRule].map(([id, list]) => [id, list.slice(0, PREVIEW_SERIES)]),
      );
      const seriesIds = [
        ...new Set([...kept.values()].flat().map((s) => s.id)),
      ];
      const to = new Date();
      const span = SPARK_WINDOWS[params.data.window ?? "24h"]!;
      const from = new Date(to.getTime() - span);
      const addresses = [
        ...new Set(
          [...kept.values()].flat().map((s) => s.call.address.toLowerCase()),
        ),
      ];
      const [rows, newest, scales] = await Promise.all([
        reads.buckets(seriesIds, from, to, SPARK_BUCKETS),
        reads.newestPoints(seriesIds),
        decimalsOf(addresses),
      ]);
      const width = span / SPARK_BUCKETS;
      return ids.map((ruleId) => {
        const series = kept.get(ruleId) ?? [];
        const fired = tripped.find((t) => t.rule_id === ruleId);
        return {
          ruleId,
          series,
          buckets: Object.fromEntries(
            series.map((s) => [
              s.id,
              toBuckets(
                rows.filter((b) => b.series_id === s.id),
                from,
                width,
              ),
            ]),
          ),
          latest: Object.fromEntries(
            series.flatMap((s) => {
              const p = newest.find((n) => n.series_id === s.id);
              return p
                ? [
                    [
                      s.id,
                      {
                        value: p.value,
                        blockNumber: p.block_number,
                        blockTime: new Date(p.block_time).toISOString(),
                      },
                    ],
                  ]
                : [];
            }),
          ),
          decimals: Object.fromEntries(
            series
              .map((s) => s.call.address.toLowerCase())
              .filter((a) => a in scales)
              .map((a) => [a, scales[a]!]),
          ),
          lastFired: fired
            ? {
                blockNumber: fired.block_number,
                blockTime: new Date(fired.block_time).toISOString(),
              }
            : null,
        };
      });
    },
  );

  done();
};
