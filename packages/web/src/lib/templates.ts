import type { CompareOp, Rule, ValueExpr } from "@tripwire/shared";
import { parseReadableId, type ContractSurface } from "./abi";

// Invariant templates: each is a sentence with blanks, and knows how to turn
// the filled-in blanks into a rule.

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

export interface Template {
  id: string;
  title: string;
  blurb: string;
  needs: "reads" | "events";
  fields: Field[];
  sentence: Part[];
  build: (values: Values, contract: string) => Rule | null;
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

export const compareOps: { op: CompareOp; label: string }[] = [
  { op: "gte", label: "is at least" },
  { op: "gt", label: "is above" },
  { op: "lte", label: "is at most" },
  { op: "lt", label: "is below" },
  { op: "eq", label: "equals" },
  { op: "neq", label: "never equals" },
];

function read(id: string | undefined, contract: string): ValueExpr | null {
  if (!id) return null;
  if (id.startsWith(NUMBER_PREFIX)) {
    const value = id.slice(NUMBER_PREFIX.length);
    return value ? { type: "literal", value } : null;
  }
  const { method, returnIndex } = parseReadableId(id);
  return {
    type: "view_call",
    contract,
    method,
    ...(returnIndex ? { return_index: returnIndex } : {}),
  };
}

function whole(value: string | undefined): number | null {
  return value && /^\d+$/.test(value) ? Number(value) : null;
}

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
    build(v, contract) {
      const left = read(v.value, contract);
      const right = read(v.floor, contract);
      if (!left || !right) return null;
      return {
        kind: "expression",
        condition: { type: "compare", op: "gte", left, right },
      };
    },
    defaultName: (v, label) => `${label(v.value ?? "")} floor`,
  },
  {
    id: "band",
    title: "Stays near its average",
    blurb:
      "Catches sudden jumps: a price or rate never strays far from its recent average.",
    needs: "reads",
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
    build(v, contract) {
      const value = read(v.value, contract);
      const band = whole(v.percent);
      const window = whole(v.window);
      if (!value || band === null || !window) return null;
      return {
        kind: "expression",
        condition: {
          type: "deviation_band",
          value,
          center: {
            type: "historical",
            key: `${v.value}:twap:${window}`,
            source: value,
            metric: { type: "twap", window_secs: window },
          },
          band_percent: band,
        },
      };
    },
    defaultName: (v, label) => `${label(v.value ?? "")} stability`,
  },
  {
    id: "growth",
    title: "Growth limit",
    blurb: "Limits how fast a value can rise, like new supply minted in a day.",
    needs: "reads",
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
    build(v, contract) {
      const value = read(v.value, contract);
      const limit = whole(v.percent);
      const window = whole(v.window);
      if (!value || limit === null || !window) return null;
      return {
        kind: "expression",
        condition: {
          type: "compare",
          op: "lte",
          left: {
            type: "historical",
            key: `${v.value}:delta:${window}`,
            source: value,
            metric: { type: "windowed_delta", window_secs: window },
          },
          right: { type: "scale", value, numerator: limit, denominator: 100 },
        },
      };
    },
    defaultName: (v, label) => `${label(v.value ?? "")} growth limit`,
  },
  {
    id: "outflow",
    title: "Outflow limit",
    blurb: "Spots a drain in progress: a balance never falls too far too fast.",
    needs: "reads",
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
    build(v, contract) {
      const value = read(v.value, contract);
      const limit = whole(v.percent);
      const window = whole(v.window);
      if (!value || limit === null || !window) return null;
      return {
        kind: "expression",
        condition: {
          type: "compare",
          op: "lte",
          left: {
            type: "historical",
            key: `${v.value}:drop:${window}`,
            source: value,
            metric: { type: "windowed_drop", window_secs: window },
          },
          right: { type: "scale", value, numerator: limit, denominator: 100 },
        },
      };
    },
    defaultName: (v, label) => `${label(v.value ?? "")} outflow limit`,
  },
  {
    id: "fresh",
    title: "Stays fresh",
    blurb: "An oracle or feed keeps updating: its timestamp is never too old.",
    needs: "reads",
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
    build(v, contract) {
      const timestamp = read(v.timestamp, contract);
      const window = whole(v.window);
      if (!timestamp || !window) return null;
      return {
        kind: "expression",
        condition: {
          type: "compare",
          op: "lte",
          left: {
            type: "arithmetic",
            op: "sub",
            left: { type: "now" },
            right: timestamp,
          },
          right: { type: "literal", value: String(window) },
        },
      };
    },
    defaultName: () => "Feed freshness",
  },
  {
    id: "event",
    title: "Event never appears",
    blurb:
      "Alerts the moment a dangerous event is emitted, like an ownership change.",
    needs: "events",
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
      return { kind: "log", event: v.event, condition: "must_not_appear" };
    },
    defaultName: (v) => `No ${(v.event ?? "event").replace(/\(.*$/, "")}`,
  },
  {
    id: "compare",
    title: "Custom comparison",
    blurb: "Compare any value to another value or a number.",
    needs: "reads",
    fields: [
      { key: "left", kind: "read", label: "value" },
      { key: "op", kind: "op", label: "comparison", initial: "gte" },
      { key: "right", kind: "readOrNumber", label: "target" },
    ],
    sentence: [
      { field: "left" },
      " ",
      { field: "op" },
      " ",
      { field: "right" },
    ],
    build(v, contract) {
      const left = read(v.left, contract);
      const right = read(v.right, contract);
      const op = compareOps.find((o) => o.op === v.op)?.op;
      if (!left || !right || !op) return null;
      return {
        kind: "expression",
        condition: { type: "compare", op, left, right },
      };
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
