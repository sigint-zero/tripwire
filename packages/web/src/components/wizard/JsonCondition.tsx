import type { Rule } from "@tripwire/shared";

/** What a pasted document may carry besides its condition. */
export type JsonRest = Partial<
  Pick<Rule, "name" | "description" | "severity" | "on_trip">
>;

/**
 * Reads the JSON box: the condition (`when` and `trip_when`), and, when a
 * whole rule document was pasted, the rest of it for the other steps.
 */
export function readJson(
  text: string,
):
  | { watch: Pick<Rule, "when" | "trip_when">; rest: JsonRest }
  | { problem: string } {
  if (!text.trim()) return { problem: "Paste or write the rule's condition." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { problem: (error as Error).message };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { problem: "Expected an object with when and trip_when." };
  }
  const doc = parsed as Record<string, unknown>;
  if (!("trip_when" in doc)) {
    return {
      problem: "Expected trip_when: the condition that trips the rule.",
    };
  }
  const rest: JsonRest = {};
  if (typeof doc.name === "string") rest.name = doc.name;
  if (typeof doc.description === "string") rest.description = doc.description;
  if (typeof doc.severity === "string")
    rest.severity = doc.severity as Rule["severity"];
  if (doc.on_trip && typeof doc.on_trip === "object") {
    rest.on_trip = doc.on_trip as Rule["on_trip"];
  }
  return {
    watch: {
      when: (doc.when ?? "every_block") as Rule["when"],
      trip_when: doc.trip_when as Rule["trip_when"],
    },
    rest,
  };
}

/**
 * The rule's condition as JSON, for a rule no starting point builds or
 * for anyone, an AI agent included, who has the document already. A whole
 * rule document fills in the other steps too.
 */
export function JsonCondition({
  text,
  onChange,
  problem,
}: {
  text: string;
  onChange: (text: string) => void;
  /** Why it is not a rule yet: a parse error or the first schema issue. */
  problem?: string;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-400">
        The condition as the engine reads it:{" "}
        <code className="font-mono text-gray-300">when</code> and{" "}
        <code className="font-mono text-gray-300">trip_when</code>. Paste a
        whole rule document and its name, severity and response fill the steps
        below.
      </p>
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        aria-label="The rule's condition as JSON"
        placeholder={`{\n  "when": "every_block",\n  "trip_when": { "node": "compare", … }\n}`}
        className="scrollbar-subtle h-80 w-full resize-y bg-white/3 p-4 font-mono text-xs leading-relaxed text-emerald-300 placeholder:text-gray-600 focus:bg-white/4 focus:outline-none"
      />
      {problem && <p className="font-mono text-xs text-amber-400">{problem}</p>}
    </div>
  );
}
