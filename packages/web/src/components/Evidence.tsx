import {
  describeCondition,
  describeValue,
  formatNumber,
  type BoolNode,
  type RuleDisplay,
  type ValueNode,
} from "@tripwire/shared";
import { formatBig, formatUnits } from "../lib/format";

type Node = {
  node?: string;
  value?: unknown;
  state?: "unevaluated" | "warming";
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
  if (node.state === "unevaluated") {
    return <span className="text-gray-600">not reached</span>;
  }
  if (node.state === "warming") {
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

/**
 * What the engine saw: the condition as a tree, each part with its value
 * at that block, or why it has none.
 */
export function Evidence({
  evidence,
  display,
}: {
  evidence: unknown;
  /** How the rule's reads are shown. */
  display?: RuleDisplay;
}) {
  if (!evidence || typeof evidence !== "object") return null;
  const node = evidence as Node;
  if (typeof node.error === "string") {
    return <p className="font-mono text-xs text-red-400">{node.error}</p>;
  }
  return (
    <ul className="font-mono text-xs">
      <Line node={node} depth={0} display={display} />
    </ul>
  );
}
