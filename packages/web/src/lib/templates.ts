import type {
  CompareOp,
  Rule,
  Severity,
  ValueNode,
  ViewCall,
} from "@tripwire/shared";
import { parseReadableId, readableId, type ContractSurface } from "./abi";

// Starting points for rules. Each is a sentence with blanks that says what
// must stay true, and turns the filled-in blanks into the rule's trigger and
// its trip condition, which states the violation.

export type FieldKind =
  "read" | "readOrNumber" | "percent" | "duration" | "event" | "op";

export interface Field {
  key: string;
  kind: FieldKind;
  label: string;
  /** Preferred ABI names for the default pick, best first. */
  prefer?: RegExp[];
  /** Names that make this template a strong fit for the contract. */
  suggest?: RegExp[];
  initial?: string;
}

export type Part = string | { field: string };
export type Values = Record<string, string>;

/** The parts of a rule a template fills in. */
export type Watch = Pick<Rule, "when" | "trip_when">;

export interface Template {
  id: string;
  title: string;
  blurb: string;
  needs: "reads" | "events";
  /** How serious a trip usually is for this kind of rule. */
  severity: Severity;
  fields: Field[];
  sentence: Part[];
  build: (values: Values) => Watch | null;
  /**
   * The blanks a document was built from, if it has this template's shape.
   * A loose reading: `recoverTemplate` keeps it only when building from it
   * gives the same document back.
   */
  readBack: (watch: Watch) => Values | null;
  defaultName: (values: Values, labelOf: (id: string) => string) => string;
}

/** A readOrNumber field holding a typed number is stored as "n:<digits>". */
export const NUMBER_PREFIX = "n:";

export const durations = [
  { seconds: 300, label: "5 minutes" },
  { seconds: 900, label: "15 minutes" },
  { seconds: 1_200, label: "20 minutes" },
  { seconds: 3_600, label: "1 hour" },
  { seconds: 21_600, label: "6 hours" },
  { seconds: 86_400, label: "24 hours" },
  { seconds: 604_800, label: "7 days" },
];

/** Comparisons as the sentence states them, and the one that trips the rule. */
export const compareOps: { op: CompareOp; label: string; trips: CompareOp }[] =
  [
    { op: "ge", label: "is at least", trips: "lt" },
    { op: "gt", label: "is above", trips: "le" },
    { op: "le", label: "is at most", trips: "gt" },
    { op: "lt", label: "is below", trips: "ge" },
    { op: "eq", label: "equals", trips: "ne" },
    { op: "ne", label: "never equals", trips: "eq" },
  ];

function call(id: string | undefined): ViewCall | null {
  if (!id || id.startsWith(NUMBER_PREFIX)) return null;
  const { method, returns } = parseReadableId(id);
  return {
    node: "view_call",
    function: method,
    args: [],
    ...(returns === undefined ? {} : { returns }),
  };
}

function read(id: string | undefined): ValueNode | null {
  if (id?.startsWith(NUMBER_PREFIX)) {
    const value = id.slice(NUMBER_PREFIX.length);
    return value ? { node: "literal", value } : null;
  }
  return call(id);
}

function whole(value: string | undefined): number | null {
  return value && /^\d+$/.test(value) ? Number(value) : null;
}

