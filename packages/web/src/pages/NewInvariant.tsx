import { chainName, rule as ruleSchema, type Response } from "@tripwire/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ContractStep } from "../components/wizard/ContractStep";
import { PreviewPanel } from "../components/wizard/PreviewPanel";
import {
  cooldowns,
  modes,
  ResponseStep,
} from "../components/wizard/ResponseStep";
import { RuleSentence, sentenceText } from "../components/wizard/RuleSentence";
import { Stepper } from "../components/wizard/Stepper";
import { TemplateGallery } from "../components/wizard/TemplateGallery";
import { useContract } from "../components/wizard/useContract";
import { Button, Eyebrow } from "../components/ui";
import { ApiError, api } from "../lib/api";
import { shortAddress } from "../lib/format";
import { initialValues, templates, type Values } from "../lib/templates";

// Development only: a contract to start from, so it need not be pasted
// on every reload. Production builds ignore it.
const [devChain, devAddress] = import.meta.env.DEV
  ? (import.meta.env.VITE_DEV_CONTRACT?.split(":") ?? [])
  : [];

const steps = [
  { title: "Contract", hint: "Which contract should Tripwire watch?" },
  { title: "Template", hint: "What kind of invariant is it?" },
  { title: "Rule", hint: "Fill in the blanks. The preview updates as you go." },
  { title: "Response", hint: "What should happen when it breaks?" },
  { title: "Review", hint: "Name it and switch it on." },
];

export function NewInvariantPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [chainId, setChainId] = useState(Number(devChain) || 1);
  const [address, setAddress] = useState(devAddress ?? "");
  const [pasted, setPasted] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [values, setValues] = useState<Values>({});
  const [name, setName] = useState<string | null>(null);
  const [response, setResponse] = useState<Response>({
    mode: "alert",
    scope: { type: "contract" },
    cooldownSecs: 300,
  });

  const contractState = useContract(chainId, address, pasted);
  const contract = contractState.contract;
  const surface = contract?.surface;
  const template = templates.find((t) => t.id === templateId) ?? null;

  const built =
    template && contract ? template.build(values, contract.address) : null;
  const checked = built ? ruleSchema.safeParse(built) : null;
  const rule = checked?.success ? checked.data : null;
  const ruleProblem =
    checked && !checked.success ? checked.error.issues[0]?.message : null;

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

  // Changing the contract invalidates everything chosen after it.
  const resetFromContract = () => {
    setTemplateId(null);
    setValues({});
    setName(null);
  };

  const ready = [
    !!contract,
    !!template,
    !!rule,
    response.mode === "alert" ||
      response.scope.type === "contract" ||
      !!response.scope.selector,
    !!rule && invariantName.trim() !== "",
  ];

  const sentence =
    template && surface ? (
      <RuleSentence
        template={template}
        values={values}
        surface={surface}
        compact
      />
    ) : null;

  return (
    <div>
      <header className="mb-8">
        <Eyebrow dot="bg-red-500">New invariant</Eyebrow>
        <h1 className="mt-3 font-display text-3xl font-bold tracking-tighter text-white uppercase md:text-4xl">
          Create an invariant
        </h1>
      </header>

      <div className="mb-8">
        <Stepper
          steps={steps.map((s) => s.title)}
          current={step}
          reachable={(i) => i <= step || ready.slice(0, i).every(Boolean)}
          onSelect={setStep}
        />
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="border border-white/5 bg-panel p-6 md:p-8">
          <h2 className="mb-8 font-display text-xl font-bold text-white md:text-2xl">
            {steps[step]?.hint}
          </h2>

          {step === 0 && (
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
            />
          )}

          {step === 1 && surface && (
            <TemplateGallery
              surface={surface}
              selected={templateId}
              onSelect={(id) => {
                const next = templates.find((t) => t.id === id);
                if (!next) return;
                setTemplateId(id);
                setValues(initialValues(next, surface));
                setName(null);
                setStep(2);
              }}
            />
          )}

          {step === 2 && template && surface && (
            <div className="space-y-6">
              <RuleSentence
                template={template}
                values={values}
                surface={surface}
                onChange={(key, value) =>
                  setValues((v) => ({ ...v, [key]: value }))
                }
              />
              {ruleProblem && (
                <p className="text-xs text-amber-400">
                  Not valid yet: {ruleProblem}
                </p>
              )}
            </div>
          )}

          {step === 3 && surface && (
            <ResponseStep
              value={response}
              writes={surface.writes}
              onChange={setResponse}
            />
          )}

          {step === 4 && template && surface && rule && (
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
          )}

          <div className="mt-10 flex items-center justify-between gap-3 border-t border-white/5 pt-6">
            <Button
              variant="ghost"
              disabled={step === 0}
              onClick={() => setStep(step - 1)}
            >
              Back
            </Button>
            {step < 4 ? (
              <Button disabled={!ready[step]} onClick={() => setStep(step + 1)}>
                Next
              </Button>
            ) : (
              <Button
                disabled={!ready[4] || create.isPending}
                onClick={() => create.mutate()}
              >
                {create.isPending ? "Creating…" : "Create invariant"}
              </Button>
            )}
          </div>
        </section>

        <div className="xl:sticky xl:top-10">
          <PreviewPanel contract={contract} sentence={sentence} rule={rule} />
        </div>
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
          className="w-full border border-white/10 bg-canvas px-3 py-2.5 text-sm text-white focus:border-emerald-500/60 focus:outline-none"
          value={name}
          maxLength={80}
          onChange={(e) => onName(e.target.value)}
        />
      </label>
      <dl className="divide-y divide-white/5 border border-white/5">
        {summary.map(([term, detail]) => (
          <div
            key={term}
            className="grid gap-1 px-4 py-3 sm:grid-cols-[120px_1fr]"
          >
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
        <pre className="mt-3 max-h-80 overflow-auto border border-emerald-500/20 bg-canvas p-4 text-xs text-emerald-300">
          {JSON.stringify(json, null, 2)}
        </pre>
      </details>
      {error && (
        <div className="border-l-2 border-red-500 bg-red-500/10 px-4 py-3 text-sm text-red-300">
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
