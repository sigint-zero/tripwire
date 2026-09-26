import {
  chainName,
  comparedValues,
  describeValue,
  formatDuration,
  issuesOf,
  rule as ruleSchema,
  type CallNamer,
  type OnTrip,
  type Rule,
  type RuleCheck,
  type Severity,
} from "@tripwire/shared";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useRegisteredContract } from "../components/contracts/useRegisteredContract";
import { ContractPicker } from "../components/wizard/ContractPicker";
import {
  actions,
  cooldowns,
  ResponseStep,
  severities,
} from "../components/wizard/ResponseStep";
import { RuleSentence, sentenceText } from "../components/wizard/RuleSentence";
import { Stepper } from "../components/wizard/Stepper";
import { TemplatePicker } from "../components/wizard/TemplatePicker";
import { TripSimulation } from "../components/wizard/TripSimulation";
import { Button, Eyebrow } from "../components/ui";
import { ApiError, api } from "../lib/api";
import { shortAddress } from "../lib/format";
import {
  initialValues,
  rankTemplates,
  sameDocument,
  templates,
  type Values,
} from "../lib/templates";

const steps = [
  { title: "Contract", hint: "Which contract should Tripwire watch?" },
  { title: "Rule", hint: "What should always be true?" },
  { title: "Response", hint: "What should happen when it trips?" },
  { title: "Review", hint: "Name it and switch it on." },
];

/** A stored rule opened in the wizard, read back into a starting point. */
export interface Editing {
  id: string;
  rule: Rule;
  templateId: string;
  values: Values;
}

/**
 * The wizard; `contract` preselects a registered contract. With `editing`
 * it opens a stored rule with every section filled in, and saving
 * replaces the rule's document.
 */
