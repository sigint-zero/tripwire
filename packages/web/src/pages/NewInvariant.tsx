import {
  chainName,
  comparedValues,
  describeValue,
  rule as ruleSchema,
  type ReadNamer,
  type Response,
} from "@tripwire/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ContractStep } from "../components/wizard/ContractStep";
import {
  cooldowns,
  modes,
  ResponseStep,
} from "../components/wizard/ResponseStep";
import { RuleSentence, sentenceText } from "../components/wizard/RuleSentence";
import { Stepper } from "../components/wizard/Stepper";
import { TemplatePicker } from "../components/wizard/TemplatePicker";
import { TripSimulation } from "../components/wizard/TripSimulation";
import { useContract } from "../components/wizard/useContract";
import { Button, Eyebrow } from "../components/ui";
import { ApiError, api } from "../lib/api";
import { shortAddress } from "../lib/format";
import {
  initialValues,
  rankTemplates,
  templates,
  type Values,
} from "../lib/templates";

// Development only: a contract to start from, so it need not be pasted
// on every reload. Production builds ignore it.
const [devChain, devAddress] = import.meta.env.DEV
  ? (import.meta.env.VITE_DEV_CONTRACT?.split(":") ?? [])
  : [];

const steps = [
  { title: "Contract", hint: "Which contract should Tripwire watch?" },
  { title: "Invariant", hint: "What should always be true?" },
  { title: "Response", hint: "What should happen when it breaks?" },
  { title: "Review", hint: "Name it and switch it on." },
];

