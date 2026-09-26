import { z, type ZodError } from "zod";

// The engine's rule language, version 1, mirrored so a draft can be checked
// while it is built. A rule states the bad condition: it trips when
// `trip_when` is true. The engine validates every document again and stays
// the authority on what a rule is.

/** How far `scale` may shift a value: the engine's number model allows ±77. */
const MAX_SCALE_DECIMALS = 77;

const DECIMAL = /^-?\d+(\.\d+)?$/;

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

const PARAMS = `(?:${ABI_TYPE}(?:,${ABI_TYPE})*)?`;

/** A bare signature with positional types: "transfer(address,uint256)". */
export const functionSignature = z
  .string()
  .regex(
    new RegExp(`^${NAME}\\(${PARAMS}\\)$`),
    'must be a bare signature, like "transfer(address,uint256)"',
  );

/**
 * A signature whose return value is read, so it declares what it returns:
 * "getReserves() returns (uint112,uint112,uint32)".
 */
export const readSignature = z
  .string()
  .regex(
    new RegExp(
      `^${NAME}\\(${PARAMS}\\) returns \\(${ABI_TYPE}(?:,${ABI_TYPE})*\\)$`,
    ),
    'must declare what it returns, like "totalSupply() returns (uint256)"',
  );

export interface Signature {
  name: string;
  params: string[];
  returns: string[];
}

/** Splits a bare or read signature into its name, parameters and returns. */
export function parseSignature(signature: string): Signature {
  const match = /^([^(]*)\(([^)]*)\)(?: returns \(([^)]*)\))?$/.exec(signature);
  const list = (text?: string) => (text ? text.split(",") : []);
  return {
    name: match?.[1] ?? signature,
    params: list(match?.[2]),
    returns: list(match?.[3]),
  };
}

/** The part of a signature people read: "getReserves()" for a declared read. */
export function shortSignature(signature: string): string {
  return signature.replace(/ returns \(.*\)$/, "");
}

/** What the engine's evaluator types a value as. */
export type ValueType = "numeric" | "address" | "bool" | "bytes" | "string";

export function valueTypeOf(abiType: string): ValueType {
  if (/^u?int/.test(abiType)) return "numeric";
  if (abiType.startsWith("bytes")) return "bytes";
  return abiType as ValueType;
}

/** Why a literal does not fit a parameter of this ABI type, or null when it does. */
export function literalProblem(type: string, value: string): string | null {
  const int = /^(u?)int(\d*)$/.exec(type);
  if (int) {
    const unsigned = int[1] === "u";
    const bits = BigInt(int[2] || "256");
    if (!(unsigned ? /^\d+$/ : /^-?\d+$/).test(value)) {
      return unsigned
        ? "must be a whole number"
        : "must be a whole number, which may be negative";
    }
    const n = BigInt(value);
    const max = unsigned ? 2n ** bits - 1n : 2n ** (bits - 1n) - 1n;
    const min = unsigned ? 0n : -(2n ** (bits - 1n));
    return n > max || n < min ? `is out of range for ${type}` : null;
  }
  if (type === "address") {
    return /^0x[0-9a-fA-F]{40}$/.test(value)
      ? null
      : "must be a 0x address with 40 hex digits";
  }
  if (type === "bool") {
    return value === "true" || value === "false"
      ? null
      : 'must be "true" or "false"';
  }
  if (type === "string") return null;
  const fixed = /^bytes(\d+)$/.exec(type);
  if (fixed) {
    const digits = Number(fixed[1]) * 2;
    return new RegExp(`^0x[0-9a-fA-F]{${digits}}$`).test(value)
      ? null
      : `must be 0x and ${digits} hex digits`;
  }
  if (type === "bytes") {
    return /^0x([0-9a-fA-F]{2})*$/.test(value)
      ? null
      : "must be 0x hex, two digits per byte";
  }
  return `has a type rules cannot take: ${type}`;
}

const EVENT_PARAM = `${ABI_TYPE}(?: indexed)? ${NAME}`;