export function NewRulePage({
  contract: initial,
  editing,
}: {
  contract?: string;
  editing?: Editing;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(
    (editing?.rule.contract ?? initial)?.toLowerCase() ?? null,
  );
  const [templateId, setTemplateId] = useState<string | null>(
    editing?.templateId ?? null,
  );
  // Blanks are kept per template, so trying another preset and coming back
  // does not lose what was filled in.
  const [valuesByTemplate, setValuesByTemplate] = useState<
    Record<string, Values>
  >(editing ? { [editing.templateId]: editing.values } : {});
  const [name, setName] = useState<string | null>(editing?.rule.name ?? null);
  const [description, setDescription] = useState(
    editing?.rule.description ?? "",
  );
  const [severity, setSeverity] = useState<Severity | null>(
    editing?.rule.severity ?? null,
  );
  const [onTrip, setOnTrip] = useState<OnTrip>(
    editing?.rule.on_trip ?? { action: "notify", cooldown_seconds: 300 },
  );

  const { data: engine } = useQuery({
    queryKey: ["engine"],
    queryFn: ({ signal }) => api.engine(signal),
    staleTime: Infinity,
  });
  const chain = engine ? chainName(engine.chainId) : null;

  const { data: contracts } = useQuery({
    queryKey: ["contracts"],
    queryFn: ({ signal }) => api.contracts(signal),
  });
  const { contract } = useRegisteredContract(selected);
  const surface = contract?.surface;
  const ranked = surface ? rankTemplates(surface) : [];
  const template = templates.find((t) => t.id === templateId) ?? null;
  const values =
    (template && valuesByTemplate[template.id]) ||
    (template && surface ? initialValues(template, surface) : {});

  // A new rule takes its name and severity from the template; an edited
  // one keeps its own.
  const selectTemplate = (id: string) => {
    setTemplateId(id);
    if (editing) return;
    setName(null);
    setSeverity(null);
  };

  const labelOf = (id: string) =>
    surface?.reads.find((r) => r.id === id)?.label ?? id;
  const ruleName =
    name ?? (template ? template.defaultName(values, labelOf) : "");
  const ruleSeverity = severity ?? template?.severity ?? "warning";

  // The whole document, as the engine will receive it.
  const watch = template ? template.build(values) : null;
  const draft: Rule | null =
    watch && contract
      ? {
          version: 1,
          name: ruleName,
          ...(description.trim() ? { description: description.trim() } : {}),
          contract: contract.address,
          severity: ruleSeverity,
          ...watch,
          on_trip: onTrip,
        }
      : null;
  const checked = draft ? ruleSchema.safeParse(draft) : null;
  const rule = checked?.success ? checked.data : null;
  const issues = checked && !checked.success ? issuesOf(checked.error) : [];
  const issueAt = (...prefixes: string[]) =>
    issues.find((i) => prefixes.some((p) => i.path.startsWith(p)));
  const watchProblem = issueAt("/when", "/trip_when")?.message;

  // Both sides of the condition, named the way the sentence names them.
  const readName: CallNamer = (call) =>
    call.address
      ? undefined
      : surface?.reads.find(
          (r) => r.method === call.function && r.returns === call.returns,
        )?.label;
  const trip = draft?.trip_when;
  const ruleLabels =
    !trip || trip === true
      ? [values.event?.replace(/\(.*$/, "") ?? ""]
      : trip.node === "deviation_band"
        ? [
            describeValue(trip.value, readName),
            `within ${trip.tolerance_percent}% of ${describeValue(trip.center, readName)}`,
          ]
        : comparedValues(trip).map((v) => describeValue(v, readName));

  const unchanged = !!editing && !!rule && sameDocument(rule, editing.rule);
  const create = useMutation({
    mutationFn: () =>
      editing ? api.replaceRule(editing.id, rule!) : api.createRule(rule!),
    onSuccess: async (stored) => {
      await queryClient.invalidateQueries({ queryKey: ["rules"] });
      await queryClient.invalidateQueries({ queryKey: ["contracts"] });
      if (editing) {
        await queryClient.invalidateQueries({ queryKey: ["rule", editing.id] });
        await navigate({ to: "/rules/$id", params: { id: editing.id } });
      } else {
        await navigate({ to: "/rules", search: { created: stored.id } });
      }
    },
  });

  // Sections open one after another as the user continues, and stay open
  // so any of them can be revisited by scrolling. An edited rule has them
  // all.
  const [revealed, setRevealed] = useState(editing ? steps.length - 1 : 0);
  // The rule section opens as soon as the contract loads.
  const open = Math.max(revealed, contract ? 1 : 0);
  const [active, setActive] = useState(0);
  const sections = useRef<(HTMLElement | null)[]>([]);

  // The engine's own reading of the rule, once there is something to review;
  // an edited rule is not its own duplicate.
  const replacing = editing?.id;
  const check = useQuery({
    queryKey: ["rule-check", rule, replacing],
    queryFn: ({ signal }) =>
      replacing
        ? api.checkReplacement(replacing, rule!, signal)
        : api.checkRule(rule!, signal),
    enabled: !!rule && open >= 3,
    placeholderData: keepPreviousData,
  });

  // Highlight the section in the upper part of the viewport.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const inView = entries.find((e) => e.isIntersecting);
        if (inView) {
          setActive(Number((inView.target as HTMLElement).dataset.section));
        }
      },
      { rootMargin: "-25% 0px -65% 0px" },
    );
    for (const el of sections.current) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, [open]);

  const scrollTo = (index: number) => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    sections.current[index]?.scrollIntoView({
      behavior: reduced.matches ? "auto" : "smooth",
      block: "start",
    });
  };

  // An edit starts at the rule, once everything above it has loaded.
  const startedAtRule = useRef(false);
  useEffect(() => {
    if (!editing || !surface || !contracts || startedAtRule.current) return;
    startedAtRule.current = true;
    requestAnimationFrame(() =>
      sections.current[1]?.scrollIntoView({ block: "start" }),
    );
  }, [editing, surface, contracts]);

  // Changing the contract invalidates everything chosen after it.
  const resetFromContract = () => {
    setTemplateId(null);
    setValuesByTemplate({});
    setName(null);
    setSeverity(null);
    setRevealed(0);
  };

  const ready = [
    !!contract,
    !!watch && !watchProblem,
    !!watch && !issueAt("/on_trip"),
    // An identical rule would be refused, so there is nothing to create;
    // an edit that changes nothing has nothing to save.
    !!rule && !check.data?.duplicateOf && !unchanged,
  ];

  const continueFrom = (index: number) => {
    flushSync(() => setRevealed(Math.max(open, index + 1)));
    scrollTo(index + 1);
  };

  const section = (index: number, body: ReactNode) =>
    index <= open && (
      <section
        key={index}
        ref={(el) => {
          sections.current[index] = el;
        }}
        data-section={index}
        aria-labelledby={`section-${index}`}
        className="animate-reveal scroll-mt-28 py-12 first:pt-4 motion-reduce:animate-none"
      >
        <h2
          id={`section-${index}`}
          className="mb-8 font-display text-xl font-bold text-white md:text-2xl"
        >
          {steps[index]?.hint}
        </h2>
        {body}
        {index > 0 && index < steps.length - 1 && index === open && (
          <div className="mt-10 flex justify-end">
            <Button
              disabled={!ready[index]}
              onClick={() => continueFrom(index)}
            >
              Continue ↓
            </Button>
          </div>
        )}
      </section>
    );

  return (
    <div className="pb-[40vh]">
      <header className="mb-6">
        {editing && (
          <Link
            to="/rules/$id"
            params={{ id: editing.id }}
            className="mb-4 inline-block text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-emerald-400"
          >
            ← {editing.rule.name}
          </Link>
        )}
        <h1 className="font-display text-3xl font-bold tracking-tighter text-white uppercase md:text-4xl">
          {editing ? "Edit the rule" : "Create a rule"}
        </h1>
      </header>

      <div className="sticky top-0 z-30 -mx-10 bg-canvas/85 px-10 py-4 backdrop-blur">
        <Stepper
          steps={steps.map((s) => s.title)}
          active={active}
          done={ready.map((r, i) => r && i < open)}
          unlocked={steps.map((_, i) => i <= open)}
          onSelect={scrollTo}
        />
      </div>

      <div>
        {section(
          0,
          contracts ? (
            <ContractPicker
              contracts={contracts}
              selected={selected}
              loaded={contract}
              chain={chain}
              locked={!!editing}
              onSelect={(address) => {
                if (address !== selected) resetFromContract();
                setSelected(address);
              }}
            />
          ) : (
            <p className="text-sm text-gray-500">Loading contracts…</p>
          ),
        )}

        {surface &&
          section(
            1,
            <div className="space-y-12">
              <TemplatePicker
                ranked={ranked}
                selected={templateId}
                onSelect={selectTemplate}
              />
              {template && (
                <div className="space-y-5 bg-emerald-500/4 bg-[radial-gradient(ellipse_at_top_left,--theme(--color-emerald-500/14%),transparent_70%)] px-6 py-8 md:px-10 md:py-10">
                  <Eyebrow>Your rule</Eyebrow>
                  <RuleSentence
                    template={template}
                    values={values}
                    surface={surface}
                    onChange={(key, value) =>
                      setValuesByTemplate((all) => ({
                        ...all,
                        [template.id]: { ...values, [key]: value },
                      }))
                    }
                  />
                  {watchProblem && (
                    <p className="text-xs text-amber-400">
                      Not valid yet: {watchProblem}
                    </p>
                  )}
                </div>
              )}
            </div>,
          )}

        {surface &&
          section(
            2,
            <div className="grid items-start gap-8 min-[1400px]:grid-cols-[min-content_minmax(0,1fr)] min-[1400px]:gap-12">
              <ResponseStep
                severity={ruleSeverity}
                onSeverity={setSeverity}
                value={onTrip}
                onChange={setOnTrip}
                writes={surface.writes}
                responseMode={engine?.responseMode}
              />
              {draft && template && ready[1] && engine && (
                <TripSimulation
                  rule={draft}
                  sentence={sentenceText(template, values, surface)}
                  responseMode={engine.responseMode}
                  contractName={contract?.name ?? ""}
                  valueLabel={ruleLabels[0] ?? ""}
                  limitLabel={ruleLabels[1] ?? ""}
                />
              )}
            </div>,
          )}

        {section(
          3,
          template && surface && draft ? (
            <>
              <Review
                name={ruleName}
                onName={setName}
                nameProblem={issueAt("/name")?.message}
                description={description}
                onDescription={setDescription}
                summary={[
                  [
                    "Watches",
                    `${contract?.name} (${shortAddress(selected ?? "")})${chain ? ` on ${chain}` : ""}`,
                  ],
                  ["Rule", sentenceText(template, values, surface)],
                  [
                    "Severity",
                    severities.find((s) => s.severity === ruleSeverity)
                      ?.title ?? ruleSeverity,
                  ],
                  ["Response", describeOnTrip(onTrip)],
                ]}
                check={rule ? check.data : undefined}
                startsDisabled={!editing && contract?.active === false}
                json={draft}
                error={create.error}
              />
              <div className="mt-10 flex justify-end">
                <Button
                  disabled={!ready[3] || create.isPending}
                  title={unchanged ? "Nothing has changed yet" : undefined}
                  onClick={() => create.mutate()}
                >
                  {editing
                    ? create.isPending
                      ? "Saving…"
                      : "Save changes"
                    : create.isPending
                      ? "Creating…"
                      : "Create rule"}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-gray-500">
              Complete the rule above to review it.
            </p>
          ),
        )}
      </div>
    </div>
  );
}

