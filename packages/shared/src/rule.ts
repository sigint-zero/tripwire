import { z, type ZodError } from "zod";

// The engine's rule language, version 1, mirrored so a draft can be checked
// while it is built. A rule states the bad condition: it trips when
// `trip_when` is true. The engine validates every document again and stays
// the authority on what a rule is.

/** A decimal string: "5000000", "1.5", "-0.03". */
export const decimal = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string, like "1.5"');

export const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address with 40 hex digits");

const INT_SIZES = Array.from({ length: 32 }, (_, i) => (i + 1) * 8).join("|");
const ABI_TYPE = `(?:u?int(?:${INT_SIZES})?|address|bool|bytes(?:[1-9]|[12][0-9]|3[0-2])?|string)`;
const NAME = "[A-Za-z_$][\\w$]*";

/** Whether version 1 can take a parameter of this ABI type (no arrays or tuples). */
export function isSupportedAbiType(type: string): boolean {
  return new RegExp(`^${ABI_TYPE}$`).test(type);
}

/** A bare signature with positional types: "transfer(address,uint256)". */
export const functionSignature = z
  .string()
  .regex(
    new RegExp(`^${NAME}\\((?:${ABI_TYPE}(?:,${ABI_TYPE})*)?\\)$`),
    'must be a bare signature, like "transfer(address,uint256)"',
  );

const EVENT_PARAM = `${ABI_TYPE}(?: indexed)? ${NAME}`;

/** A declaration-style event signature with names and indexed markers. */
export const eventSignature = z
  .string()
  .regex(
    new RegExp(`^${NAME}\\((?:${EVENT_PARAM}(?:, ${EVENT_PARAM})*)?\\)$`),
    'must name its parameters, like "Transfer(address indexed from, address indexed to, uint256 value)"',
  );

/** The parameter names of a declaration-style event signature. */
export function eventArgNames(signature: string): string[] {
  const params = signature.slice(signature.indexOf("(") + 1, -1);
  return params
    ? params.split(",").map((p) => p.trim().split(" ").at(-1)!)
    : [];
}

export const window = z.strictObject({
  seconds: z
    .number()
    .int()
    .min(60, "must be at least 60 seconds")
    .max(2_592_000, "must be at most 30 days"),
});
export type Window = z.infer<typeof window>;

export type MetricName =
  | "ath"
  | "prev_block"
  | "moving_avg"
  | "twap"
  | "windowed_delta"
  | "windowed_drop";

/** Metrics that read a trailing window; the others need none. */
export const WINDOWED_METRICS: readonly MetricName[] = [
  "moving_avg",
  "twap",
  "windowed_delta",
  "windowed_drop",
];

export interface ViewCall {
  node: "view_call";
  /** Defaults to the rule's contract. */
  address?: string;
  function: string;
  args: string[];
  /** Selects one output of a function that returns several. */
  returns?: number;
}

export interface SimulatedCall {
  from?: string;
  address?: string;
  function: string;
  args: string[];
  value?: string;
}

export type ArithmeticOp = "add" | "sub" | "mul" | "div";

export type ValueNode =
  | ViewCall
  | { node: "literal"; value: string }
  | { node: "event_arg"; arg: string }
  | {
      node: "arithmetic";
      op: ArithmeticOp;
      left: ValueNode;
      right: ValueNode;
    }
  | { node: "sum"; terms: ValueNode[] }
  | { node: "scale"; expr: ValueNode; decimals: number }
  | { node: "now" }
  | { node: "metric"; metric: MetricName; of: ViewCall; window?: Window }
  | {
      node: "simulate";
      call: SimulatedCall;
      yields: "value";
      returns?: number;
    };

export type CompareOp = "eq" | "ne" | "lt" | "le" | "gt" | "ge";

export type BoolNode =
  | { node: "compare"; op: CompareOp; left: ValueNode; right: ValueNode }
  | {
      node: "deviation_band";
      value: ValueNode;
      center: ValueNode;
      tolerance_percent: string;
      sides: "both" | "above" | "below";
    }
  | { node: "simulate"; call: SimulatedCall; yields: "reverted" }
  | { node: "and"; terms: BoolNode[] }
  | { node: "or"; terms: BoolNode[] }
  | { node: "not"; expr: BoolNode }
  | true;

const returns = z.number().int().nonnegative();

export const viewCall = z.strictObject({
  node: z.literal("view_call"),
  address: address.optional(),
  function: functionSignature,
  args: z.array(z.string()),
  returns: returns.optional(),
});

const simulatedCall = z.strictObject({
  from: address.optional(),
  address: address.optional(),
  function: functionSignature,
  args: z.array(z.string()),
  value: decimal.optional(),
});

const metric = z
  .strictObject({
    node: z.literal("metric"),
    metric: z.enum([
      "ath",
      "prev_block",
      "moving_avg",
      "twap",
      "windowed_delta",
      "windowed_drop",
    ]),
    of: viewCall,
    window: window.optional(),
  })
  .superRefine((m, ctx) => {
    const windowed = WINDOWED_METRICS.includes(m.metric);
    if (windowed && !m.window) {
      ctx.addIssue({
        code: "custom",
        path: ["window"],
        message: `is required for ${m.metric}`,
      });
    }
    if (!windowed && m.window) {
      ctx.addIssue({
        code: "custom",
        path: ["window"],
        message: `is not taken by ${m.metric}`,
      });
    }
  });