/** A declaration-style event signature with names and indexed markers. */
export const eventSignature = z
  .string()
  .regex(
    new RegExp(`^${NAME}\\((?:${EVENT_PARAM}(?:, ${EVENT_PARAM})*)?\\)$`),
    'must name its parameters, like "Transfer(address indexed from, address indexed to, uint256 value)"',
  );

/** The parameters of a declaration-style event signature, by name, with their types. */
export function eventParams(signature: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(eventParamsIndexed(signature)).map(([n, p]) => [n, p.type]),
  );
}

/** Each named parameter's type, and whether it is indexed. */
function eventParamsIndexed(
  signature: string,
): Record<string, { type: string; indexed: boolean }> {
  const params = signature.slice(signature.indexOf("(") + 1, -1);
  if (!params) return {};
  return Object.fromEntries(
    params.split(",").map((p) => {
      const words = p.trim().split(" ");
      return [
        words.at(-1)!,
        { type: words[0]!, indexed: words.includes("indexed") },
      ];
    }),
  );
}

/**
 * An indexed string or bytes argument is on chain only as its hash, so
 * its value can be neither read nor compared.
 */
const hashedOnly = (p: { type: string; indexed: boolean }) =>
  p.indexed && (p.type === "string" || p.type === "bytes");

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
  /** Declares what it returns: "totalSupply() returns (uint256)". */
  function: string;
  args: string[];
  /** Selects one output of a function that returns several. */
  returns?: number;
}

/** A simulated call; its function declares its returns when the value is read. */
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
  function: readSignature,
  args: z.array(z.string()),
  returns: returns.optional(),
});

