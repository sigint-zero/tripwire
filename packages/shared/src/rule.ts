import { z } from "zod";

// The rule language. An invariant holds while its rule's condition is true;
// the engine records a violation when the condition becomes false.

const UINT256_MAX = 2n ** 256n - 1n;

const WHOLE_NUMBER = /^(0x[0-9a-fA-F]+|[0-9]+)$/;

/** An unsigned 256-bit integer, written in decimal or 0x-hex. */
export const uint256 = z
  .string()
  .trim()
  .regex(WHOLE_NUMBER, "must be a whole number")
  .refine(
    (value) => !WHOLE_NUMBER.test(value) || BigInt(value) <= UINT256_MAX,
    "is too large",
  );

export const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address with 40 hex digits");

export const functionSignature = z
  .string()
  .trim()
  .regex(/^[A-Za-z_$][\w$]*\(.*\)$/, 'must look like "totalSupply()"');

const wholeSeconds = z.number().int().positive();

export type HistoricalMetric =
  | { type: "ath" }
  | { type: "prev_block" }
  | { type: "moving_avg"; window: number }
  | { type: "twap"; window_secs: number }
  | { type: "windowed_delta"; window_secs: number }
  | { type: "windowed_drop"; window_secs: number };

export const historicalMetric: z.ZodType<HistoricalMetric> =
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("ath") }),
    z.object({ type: z.literal("prev_block") }),
    z.object({
      type: z.literal("moving_avg"),
      window: z.number().int().positive(),
    }),
    z.object({ type: z.literal("twap"), window_secs: wholeSeconds }),
    z.object({ type: z.literal("windowed_delta"), window_secs: wholeSeconds }),
    z.object({ type: z.literal("windowed_drop"), window_secs: wholeSeconds }),
  ]);

export type ArgExpr =
  | { type: "literal"; abi_type: string; value: string }
  | { type: "address"; value: string }
  | { type: "expr"; expr: ValueExpr };

export type ValueExpr =
  | {
      type: "view_call";
      contract: string;
      method: string;
      args?: ArgExpr[];
      return_index?: number;
    }
  | { type: "literal"; value: string }
  | {
      type: "arithmetic";
      op: "add" | "sub" | "mul" | "div";
      left: ValueExpr;
      right: ValueExpr;
    }
  | { type: "sum"; operands: ValueExpr[] }
  | {
      type: "historical";
      key: string;
      source: ValueExpr;
      metric: HistoricalMetric;
    }
  | {
      type: "scale";
      value: ValueExpr;
      numerator: number;
      denominator: number;
    }
  | { type: "now" };

const argExpr: z.ZodType<ArgExpr> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("literal"),
      abi_type: z.string().min(1),
      value: z.string(),
    }),
    z.object({ type: z.literal("address"), value: address }),
    z.object({ type: z.literal("expr"), expr: valueExpr }),
  ]),
);

export const valueExpr: z.ZodType<ValueExpr> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("view_call"),
      contract: address,
      method: functionSignature,
      args: z.array(argExpr).optional(),
      return_index: z.number().int().nonnegative().optional(),
    }),
    z.object({ type: z.literal("literal"), value: uint256 }),
    z.object({
      type: z.literal("arithmetic"),
      op: z.enum(["add", "sub", "mul", "div"]),
      left: valueExpr,
      right: valueExpr,
    }),
    z.object({ type: z.literal("sum"), operands: z.array(valueExpr).min(1) }),
    z.object({
      type: z.literal("historical"),
      key: z.string().trim().min(1),
      source: valueExpr,
      metric: historicalMetric,
    }),
    z.object({
      type: z.literal("scale"),
      value: valueExpr,
      numerator: z.number().int().nonnegative(),
      denominator: z.number().int().positive(),
    }),
    z.object({ type: z.literal("now") }),
  ]),
);

export type CompareOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";

export type Condition =
  | { type: "compare"; op: CompareOp; left: ValueExpr; right: ValueExpr }
  | {
      type: "deviation_band";
      value: ValueExpr;
      center: ValueExpr;
      band_percent: number;
      downward_only?: boolean;
      upward_only?: boolean;
    }
  | { type: "and"; conditions: Condition[] }
  | { type: "or"; conditions: Condition[] }
  | { type: "not"; condition: Condition };

export const condition: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("compare"),
      op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte"]),
      left: valueExpr,
      right: valueExpr,
    }),
    z.object({
      type: z.literal("deviation_band"),
      value: valueExpr,
      center: valueExpr,
      band_percent: z.number().int().nonnegative(),
      downward_only: z.boolean().optional(),
      upward_only: z.boolean().optional(),
    }),
    z.object({ type: z.literal("and"), conditions: z.array(condition).min(1) }),
    z.object({ type: z.literal("or"), conditions: z.array(condition).min(1) }),
    z.object({ type: z.literal("not"), condition }),
  ]),
);

const topic = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte 0x value");

export const logMatch = z.object({
  topic1: topic.optional(),
  topic2: topic.optional(),
  topic3: topic.optional(),
  topic1_neq: topic.optional(),
  topic2_neq: topic.optional(),
  topic3_neq: topic.optional(),
  data_gte: uint256.optional(),
  data_lte: uint256.optional(),
});

export const rule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("expression"), condition }),
  z.object({
    kind: z.literal("log"),
    event: z
      .string()
      .trim()
      .regex(/^[A-Za-z_$][\w$]*\(.*\)$/, 'must look like "Paused(address)"'),
    condition: z.enum(["must_not_appear", "must_appear"]),
    match: logMatch.optional(),
  }),
]);
export type Rule = z.infer<typeof rule>;

/** What Tripwire does when the invariant breaks. */
export const response = z.object({
  mode: z.enum(["alert", "approval", "autonomous"]),
  scope: z.discriminatedUnion("type", [
    z.object({ type: z.literal("contract") }),
    z.object({
      type: z.literal("function"),
      selector: z.string().regex(/^0x[0-9a-fA-F]{8}$/, "must be 4 bytes"),
      signature: functionSignature,
    }),
  ]),
  cooldownSecs: z.number().int().nonnegative(),
});
export type Response = z.infer<typeof response>;

export const invariantDraft = z.object({
  name: z.string().trim().min(1, "is required").max(80),
  description: z.string().trim().max(500).optional(),
  chainId: z.number().int().positive(),
  contract: address,
  rule,
  response,
});
export type InvariantDraft = z.infer<typeof invariantDraft>;

export interface Invariant extends InvariantDraft {
  id: string;
  enabled: boolean;
  createdAt: string;
}