export const valueNode: z.ZodType<ValueNode> = z.lazy(() =>
  z.discriminatedUnion("node", [
    viewCall,
    z.strictObject({ node: z.literal("literal"), value: decimal }),
    z.strictObject({ node: z.literal("event_arg"), arg: z.string().min(1) }),
    z.strictObject({
      node: z.literal("arithmetic"),
      op: z.enum(["add", "sub", "mul", "div"]),
      left: valueNode,
      right: valueNode,
    }),
    z.strictObject({
      node: z.literal("sum"),
      terms: z.array(valueNode).min(2, "needs at least two terms"),
    }),
    z.strictObject({
      node: z.literal("scale"),
      expr: valueNode,
      decimals: z.number().int(),
    }),
    z.strictObject({ node: z.literal("now") }),
    metric,
    z.strictObject({
      node: z.literal("simulate"),
      call: simulatedCall,
      yields: z.literal("value"),
      returns: returns.optional(),
    }),
  ]),
);

const positive = decimal.refine(
  (value) => !value.startsWith("-") && /[1-9]/.test(value),
  "must be more than 0",
);

export const boolNode: z.ZodType<BoolNode> = z.lazy(() =>
  z.union([
    z.literal(true),
    z.discriminatedUnion("node", [
      z.strictObject({
        node: z.literal("compare"),
        op: z.enum(["eq", "ne", "lt", "le", "gt", "ge"]),
        left: valueNode,
        right: valueNode,
      }),
      z.strictObject({
        node: z.literal("deviation_band"),
        value: valueNode,
        center: valueNode,
        tolerance_percent: positive,
        sides: z.enum(["both", "above", "below"]),
      }),
      z.strictObject({
        node: z.literal("simulate"),
        call: simulatedCall,
        yields: z.literal("reverted"),
      }),
      z.strictObject({
        node: z.literal("and"),
        terms: z.array(boolNode).min(2, "needs at least two terms"),
      }),
      z.strictObject({
        node: z.literal("or"),
        terms: z.array(boolNode).min(2, "needs at least two terms"),
      }),
      z.strictObject({ node: z.literal("not"), expr: boolNode }),
    ]),
  ]),
);

export const trigger = z.union([
  z.literal("every_block"),
  z.strictObject({
    event: eventSignature,
    address: address.nullable().optional(),
    filters: z
      .array(z.strictObject({ arg: z.string().min(1), eq: z.string() }))
      .optional(),
  }),
]);
export type Trigger = z.infer<typeof trigger>;

const cooldown = z.number().int().nonnegative().optional();

/** What the engine does when the rule trips. */
export const onTrip = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("notify"), cooldown_seconds: cooldown }),
  z.strictObject({
    action: z.literal("trip_global"),
    cooldown_seconds: cooldown,
  }),
  z.strictObject({
    action: z.literal("trip_function"),
    function: functionSignature,
    cooldown_seconds: cooldown,
  }),
]);
export type OnTrip = z.infer<typeof onTrip>;

export const severity = z.enum(["info", "warning", "critical"]);
export type Severity = z.infer<typeof severity>;

// The engine's size caps: rules are declarations, not programs.
const MAX_DEPTH = 32;
const MAX_NODES = 256;
const MAX_CALLS = 32;

type AnyNode = ValueNode | BoolNode | ViewCall;

function children(n: AnyNode): AnyNode[] {
  if (n === true) return [];
  switch (n.node) {
    case "compare":
    case "arithmetic":
      return [n.left, n.right];
    case "deviation_band":
      return [n.value, n.center];
    case "and":
    case "or":
    case "sum":
      return n.terms;
    case "not":
    case "scale":
      return [n.expr];
    case "metric":
      return [n.of];
    default:
      return [];
  }
}

function walk(
  n: AnyNode,
  visit: (n: AnyNode, depth: number) => void,
  depth = 1,
) {
  visit(n, depth);
  for (const child of children(n)) walk(child, visit, depth + 1);
}

export const rule = z
  .strictObject({
    version: z.literal(1),
    name: z.string().trim().min(1, "is required").max(120),
    description: z.string().optional(),
    contract: address,
    severity,
    when: trigger,
    trip_when: boolNode,
    on_trip: onTrip,
  })
  .superRefine((r, ctx) => {
    let depth = 0;
    let nodes = 0;
    let calls = 0;
    const args: string[] = [];
    walk(r.trip_when, (n, d) => {
      depth = Math.max(depth, d);
      nodes += 1;
      if (n === true) return;
      if (n.node === "view_call" || n.node === "simulate") calls += 1;
      if (n.node === "event_arg") args.push(n.arg);
    });
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    if (depth > MAX_DEPTH) issue(["trip_when"], `is deeper than ${MAX_DEPTH}`);
    if (nodes > MAX_NODES) {
      issue(["trip_when"], `has more than ${MAX_NODES} nodes`);
    }
    if (calls > MAX_CALLS) {
      issue(["trip_when"], `makes more than ${MAX_CALLS} calls`);
    }

    if (r.when === "every_block") {
      if (args.length) {
        issue(
          ["trip_when"],
          "reads an event argument without an event trigger",
        );
      }
      return;
    }
    const names = eventArgNames(r.when.event);
    for (const arg of args) {
      if (!names.includes(arg)) {
        issue(["trip_when"], `reads "${arg}", which the event does not have`);
      }
    }
    r.when.filters?.forEach((filter, i) => {
      if (!names.includes(filter.arg)) {
        issue(
          ["when", "filters", i, "arg"],
          `"${filter.arg}" is not an argument of the event`,
        );
      }
    });
  });
export type Rule = z.infer<typeof rule>;

/** A validation problem, located by a JSON pointer into the document. */
export interface Issue {
  code: string;
  message: string;
  path: string;
}

export function issuesOf(error: ZodError): Issue[] {
  return error.issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: issue.path.map((key) => `/${String(key)}`).join(""),
  }));
}