/** A whole percentage as a fraction: 5 → "0.05". */
function fraction(percent: number): string {
  const digits = String(percent).padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`.replace(/\.?0+$/, "");
}

/** A read's blank: "totalSupply() returns (uint256)", with "#1" for an output. */
function callId(node: unknown): string | null {
  const n = node as Partial<ViewCall> | null;
  if (n?.node !== "view_call" || n.address || n.args?.length || !n.function) {
    return null;
  }
  return readableId(n.function, n.returns);
}

/** A read, or a typed number, as its blank. */
function valueId(node: unknown): string | null {
  const n = node as { node?: string; value?: string } | null;
  if (n?.node === "literal" && n.value !== undefined) {
    return `${NUMBER_PREFIX}${n.value}`;
  }
  return callId(node);
}

type Node = Record<string, unknown> & { node?: string };
const asNode = (value: unknown): Node =>
  value && typeof value === "object" ? (value as Node) : {};
const text = (value: unknown) => (typeof value === "string" ? value : null);
const seconds = (window: unknown) =>
  String((window as { seconds?: number } | undefined)?.seconds ?? "");
const only = (values: Record<string, string | null>): Values | null =>
  Object.values(values).every((v) => v !== null && v !== "")
    ? (values as Values)
    : null;

const SUPPLY = [/^totalSupply$/i, /supply/i];
const ASSETS = [/^totalAssets$/i, /assets|reserve|balance|tvl/i];
// Cumulative accumulators (e.g. price0CumulativeLast) are not prices.
const PRICE = [/^(?!.*cumulative).*(price|rate|answer|pershare|exchange)/i];
const TIME = [/updatedAt/i, /updated|timestamp|lastUpdate|time/i];
// Constants and bookkeeping values that make poor defaults.
const UNINTERESTING =
  /^(decimals|version|nonces?|DOMAIN_SEPARATOR|PERMIT_TYPEHASH|.*_TYPEHASH|deploymentChainId)$/i;

export const templates: Template[] = [
  {
    id: "floor",
    title: "Never drops below",
    blurb: "A value always stays at or above another value, or a fixed floor.",
    needs: "reads",
    severity: "critical",
    fields: [
      {
        key: "value",
        kind: "read",
        label: "value",
        prefer: ASSETS,
        suggest: ASSETS,
      },
      {
        key: "floor",
        kind: "readOrNumber",
        label: "floor",
        prefer: SUPPLY,
        suggest: SUPPLY,
      },
    ],
    sentence: [{ field: "value" }, " never drops below ", { field: "floor" }],
    build(v) {
      const left = read(v.value);
      const right = read(v.floor);
      if (!left || !right) return null;
      return {
        when: "every_block",
        trip_when: { node: "compare", op: "lt", left, right },
      };
    },
    readBack({ trip_when }) {
      const t = asNode(trip_when);
      return only({ value: callId(t.left), floor: valueId(t.right) });
    },
    defaultName: (v, label) => `${label(v.value ?? "")} floor`,
  },
  {
    id: "band",
    title: "Stays near its average",
    blurb:
      "Catches sudden jumps: a price or rate never strays far from its recent average.",
    needs: "reads",
    severity: "warning",
    fields: [
      {
        key: "value",
        kind: "read",
        label: "value",
        prefer: [...PRICE, ...ASSETS, ...SUPPLY],
        suggest: PRICE,
      },
      { key: "percent", kind: "percent", label: "band", initial: "5" },
      { key: "window", kind: "duration", label: "window", initial: "1200" },
    ],
    sentence: [
      { field: "value" },
      " stays within ",
      { field: "percent" },
      "% of its ",
      { field: "window" },
      " average",
    ],
    build(v) {
      const value = call(v.value);
      const band = whole(v.percent);
      const window = whole(v.window);
      if (!value || band === null || !window) return null;
      return {
        when: "every_block",
        trip_when: {
          node: "deviation_band",
          value,
          center: {
            node: "metric",
            metric: "twap",
            of: value,
            window: { seconds: window },
          },
          tolerance_percent: String(band),
          sides: "both",
        },
      };
    },
    readBack({ trip_when }) {
      const t = asNode(trip_when);
      return only({
        value: callId(t.value),
        percent: text(t.tolerance_percent),
        window: seconds(asNode(t.center).window),
      });
    },
    defaultName: (v, label) => `${label(v.value ?? "")} stability`,
  },
  {
    id: "growth",
    title: "Growth limit",
    blurb: "Limits how fast a value can rise, like new supply minted in a day.",
    needs: "reads",
    severity: "warning",
    fields: [
      {
        key: "value",
        kind: "read",
        label: "value",
        prefer: SUPPLY,
        suggest: SUPPLY,
      },
      { key: "percent", kind: "percent", label: "limit", initial: "5" },
      { key: "window", kind: "duration", label: "window", initial: "86400" },
    ],
    sentence: [
      { field: "value" },
      " grows by at most ",
      { field: "percent" },
      "% in ",
      { field: "window" },
    ],
    build(v) {
      const value = call(v.value);
      const limit = whole(v.percent);
      const window = whole(v.window);
      if (!value || limit === null || !window) return null;
      return {
        when: "every_block",
        trip_when: {
          node: "compare",
          op: "gt",
          left: {
            node: "metric",
            metric: "windowed_delta",
            of: value,
            window: { seconds: window },
          },
          right: {
            node: "arithmetic",
            op: "mul",
            left: value,
            right: { node: "literal", value: fraction(limit) },
          },
        },
      };
    },
    readBack({ trip_when }) {
      const t = asNode(trip_when);
      const left = asNode(t.left);
      const limit = Number(asNode(asNode(t.right).right).value) * 100;
      return only({
        value: callId(left.of),
        percent: Number.isInteger(limit) ? String(limit) : null,
        window: seconds(left.window),
      });
    },
    defaultName: (v, label) => `${label(v.value ?? "")} growth limit`,
  },
  {
    id: "outflow",
    title: "Outflow limit",
    blurb: "Spots a drain in progress: a balance never falls too far too fast.",
    needs: "reads",
    severity: "critical",
    fields: [
      {
        key: "value",
        kind: "read",
        label: "value",
        prefer: ASSETS,
        suggest: ASSETS,
      },
      { key: "percent", kind: "percent", label: "limit", initial: "10" },
      { key: "window", kind: "duration", label: "window", initial: "3600" },
    ],
    sentence: [
      { field: "value" },
      " falls by at most ",
      { field: "percent" },
      "% in ",
      { field: "window" },
    ],
    build(v) {
      const value = call(v.value);
      const limit = whole(v.percent);
      const window = whole(v.window);
      if (!value || limit === null || !window) return null;
      // windowed_drop is already a percentage: the fall from the window's high.
      return {
        when: "every_block",
        trip_when: {
          node: "compare",
          op: "gt",
          left: {
            node: "metric",
            metric: "windowed_drop",
            of: value,
            window: { seconds: window },
          },
          right: { node: "literal", value: String(limit) },
        },
      };
    },
    readBack({ trip_when }) {
      const t = asNode(trip_when);
      const left = asNode(t.left);
      return only({
        value: callId(left.of),
        percent: text(asNode(t.right).value),
        window: seconds(left.window),
      });
    },
    defaultName: (v, label) => `${label(v.value ?? "")} outflow limit`,
  },
  {
    id: "fresh",
    title: "Stays fresh",
    blurb: "An oracle or feed keeps updating: its timestamp is never too old.",
    needs: "reads",
    severity: "warning",
    fields: [
      {
        key: "timestamp",
        kind: "read",
        label: "timestamp",
        prefer: TIME,
        suggest: TIME,
      },
      { key: "window", kind: "duration", label: "max age", initial: "3600" },
    ],
    sentence: [
      { field: "timestamp" },
      " is never more than ",
      { field: "window" },
      " old",
    ],
    build(v) {
      const timestamp = call(v.timestamp);
      const window = whole(v.window);
      if (!timestamp || !window) return null;
      return {
        when: "every_block",
        trip_when: {
          node: "compare",
          op: "gt",
          left: {
            node: "arithmetic",
            op: "sub",
            left: { node: "now" },
            right: timestamp,
          },
          right: { node: "literal", value: String(window) },
        },
      };
    },
    readBack({ trip_when }) {
      const t = asNode(trip_when);
      return only({
        timestamp: callId(asNode(t.left).right),
        window: text(asNode(t.right).value),
      });
    },
    defaultName: () => "Feed freshness",
  },
  {
    id: "event",
    title: "Event never appears",
    blurb:
      "Alerts the moment a dangerous event is emitted, like an ownership change.",
    needs: "events",
    severity: "critical",
    fields: [
      {
        key: "event",
        kind: "event",
        label: "event",
        prefer: [/ownership|upgraded|admin|paused|role/i],
        suggest: [/ownership|upgraded|admin|role/i],
      },
    ],
    sentence: [{ field: "event" }, " is never emitted"],
    build(v) {
      if (!v.event) return null;
      return { when: { event: v.event }, trip_when: true };
    },
    readBack({ when }) {
      return typeof when === "object" ? only({ event: when.event }) : null;
    },
    defaultName: (v) => `No ${(v.event ?? "event").replace(/\(.*$/, "")}`,
  },
  {
    id: "compare",
    title: "Custom comparison",
    blurb: "Compare any value to another value or a number.",
    needs: "reads",
    severity: "warning",
    fields: [
      { key: "left", kind: "read", label: "value" },
      { key: "op", kind: "op", label: "comparison", initial: "ge" },
      { key: "right", kind: "readOrNumber", label: "target" },
    ],
    sentence: [
      { field: "left" },
      " ",
      { field: "op" },
      " ",
      { field: "right" },
    ],
    build(v) {
      const left = read(v.left);
      const right = read(v.right);
      const op = compareOps.find((o) => o.op === v.op);
      if (!left || !right || !op) return null;
      return {
        when: "every_block",
        trip_when: { node: "compare", op: op.trips, left, right },
      };
    },
    readBack({ trip_when }) {
      const t = asNode(trip_when);
      return only({
        left: callId(t.left),
        op: compareOps.find((o) => o.trips === t.op)?.op ?? null,
        right: valueId(t.right),
      });
    },
    defaultName: (v, label) => `${label(v.left ?? "")} check`,
  },
];

/**
 * The part of a value's label that names it: the output name for one of
 * several outputs ("getReserves._reserve0" → "_reserve0"), else the label.
 */
function ownName(label: string): string {
  return label.slice(label.lastIndexOf(".") + 1);
}

function namesFor(field: Field, surface: ContractSurface): string[] {
  if (field.kind === "event") return surface.events.map((e) => e.name);
  if (field.kind === "read" || field.kind === "readOrNumber") {
    return surface.reads.map((r) => ownName(r.label));
  }
  return [];
}

function hasClearMatch(field: Field, surface: ContractSurface): boolean {
  return namesFor(field, surface).some((name) =>
    (field.suggest ?? []).some((re) => re.test(name)),
  );
}

/**
 * Fills each blank with a sensible starting value for this contract. A
 * blank the template needs a specific kind of value for (a timestamp, a
 * price) is left empty when the contract has no clear match, rather than
 * filled with a poor guess.
 */
export function initialValues(
  template: Template,
  surface: ContractSurface,
): Values {
  const values: Values = {};
  const taken = new Set<string>();
  for (const field of template.fields) {
    if (field.initial) {
      values[field.key] = field.initial;
      continue;
    }
    if (field.suggest && !hasClearMatch(field, surface)) continue;
    const options =
      field.kind === "event"
        ? surface.events.map((e) => ({ id: e.signature, name: e.name }))
        : field.kind === "read" || field.kind === "readOrNumber"
          ? surface.reads.map((r) => ({ id: r.id, name: ownName(r.label) }))
          : [];
    const preferred = (field.prefer ?? [])
      .map((re) => options.find((o) => re.test(o.name) && !taken.has(o.id)))
      .find(Boolean);
    const pick =
      preferred ??
      options.find((o) => !taken.has(o.id) && !UNINTERESTING.test(o.name)) ??
      options.find((o) => !taken.has(o.id));
    if (pick) {
      values[field.key] = pick.id;
      taken.add(pick.id);
    } else if (field.kind === "readOrNumber") {
      values[field.key] = `${NUMBER_PREFIX}0`;
    }
  }
  return values;
}

/** True when the contract has a clear match for every signal the template names. */
export function isSuggested(
  template: Template,
  surface: ContractSurface,
): boolean {
  const signals = template.fields.filter((f) => f.suggest);
  return (
    signals.length > 0 &&
    signals.every((field) => hasClearMatch(field, surface))
  );
}

export interface RankedTemplate {
  template: Template;
  available: boolean;
  suggested: boolean;
}

/** Templates for this contract: suggested first, then the rest, then unusable ones. */
export function rankTemplates(surface: ContractSurface): RankedTemplate[] {
  return templates
    .map((template) => {
      const available =
        template.needs === "reads"
          ? surface.reads.length > 0
          : surface.events.length > 0;
      return {
        template,
        available,
        suggested: available && isSuggested(template, surface),
      };
    })
    .sort(
      (a, b) =>
        Number(b.available) - Number(a.available) ||
        Number(b.suggested) - Number(a.suggested),
    );
}

/** Sorted keys, so two documents compare by content. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : v,
  );
}

/** Whether two rule documents say the same, whatever their key order. */
export function sameDocument(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

/**
 * The starting point a stored rule was built from, with its blanks filled
 * back in: the first template that reads the document back into blanks
 * this contract offers, and builds the same document from them. Null when
 * none does, and the rule is edited as JSON.
 */
export function recoverTemplate(
  watch: Watch,
  surface: ContractSurface,
): { template: Template; values: Values } | null {
  const target = stable({ when: watch.when, trip_when: watch.trip_when });
  for (const template of templates) {
    const values = template.readBack(watch);
    if (!values) continue;
    const offered = template.fields.every((field) => {
      const value = values[field.key] ?? "";
      const isRead = surface.reads.some((r) => r.id === value);
      switch (field.kind) {
        case "event":
          return surface.events.some((e) => e.signature === value);
        case "read":
          return isRead;
        case "readOrNumber":
          return isRead || value.startsWith(NUMBER_PREFIX);
        default:
          return true;
      }
    });
    const built = template.build(values);
    if (offered && built && stable(built) === target) {
      return { template, values };
    }
  }
  return null;
}
