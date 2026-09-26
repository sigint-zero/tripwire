import type {
  ReadinessStep,
  ReadinessStepName,
  Readiness as ReadinessData,
  ResponseTest,
} from "@tripwire/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { api } from "../../lib/api";
import { Copyable } from "../Copyable";
import { formatUnits, timeAgo } from "../../lib/format";
import { Button } from "../ui";

const titles: Record<ReadinessStepName, string> = {
  signing_key: "Signing key",
  rules: "Rules that act",
  registered: "Registered",
  operator: "Operator",
  permission: "Permission",
  least_power: "Least power",
  mode: "Mode",
};

/** Where to fix a step that is not done. */
const fixes: Partial<
  Record<ReadinessStepName, (address: string) => ReactNode>
> = {
  signing_key: () => <FixLink to="/settings">Keys</FixLink>,
  mode: () => <FixLink to="/settings">Settings</FixLink>,
};

function FixLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="shrink-0 text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-emerald-400"
    >
      {children} →
    </Link>
  );
}

function Mark({ step }: { step: ReadinessStep }) {
  const tone =
    step.state === "done"
      ? "bg-emerald-500/15 text-emerald-400"
      : step.state === "not_applicable"
        ? "bg-white/5 text-gray-600"
        : step.step === "least_power"
          ? "bg-amber-400/15 text-amber-300"
          : "bg-red-500/15 text-red-400";
  const mark =
    step.state === "done" ? "✓" : step.state === "not_applicable" ? "–" : "!";
  return (
    <span
      aria-label={step.state.replace("_", " ")}
      className={`flex size-5 shrink-0 items-center justify-center font-mono text-[11px] ${tone}`}
    >
      {mark}
    </span>
  );
}

/**
 * Whether this contract's responses would work when a rule trips
 * (`RESPONSES.md`, Readiness). It re-reads on every block, so a step ticks
 * by itself once the chain catches up.
 */
export function Readiness({ address }: { address: string }) {
  const { data, error } = useQuery({
    queryKey: ["readiness", address],
    queryFn: ({ signal }) => api.readiness(address, signal),
  });

  if (error) {
    return (
      <p className="bg-white/2 px-5 py-4 text-sm text-gray-500">
        Readiness cannot be read now: {error.message}
      </p>
    );
  }
  if (!data) return <div className="h-40 bg-white/2" />;

  return (
    <div className="space-y-4">
      <ol className="space-y-1">
        {data.steps.map((step) => (
          <li
            key={step.step}
            className="flex items-start gap-4 bg-white/3 px-5 py-3"
          >
            <Mark step={step} />
            <span className="w-28 shrink-0 text-xs font-bold tracking-wider text-gray-300 uppercase">
              {titles[step.step]}
            </span>
            <span
              className={`min-w-0 flex-1 text-sm wrap-anywhere ${step.state === "not_applicable" ? "text-gray-600" : "text-gray-400"}`}
            >
              {step.detail}
            </span>
            {step.state === "todo" && fixes[step.step]?.(address)}
            {step.state === "todo" && step.step === "rules" && (
              <Link
                to="/rules/new"
                search={{ contract: address }}
                className="shrink-0 text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-emerald-400"
              >
                New rule →
              </Link>
            )}
          </li>
        ))}
      </ol>
      {data.guardianCall && <GuardianCallBox call={data.guardianCall} />}
      {data.rules.length > 0 && <Tests readiness={data} />}
    </div>
  );
}

/** What the guardian sends to make the signing key an operator. */
function GuardianCallBox({
  call,
}: {
  call: NonNullable<ReadinessData["guardianCall"]>;
}) {
  return (
    <div className="bg-amber-400/6 px-5 py-4">
      <p className="mb-3 text-sm text-amber-200">
        Send this from the guardian&apos;s wallet. The step ticks by itself once
        the controller records it.
      </p>
      <Copyable label="From" value={call.from} />
      <Copyable label="To" value={call.to} />
      <Copyable label="Value" value={call.value} />
      <Copyable label="Data" value={call.data} />
    </div>
  );
}

/** **Test the response**: each rule's action built and simulated, nothing sent. */
function Tests({ readiness }: { readiness: ReadinessData }) {
  return (
    <ul className="space-y-1">
      {readiness.rules.map((rule) => (
        <TestRow key={rule.id} address={readiness.address} rule={rule} />
      ))}
    </ul>
  );
}

function TestRow({
  address,
  rule,
}: {
  address: string;
  rule: ReadinessData["rules"][number];
}) {
  const queryClient = useQueryClient();
  const test = useMutation({
    mutationFn: () => api.testResponse(rule.id),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["readiness", address] }),
  });
  const result = rule.test;
  return (
    <li className="flex flex-wrap items-center justify-between gap-4 bg-white/2 px-5 py-3">
      <span className="min-w-0">
        <Link
          to="/rules/$id"
          params={{ id: rule.id }}
          className="text-sm text-white transition-colors hover:text-emerald-400"
        >
          {rule.name}
        </Link>
        {result ? <TestResult result={result} /> : null}
        {test.error && (
          <span className="block text-xs text-red-400">
            {test.error.message}
          </span>
        )}
      </span>
      <Button
        variant="ghost"
        disabled={test.isPending}
        onClick={() => test.mutate()}
        title="Build this rule's action from the signing key and simulate it now. Nothing is sent."
      >
        {test.isPending ? "Testing…" : "Test the response"}
      </Button>
    </li>
  );
}

function TestResult({ result }: { result: ResponseTest }) {
  return (
    <span
      className={`mt-0.5 block text-xs ${result.ok ? "text-gray-400" : "text-red-400"}`}
      title={`Tested ${new Date(result.testedAt).toLocaleString()}`}
    >
      {result.ok ? (
        <>
          Passes
          {result.gasEstimate !== null && (
            <>
              , using{" "}
              <span className="font-mono">
                {result.gasEstimate.toLocaleString("en-US")}
              </span>{" "}
              gas
            </>
          )}
          {result.balanceWei !== null && (
            <>
              ; the key holds{" "}
              <span className="font-mono">
                {formatUnits(result.balanceWei, 18)}
              </span>{" "}
              ETH
            </>
          )}
          . {timeAgo(result.testedAt)}.
        </>
      ) : (
        <>Would revert: {result.revertReason ?? "no reason given"}.</>
      )}
    </span>
  );
}
