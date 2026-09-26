import {
  issuesOf,
  rule as ruleSchema,
  type Rule,
  type SavedRule,
} from "@tripwire/shared";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useRegisteredContract } from "../components/contracts/useRegisteredContract";
import { Button } from "../components/ui";
import type { ContractSurface } from "../lib/abi";
import { ApiError, api } from "../lib/api";
import { recoverTemplate, sameDocument } from "../lib/templates";
import { NewRulePage } from "./NewRule";

const backLink =
  "text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-emerald-400";

/**
 * A stored rule, opened where it can be edited: the wizard, when a
 * starting point reads the document back into blanks, else JSON mode.
 */
export function EditRulePage({ id }: { id: string }) {
  const { data: saved, error } = useQuery({
    queryKey: ["rule", id],
    queryFn: ({ signal }) => api.rule(id, signal),
  });
  const { contract, error: contractError } = useRegisteredContract(
    saved ? saved.rule.contract.toLowerCase() : null,
  );
  const failure = error ?? contractError;

  const back = (
    <Link to="/rules/$id" params={{ id }} className={backLink}>
      ← The rule
    </Link>
  );
  if (failure) {
    return (
      <div className="space-y-4">
        {back}
        <p className="text-sm text-gray-400">{failure.message}</p>
      </div>
    );
  }
  if (!saved || !contract) return back;
  return <Opened saved={saved} surface={contract.surface} />;
}

function Opened({
  saved,
  surface,
}: {
  saved: SavedRule;
  surface: ContractSurface;
}) {
  // Read back once, so a refetch of the rule does not reshape the page.
  const [recovered] = useState(() => recoverTemplate(saved.rule, surface));
  if (!recovered) return <JsonEditor saved={saved} />;
  return (
    <NewRulePage
      editing={{
        id: saved.id,
        rule: saved.rule,
        templateId: recovered.template.id,
        values: recovered.values,
      }}
    />
  );
}

/**
 * The document as editable JSON, validated as it is typed with problems
 * shown against their path, and checked by the engine once it is valid.
 */
function JsonEditor({ saved }: { saved: SavedRule }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [text, setText] = useState(() =>
    JSON.stringify(readingOrder(saved.rule), null, 2),
  );

  let problems: { path: string; message: string }[] = [];
  let rule: Rule | null = null;
  try {
    const parsed = ruleSchema.safeParse(JSON.parse(text));
    if (parsed.success) rule = parsed.data;
    else problems = issuesOf(parsed.error);
  } catch (error) {
    problems = [{ path: "", message: (error as Error).message }];
  }
  const unchanged = !!rule && sameDocument(rule, saved.rule);

  const check = useQuery({
    queryKey: ["rule-check", rule, saved.id],
    queryFn: ({ signal }) => api.checkReplacement(saved.id, rule!, signal),
    enabled: !!rule,
    placeholderData: keepPreviousData,
  });
  const save = useMutation({
    mutationFn: () => api.replaceRule(saved.id, rule!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["rule", saved.id] });
      await queryClient.invalidateQueries({ queryKey: ["rules"] });
      await navigate({ to: "/rules/$id", params: { id: saved.id } });
    },
  });
  const verdict = rule ? check.data : undefined;

  return (
    <div>
      <Link to="/rules/$id" params={{ id: saved.id }} className={backLink}>
        ← {saved.rule.name}
      </Link>
      <header className="mt-4 mb-8">
        <h1 className="font-display text-3xl font-bold tracking-tighter text-white uppercase md:text-4xl">
          Edit the rule
        </h1>
        <p
          className="mt-3 text-sm text-gray-400"
          title="No starting point builds this document, so it is edited as the engine keeps it."
        >
          As JSON
        </p>
      </header>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        className="scrollbar-subtle h-[28rem] w-full resize-y bg-white/3 p-4 font-mono text-xs leading-relaxed text-emerald-300 focus:bg-white/4 focus:outline-none"
      />

      <div className="mt-4 min-h-10 space-y-1 font-mono text-xs">
        {problems.map((p) => (
          <p key={`${p.path}:${p.message}`} className="text-amber-400">
            {p.path && <span className="text-gray-500">{p.path} </span>}
            {p.message}
          </p>
        ))}
        {verdict?.sentence && (
          <p className="text-emerald-300">{verdict.sentence}</p>
        )}
        {verdict?.issues.map((p) => (
          <p key={`${p.path}:${p.message}`} className="text-amber-400">
            <span className="text-gray-500">{p.path} </span>
            {p.message}
          </p>
        ))}
        {verdict?.duplicateOf && (
          <p className="text-red-400">
            An identical rule already watches this contract.
          </p>
        )}
      </div>

      {save.error && (
        <div className="mt-4 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {save.error.message}
          {save.error instanceof ApiError &&
            save.error.issues.map((issue) => (
              <div key={issue.path} className="font-mono text-xs">
                {issue.path}: {issue.message}
              </div>
            ))}
        </div>
      )}

      <div className="mt-8 flex justify-end">
        <Button
          disabled={
            !rule ||
            unchanged ||
            !verdict?.valid ||
            !!verdict.duplicateOf ||
            save.isPending
          }
          title={unchanged ? "Nothing has changed yet" : undefined}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

const TOP = [
  "version",
  "name",
  "description",
  "contract",
  "severity",
  "when",
  "trip_when",
  "on_trip",
];

/**
 * The document laid out to read top-down: its fields in the order the
 * language gives them, and each node's kind first.
 */
function readingOrder(value: unknown, top = true): unknown {
  if (Array.isArray(value)) return value.map((v) => readingOrder(v, false));
  if (!value || typeof value !== "object") return value;
  const rank = (key: string) => {
    const at = top ? TOP.indexOf(key) : ["node", "op"].indexOf(key);
    return at === -1 ? Infinity : at;
  };
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => rank(a) - rank(b))
      .map(([key, v]) => [key, readingOrder(v, false)]),
  );
}
