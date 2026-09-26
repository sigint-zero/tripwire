import {
  describeCondition,
  describeValue,
  formatNumber,
  type BoolNode,
  type RuleDisplay,
  type ValueNode,
} from "@tripwire/shared";
import { formatBig, formatUnits } from "../lib/format";

/** An evidence node, as the engine writes it. */
type Node = {
  node?: string;
  value?: unknown;
  /** A term the evaluation stopped before; the engine writes nothing else. */
  unevaluated?: true;
  /** A value that cannot be known yet: a metric without history. */
  warming?: true;
  [child: string]: unknown;
};

const CONDITIONS = new Set(["compare", "deviation_band", "and", "or", "not"]);

/** The parts of a node shown beneath it, in reading order. */
function childrenOf(node: Node): Node[] {
  const list = (key: string) =>
    Array.isArray(node[key]) ? (node[key] as Node[]) : [];
  const one = (key: string) =>
    node[key] && typeof node[key] === "object" ? [node[key] as Node] : [];
  switch (node.node) {
    case "compare":
    case "arithmetic":
      return [...one("left"), ...one("right")];
    case "deviation_band":
      return [...one("value"), ...one("center")];
    case "and":
    case "or":
    case "sum":
      return list("terms");
    case "not":
    case "scale":
      return one("expr");
    case "metric":
      return one("of");
    default:
      return [];
  }
}

function label(node: Node): string {
  if (node.unevaluated) return "a later term";
  try {
    return CONDITIONS.has(node.node ?? "") ||
      (node.node === "simulate" && node.yields === "reverted")
      ? describeCondition(node as unknown as BoolNode)
      : describeValue(node as unknown as ValueNode);
  } catch {
    return node.node ?? "condition";
  }
}

function Reading({ node, display }: { node: Node; display?: RuleDisplay }) {
  if (node.unevaluated) {
    return <span className="text-gray-600">not reached</span>;
  }
  if (node.warming) {
    return <span className="text-amber-400/80">warming up</span>;
  }
  if (typeof node.value === "boolean") {
    return node.value ? (
      <span className="text-red-400">true</span>
    ) : (
      <span className="text-gray-500">false</span>
    );
  }
  if (typeof node.value === "string") {
    const raw = node.value;
    // A read is a raw integer; the rule's display settings make it readable.
    const read = node.node === "view_call" && /^-?\d+$/.test(raw);
    const shown =
      read && display?.decimals != null
        ? formatUnits(raw, display.decimals)
        : /^\d+$/.test(raw)
          ? formatBig(raw)
          : formatNumber(raw);
    return (
      <span className="text-white" title={raw}>
        {shown}
        {read && display?.unit && (
          <span className="text-gray-500"> {display.unit}</span>
        )}
      </span>
    );
  }
  return null;
}

function Line({
  node,
  depth,
  display,
}: {
  node: Node;
  depth: number;
  display?: RuleDisplay;
}) {
  const children = childrenOf(node).filter(
    (c) => c.node !== "literal" && c.node !== "now",
  );
  return (
    <>
      <li
        className="flex items-baseline justify-between gap-6 py-1"
        style={{ paddingLeft: `${depth * 1.25}rem` }}
      >
        <span
          className={`min-w-0 break-words ${depth === 0 ? "text-gray-200" : "text-gray-400"}`}
        >
          {label(node)}
        </span>
        <span className="shrink-0 tabular-nums">
          <Reading node={node} display={display} />
        </span>
      </li>
      {children.map((child, i) => (
        <Line key={i} node={child} depth={depth + 1} display={display} />
      ))}
    </>
  );
}

/** The tree with reads of the rule's own contract unaddressed, as the rule was written. */
function ownReads(node: unknown, contract: string): unknown {
  if (Array.isArray(node)) return node.map((n) => ownReads(n, contract));
  if (!node || typeof node !== "object") return node;
  const copy: Node = {};
  for (const [key, value] of Object.entries(node as Node)) {
    const own =
      key === "address" &&
      typeof value === "string" &&
      value.toLowerCase() === contract.toLowerCase();
    if (!own) copy[key] = ownReads(value, contract);
  }
  return copy;
}

/**
 * What the engine saw: the condition as a tree, each part with its value
 * at that block, or why it has none.
 */
export function Evidence({
  evidence,
  display,
  contract,
}: {
  evidence: unknown;
  /** How the rule's reads are shown. */
  display?: RuleDisplay;
  /** The rule's contract, whose address its reads need not repeat. */
  contract?: string;
}) {
  if (!evidence || typeof evidence !== "object") return null;
  const filed = evidence as Node;
  if (typeof filed.error === "string") {
    return <p className="font-mono text-xs text-red-400">{filed.error}</p>;
  }
  // A violation files the tree under `trip_when`; a check gives it bare.
  const tree =
    filed.trip_when && typeof filed.trip_when === "object"
      ? filed.trip_when
      : filed;
  const node = (contract ? ownReads(tree, contract) : tree) as Node;
  return (
    <ul className="font-mono text-xs">
      <Line node={node} depth={0} display={display} />
    </ul>
  );
}