export function NewInvariantPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [chainId, setChainId] = useState(Number(devChain) || 1);
  const [address, setAddress] = useState(devAddress ?? "");
  const [pasted, setPasted] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [templateId, setTemplateId] = useState<string | null>(null);
  // Blanks are kept per template, so trying another preset and coming back
  // does not lose what was filled in.
  const [valuesByTemplate, setValuesByTemplate] = useState<
    Record<string, Values>
  >({});
  const [name, setName] = useState<string | null>(null);
  const [response, setResponse] = useState<Response>({
    mode: "alert",
    scope: { type: "contract" },
    cooldownSecs: 300,
  });

  const contractState = useContract(chainId, address, pasted);
  const contract = contractState.contract;
  const surface = contract?.surface;
  const ranked = surface ? rankTemplates(surface) : [];
  const template = templates.find((t) => t.id === templateId) ?? null;
  const values =
    (template && valuesByTemplate[template.id]) ||
    (template && surface ? initialValues(template, surface) : {});

  const selectTemplate = (id: string) => {
    setTemplateId(id);
    setName(null);
  };

  const built =
    template && contract ? template.build(values, contract.address) : null;
  const checked = built ? ruleSchema.safeParse(built) : null;
  const rule = checked?.success ? checked.data : null;
  const ruleProblem =
    checked && !checked.success ? checked.error.issues[0]?.message : null;

  // Both sides of the rule, named the way the sentence names them.
  const readName: ReadNamer = (method, index) =>
    surface?.reads.find((r) => r.method === method && r.returnIndex === index)
      ?.label;
  const ruleLabels = !rule
    ? []
    : rule.kind === "log"
      ? [rule.event.replace(/\(.*$/, "")]
      : rule.condition.type === "deviation_band"
        ? [
            describeValue(rule.condition.value, readName),
            `within ${rule.condition.band_percent}% of ${describeValue(rule.condition.center, readName)}`,
          ]
        : comparedValues(rule.condition).map((v) => describeValue(v, readName));

  const labelOf = (id: string) =>
    surface?.reads.find((r) => r.id === id)?.label ?? id;
  const invariantName =
    name ?? (template ? template.defaultName(values, labelOf) : "");

  const create = useMutation({
    mutationFn: () =>
      api.createInvariant({
        name: invariantName,
        chainId,
        contract: address,
        rule: rule!,
        response,
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["invariants"] });
      await navigate({ to: "/invariants", search: { created: created.id } });
    },
  });

  // Sections open one after another as the user continues, and stay open
  // so any of them can be revisited by scrolling.
  const [revealed, setRevealed] = useState(0);
  // The invariant section opens as soon as the contract loads.
  const open = Math.max(revealed, contract ? 1 : 0);
  const [active, setActive] = useState(0);
  const sections = useRef<(HTMLElement | null)[]>([]);

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

  // Changing the contract invalidates everything chosen after it.
  const resetFromContract = () => {
    setTemplateId(null);
    setValuesByTemplate({});
    setName(null);
    setRevealed(0);
  };

  const ready = [
    !!contract,
    !!rule,
    response.mode === "alert" ||
      response.scope.type === "contract" ||
      !!response.scope.selector,
    !!rule && invariantName.trim() !== "",
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
        className="animate-reveal scroll-mt-28 py-12 motion-reduce:animate-none first:pt-4"
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
        <h1 className="font-display text-3xl font-bold tracking-tighter text-white uppercase md:text-4xl">
          Create an invariant
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
          <ContractStep
            chainId={chainId}
            address={address}
            pasted={pasted}
            pasteOpen={pasteOpen}
            state={contractState}
            onChainId={(id) => {
              setChainId(id);
              resetFromContract();
            }}
            onAddress={(a) => {
              setAddress(a);
              resetFromContract();
            }}
            onPasted={(text) => {
              setPasted(text);
              resetFromContract();
            }}
            onPasteOpen={(open) => {
              setPasteOpen(open);
              if (!open) {
                setPasted("");
                resetFromContract();
              }
            }}
          />,
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
                <div className="bg-[radial-gradient(ellipse_at_top_left,--theme(--color-emerald-500/14%),transparent_70%)] space-y-5 bg-emerald-500/4 px-6 py-8 md:px-10 md:py-10">
                  <Eyebrow>Your invariant</Eyebrow>
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
                  {ruleProblem && (
                    <p className="text-xs text-amber-400">
                      Not valid yet: {ruleProblem}
                    </p>
                  )}
                </div>
              )}
            </div>,
          )}

        {surface &&
          section(
            2,
            <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
              <ResponseStep
                value={response}
                writes={surface.writes}
                onChange={setResponse}
              />
              {rule && template && (
                <TripSimulation
                  rule={rule}
                  sentence={sentenceText(template, values, surface)}
                  response={response}
                  contractName={contract?.name ?? shortAddress(address)}
                  valueLabel={ruleLabels[0] ?? ""}
                  limitLabel={ruleLabels[1] ?? ""}
                />
              )}
            </div>,
          )}

        {section(
          3,
          template && surface && rule ? (
            <>
              <Review
                name={invariantName}
                onName={setName}
                summary={[
                  [
                    "Watches",
                    `${contract?.name ?? shortAddress(address)} on ${chainName(chainId)}`,
                  ],
                  ["Invariant", sentenceText(template, values, surface)],
                  ["Response", describeResponse(response)],
                ]}
                json={{
                  name: invariantName,
                  chainId,
                  contract: address,
                  rule,
                  response,
                }}
                error={create.error}
              />
              <div className="mt-10 flex justify-end">
                <Button
                  disabled={!ready[3] || create.isPending}
                  onClick={() => create.mutate()}
                >
                  {create.isPending ? "Creating…" : "Create invariant"}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-gray-500">
              Complete the invariant above to review it.
            </p>
          ),
        )}
      </div>
    </div>
  );
}

function describeResponse(response: Response): string {
  const mode =
    modes.find((m) => m.mode === response.mode)?.title ?? response.mode;
  const target =
    response.mode === "alert"
      ? ""
      : response.scope.type === "contract"
        ? ", pausing the whole contract"
        : `, pausing ${response.scope.signature}`;
  const quiet = cooldowns.find(
    (c) => c.seconds === response.cooldownSecs,
  )?.label;
  return `${mode}${target}. Quiet period: ${quiet ?? `${response.cooldownSecs}s`}.`;
}

function Review({
  name,
  onName,
  summary,
  json,
  error,
}: {
  name: string;
  onName: (name: string) => void;
  summary: [string, string][];
  json: unknown;
  error: Error | null;
}) {
  return (
    <div className="space-y-6">
      <label className="block">
        <span className="mb-2 block text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase">
          Name
        </span>
        <input
          className="w-full bg-white/4 px-3 py-2.5 text-sm text-white transition-colors hover:bg-white/6 focus:bg-white/6"
          value={name}
          maxLength={80}
          onChange={(e) => onName(e.target.value)}
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
      </dl>
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