function describeOnTrip(onTrip: OnTrip): string {
  const action =
    onTrip.action === "trip_function"
      ? `Pause ${onTrip.function}`
      : onTrip.action === "call"
        ? `Call ${onTrip.call.function.replace(/\(.*$/, "")}(${onTrip.call.args.join(", ")})`
        : (actions.find((a) => a.action === onTrip.action)?.title ??
          onTrip.action);
  const seconds = onTrip.cooldown_seconds ?? 0;
  const quiet =
    cooldowns.find((c) => c.seconds === seconds)?.label ??
    formatDuration(seconds);
  return `${action}. Quiet period: ${quiet}.`;
}

const label =
  "mb-2 block text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase";
const field =
  "w-full bg-white/4 px-3 py-2.5 text-sm text-white transition-colors hover:bg-white/6 focus:bg-white/6";

function Review({
  name,
  onName,
  nameProblem,
  description,
  onDescription,
  summary,
  check,
  startsDisabled,
  json,
  error,
}: {
  name: string;
  onName: (name: string) => void;
  nameProblem: string | undefined;
  description: string;
  onDescription: (description: string) => void;
  summary: [string, string][];
  check: RuleCheck | undefined;
  startsDisabled: boolean;
  json: unknown;
  error: Error | null;
}) {
  const evaluation = check?.evaluation;
  return (
    <div className="space-y-6">
      <label className="block">
        <span className={label}>Name</span>
        <input
          className={field}
          value={name}
          maxLength={120}
          onChange={(e) => onName(e.target.value)}
        />
        {nameProblem && (
          <span className="mt-2 block text-xs text-amber-400">
            Name {nameProblem}
          </span>
        )}
      </label>
      <label className="block">
        <span className={label}>
          Description <span className="text-gray-600">· optional</span>
        </span>
        <textarea
          className={`${field} h-20 resize-y`}
          value={description}
          placeholder="Why this rule exists, and what a trip would mean."
          onChange={(e) => onDescription(e.target.value)}
        />
      </label>
      <dl className="space-y-3">
        {summary.map(([term, detail]) => (
          <div key={term} className="grid gap-1 sm:grid-cols-[120px_1fr]">
            <dt className="text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase">
              {term}
            </dt>
            <dd className="text-sm text-gray-300">{detail}</dd>
          </div>
        ))}
        <div className="grid gap-1 sm:grid-cols-[120px_1fr]">
          <dt className="text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase">
            Engine reads
          </dt>
          <dd className="font-mono text-xs leading-relaxed text-emerald-300">
            {check?.sentence ?? "Checking…"}
          </dd>
        </div>
      </dl>
      {check && (
        <ul className="space-y-1 text-xs">
          {startsDisabled && (
            <li className="text-amber-400">
              Its contract is disabled, so the rule starts disabled.
            </li>
          )}
          {evaluation?.wouldTripNow && (
            <li className="text-amber-400">
              It would trip right now, at block{" "}
              {evaluation.block.toLocaleString()}.
            </li>
          )}
          {check.warmupSeconds > 0 && (
            <li className="text-gray-400">
              It warms up for {formatDuration(check.warmupSeconds)} before it
              can trip, while its window fills.
            </li>
          )}
          {check.duplicateOf && (
            <li className="text-red-400">
              An identical rule already watches this contract.
            </li>
          )}
          {check.simulated && (
            <li className="text-gray-600">
              Checked against simulated values until the engine is connected.
            </li>
          )}
        </ul>
      )}
      <details className="group">
        <summary className="cursor-pointer text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase hover:text-emerald-400">
          View as JSON
        </summary>
        <pre className="mt-3 max-h-80 overflow-auto bg-white/3 p-4 text-xs text-emerald-300">
          {JSON.stringify(json, null, 2)}
        </pre>
      </details>
      {error && (
        <div className="bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error.message}
          {error instanceof ApiError &&
            error.issues.map((issue) => (
              <div key={issue.path} className="font-mono text-xs">
                {issue.path}: {issue.message}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