const simulatedCall = (fn: typeof functionSignature) =>
  z.strictObject({
    from: address.optional(),
    address: address.optional(),
    function: fn,
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
    // A literal takes the type its position expects: a decimal string
    // against a number, or an address, bool or bytes literal against one.
    // Its shape is checked here; its fit to the position, once the rule
    // parses.
    z.strictObject({
      node: z.literal("literal"),
      value: z
        .string()
        .regex(
          /^(-?\d+(\.\d+)?|0x[0-9a-fA-F]*|true|false)$/,
          'must be a decimal string, like "1.5", or an address, bool or bytes value',
        ),
    }),
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
      decimals: z
        .number()
        .int()
        .min(-MAX_SCALE_DECIMALS, `must stay within ±${MAX_SCALE_DECIMALS}`)
        .max(MAX_SCALE_DECIMALS, `must stay within ±${MAX_SCALE_DECIMALS}`),
    }),
    z.strictObject({ node: z.literal("now") }),
    metric,
    z.strictObject({
      node: z.literal("simulate"),
      call: simulatedCall(readSignature),
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
        call: simulatedCall(functionSignature),
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
  z.strictObject({
    action: z.literal("call"),
    call: z.strictObject({
      /** Defaults to the rule's contract. */
      address: address.nullable().optional(),
      function: functionSignature,
      args: z.array(z.string()),
      /** Wei sent along; defaults to "0". */
      value: z
        .string()
        .regex(/^\d+$/, "must be a whole number of wei")
        .optional(),
      /** States that the call's effect is in place, such as paused() reading true. */
      verify: boolNode.optional(),
    }),
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

type Path = (string | number)[];
type Report = (path: Path, message: string) => void;

interface Checking {
  issue: Report;
  /** The trigger event's parameters and their types; null for every_block. */
  events: Record<string, { type: string; indexed: boolean }> | null;
  /** Checking `call.verify`, which must be readable at any block. */
  verify: boolean;
}

/** Arguments must match the signature's parameters, each a literal of its type. */
function checkArgs(fn: string, args: string[], path: Path, issue: Report) {
  const { params } = parseSignature(fn);
  if (args.length !== params.length) {
    issue(
      [...path, "args"],
      `needs ${params.length} argument${params.length === 1 ? "" : "s"} for ${shortSignature(fn)}`,
    );
    return;
  }
  params.forEach((type, i) => {
    const problem = literalProblem(type, args[i]!);
    if (problem) issue([...path, "args", i], problem);
  });
}

/** The value a read selects from what its signature declares it returns. */
function readType(
  fn: string,
  index: number | undefined,
  path: Path,
  issue: Report,
): ValueType | "any" {
  const declared = parseSignature(fn).returns;
  const selected = declared[index ?? 0];
  if (!selected) {
    issue([...path, "returns"], `is beyond what ${shortSignature(fn)} returns`);
    return "any";
  }
  return valueTypeOf(selected);
}

/** A value node's type; literals take the type their position expects. */
function checkValue(n: ValueNode, path: Path, c: Checking): ValueType | "any" {
  const numeric = (child: ValueNode, at: Path) => {
    const type = checkValue(child, at, c);
    checkLiteral(child, at, "numeric", c);
    if (type !== "any" && type !== "numeric") {
      c.issue(at, `must be a number, not ${type}`);
    }
  };
  switch (n.node) {
    case "view_call":
      checkArgs(n.function, n.args, path, c.issue);
      return readType(n.function, n.returns, path, c.issue);
    case "simulate":
      checkArgs(n.call.function, n.call.args, [...path, "call"], c.issue);
      return readType(n.call.function, n.returns, path, c.issue);
    case "literal":
      return "any";
    case "event_arg": {
      if (c.verify) {
        c.issue(path, "cannot read an event argument here");
        return "any";
      }
      if (!c.events) {
        c.issue(path, "reads an event argument without an event trigger");
        return "any";
      }
      const param = c.events[n.arg];
      if (!param) {
        c.issue(
          [...path, "arg"],
          `reads "${n.arg}", which the event does not have`,
        );
        return "any";
      }
      if (hashedOnly(param)) {
        c.issue(
          [...path, "arg"],
          `"${n.arg}" is an indexed ${param.type}: only its hash appears on chain, so its value cannot be read`,
        );
        return "any";
      }
      return valueTypeOf(param.type);
    }
    case "now":
      return "numeric";
    case "arithmetic":
      numeric(n.left, [...path, "left"]);
      numeric(n.right, [...path, "right"]);
      return "numeric";
    case "sum":
      n.terms.forEach((t, i) => numeric(t, [...path, "terms", i]));
      return "numeric";
    case "scale":
      numeric(n.expr, [...path, "expr"]);
      return "numeric";
    case "metric":
      if (c.verify) c.issue(path, "cannot use a metric here");
      numeric(n.of, [...path, "of"]);
      return "numeric";
  }
}

/**
 * A literal holds the form of the type its position expects: a decimal
 * against a number, an address, bool or bytes literal against those.
 */
function checkLiteral(
  n: ValueNode,
  at: Path,
  expected: ValueType | "any",
  c: Checking,
) {
  if (n.node !== "literal") return;
  const problem =
    expected === "numeric" || expected === "any"
      ? DECIMAL.test(n.value)
        ? null
        : 'must be a decimal string, like "1.5"'
      : literalProblem(expected, n.value);
  if (problem) c.issue([...at, "value"], problem);
}

function checkBool(n: BoolNode, path: Path, c: Checking) {
  if (n === true) return;
  const numeric = (child: ValueNode, at: Path) => {
    const type = checkValue(child, at, c);
    checkLiteral(child, at, "numeric", c);
    if (type !== "any" && type !== "numeric") {
      c.issue(at, `must be a number, not ${type}`);
    }
  };
  switch (n.node) {
    case "compare":
      if (n.op === "eq" || n.op === "ne") {
        const left = checkValue(n.left, [...path, "left"], c);
        const right = checkValue(n.right, [...path, "right"], c);
        checkLiteral(n.left, [...path, "left"], right, c);
        checkLiteral(n.right, [...path, "right"], left, c);
        if (left !== "any" && right !== "any" && left !== right) {
          c.issue(path, `compares ${left} with ${right}`);
        }
      } else {
        numeric(n.left, [...path, "left"]);
        numeric(n.right, [...path, "right"]);
      }
      return;
    case "deviation_band":
      numeric(n.value, [...path, "value"]);
      numeric(n.center, [...path, "center"]);
      return;
    case "simulate":
      checkArgs(n.call.function, n.call.args, [...path, "call"], c.issue);
      return;
    case "and":
    case "or":
      n.terms.forEach((t, i) => checkBool(t, [...path, "terms", i], c));
      return;
    case "not":
      checkBool(n.expr, [...path, "expr"], c);
      return;
  }
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
    walk(r.trip_when, (n, d) => {
      depth = Math.max(depth, d);
      nodes += 1;
      if (n !== true && (n.node === "view_call" || n.node === "simulate")) {
        calls += 1;
      }
    });
    const issue: Report = (path, message) =>
      ctx.addIssue({ code: "custom", path, message });
    if (depth > MAX_DEPTH) issue(["trip_when"], `is deeper than ${MAX_DEPTH}`);
    if (nodes > MAX_NODES) {
      issue(["trip_when"], `has more than ${MAX_NODES} nodes`);
    }
    if (calls > MAX_CALLS) {
      issue(["trip_when"], `makes more than ${MAX_CALLS} calls`);
    }

    const events =
      r.when === "every_block" ? null : eventParamsIndexed(r.when.event);
    checkBool(r.trip_when, ["trip_when"], { issue, events, verify: false });

    if (r.when !== "every_block") {
      r.when.filters?.forEach((filter, i) => {
        const param = events![filter.arg];
        if (!param) {
          issue(
            ["when", "filters", i, "arg"],
            `"${filter.arg}" is not an argument of the event`,
          );
        } else if (hashedOnly(param)) {
          issue(
            ["when", "filters", i, "arg"],
            `"${filter.arg}" is an indexed ${param.type}: only its hash appears on chain, so its value cannot be compared`,
          );
        } else {
          const problem = literalProblem(param.type, filter.eq);
          if (problem) issue(["when", "filters", i, "eq"], problem);
        }
      });
    }

    if (r.on_trip.action === "call") {
      const call = r.on_trip.call;
      checkArgs(call.function, call.args, ["on_trip", "call"], issue);
      if (call.verify !== undefined) {
        checkBool(call.verify, ["on_trip", "call", "verify"], {
          issue,
          events: null,
          verify: true,
        });
      }
    }
  });
export type Rule = z.infer<typeof rule>;

/** A validation problem, located by a JSON pointer into the document. */
export interface Issue {
  code: string;
  message: string;
  path: string;
}

/** The parts of a Zod issue these reports read. */
interface RawIssue {
  code: string;
  message: string;
  path: PropertyKey[];
  errors?: RawIssue[][];
  keys?: string[];
  values?: unknown[];
  options?: unknown[];
  discriminator?: string;
}

const pointer = (path: PropertyKey[]) =>
  path.map((key) => `/${String(key)}`).join("");

/**
 * Zod's issues as located problems. Where a node could have been one of
 * several things, the alternative that got furthest says what is wrong,
 * so an agent or the JSON editor is pointed at the field itself.
 */
function located(issue: RawIssue, base: PropertyKey[]): Issue[] {
  const path = [...base, ...issue.path];
  if (issue.code === "invalid_union" && issue.discriminator) {
    return [
      {
        code: "unknown_node",
        message: `is not a node type here; expected one of: ${(issue.options ?? []).join(", ")}`,
        path: pointer(path),
      },
    ];
  }
  if (issue.code === "invalid_union" && issue.errors?.length) {
    const reach = (branch: RawIssue[]) =>
      Math.max(...branch.map((i) => i.path.length));
    const best = issue.errors.reduce((a, b) => (reach(b) > reach(a) ? b : a));
    // A node of the wrong kind is said once, at the node.
    const wrongNode = best.find(
      (i) => i.code === "invalid_value" && i.path.at(-1) === "node",
    );
    if (wrongNode) {
      return [
        {
          code: "wrong_node",
          message: `must be a ${(wrongNode.values ?? []).join(" or ")} node`,
          path: pointer([...path, ...wrongNode.path.slice(0, -1)]),
        },
      ];
    }
    return best.flatMap((i) => located(i, path));
  }
  if (issue.code === "unrecognized_keys" && issue.keys) {
    return issue.keys.map((key) => ({
      code: issue.code,
      message: "is not a field here",
      path: pointer([...path, key]),
    }));
  }
  return [{ code: issue.code, message: issue.message, path: pointer(path) }];
}

export function issuesOf(error: ZodError): Issue[] {
  return error.issues.flatMap((issue) =>
    located(issue as unknown as RawIssue, []),
  );
}
