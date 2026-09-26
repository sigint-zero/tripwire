import type { RuleDisplay, SavedRule } from "@tripwire/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import {
  Button,
  buttonClass,
  EmptyState,
  PinIcon,
  Switch,
  Tag,
} from "../components/ui";
import { RuleStatusTag } from "../components/RuleStatus";
import { RuleValues } from "../components/RuleValues";
import { ViolationList } from "../components/ViolationList";
import {
  actions,
  SeverityIcon,
  severities,
} from "../components/wizard/ResponseStep";
import { api } from "../lib/api";
import { formatBig, shortAddress, showValue, timeAgo } from "../lib/format";

const heading =
  "mb-4 text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase";

/** One rule: its switch, what it says, how its values show, and its violations. */
export function RulePage({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: rule, error } = useQuery({
    queryKey: ["rule", id],
    queryFn: ({ signal }) => api.rule(id, signal),
  });
  const { data: contracts } = useQuery({
    queryKey: ["contracts"],
    queryFn: ({ signal }) => api.contracts(signal),
  });
  const { data: pinned } = useQuery({
    queryKey: ["pinned"],
    queryFn: ({ signal }) => api.pinnedRules(signal),
  });
  const { data: violations } = useQuery({
    queryKey: ["violations", { rule: id }],
    queryFn: ({ signal }) => api.violations({ rule: id, limit: 200 }, signal),
  });

  const changed = async (updated: SavedRule) => {
    queryClient.setQueryData(["rule", id], updated);
    await queryClient.invalidateQueries({ queryKey: ["rules"] });
    await queryClient.invalidateQueries({ queryKey: ["contracts"] });
  };
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.changeRule(id, { enabled }),
    onSuccess: changed,
  });
  const pin = useMutation({
    mutationFn: (on: boolean) =>
      api.pinRules(
        on ? [...(pinned ?? []), id] : (pinned ?? []).filter((p) => p !== id),
      ),
    onSuccess: (ids) => queryClient.setQueryData(["pinned"], ids),
  });
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.deleteRule(id),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ["rule", id] });
      await queryClient.invalidateQueries({ queryKey: ["rules"] });
      await queryClient.invalidateQueries({ queryKey: ["contracts"] });
      await queryClient.invalidateQueries({ queryKey: ["pinned"] });
      await navigate({ to: "/rules" });
    },
  });

  const back = (
    <Link
      to="/rules"
      className="text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-emerald-400"
    >
      ← Rules
    </Link>
  );
  if (error) {
    return (
      <div className="space-y-4">
        {back}
        <p className="text-sm text-gray-400">{error.message}</p>
      </div>
    );
  }
  if (!rule) return back;

  const address = rule.rule.contract.toLowerCase();
  const contract = contracts?.find((c) => c.address === address);
  const severity = severities.find((s) => s.severity === rule.rule.severity);
  const action = actions.find((a) => a.action === rule.rule.on_trip.action);
  const isPinned = pinned?.includes(id) ?? false;
  const failure = toggle.error ?? pin.error;

  return (
    <div>
      {back}
      <header className="mt-4 mb-10 flex items-start justify-between gap-6">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <h1 className="font-display text-3xl font-bold tracking-tighter text-white uppercase md:text-4xl">
              {rule.rule.name}
            </h1>
            <Switch
              on={rule.enabled}
              onChange={(enabled) => toggle.mutate(enabled)}
              label={rule.enabled ? "Watching" : "Off"}
              disabled={toggle.isPending}
            />
          </div>
          <p className="mt-3 max-w-3xl font-mono text-sm text-gray-400">
            {rule.sentence}
          </p>
          <p className="mt-4 flex flex-wrap items-center gap-2">
            <Link
              to="/contracts/$address"
              params={{ address }}
              className="transition-opacity hover:opacity-80"
            >
              <Tag>{contract?.name ?? shortAddress(address)}</Tag>
            </Link>
            {/* The alert and action are settings, not states: no colour. */}
            {severity && (
              <span title="The alert it raises when it trips">
                <Tag>
                  <span className="mr-2 text-gray-600">Alert</span>
                  <SeverityIcon
                    severity={severity.severity}
                    className="mr-1.5 size-3"
                    plain
                  />
                  {severity.title}
                </Tag>
              </span>
            )}
            {action && (
              <span title="What Tripwire does when it trips">
                <Tag>
                  <span className="mr-2 text-gray-600">Action</span>
                  {action.title}
                </Tag>
              </span>
            )}
            {typeof rule.origin === "object" && (
              <Tag tone="text-violet-300">Via {rule.origin.mcp}</Tag>
            )}
            {rule.origin === "api" && <Tag tone="text-violet-300">Via API</Tag>}
            <RuleStatusTag status={rule.status} open={rule.openViolations} />
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Link
            to="/rules/$id/edit"
            params={{ id }}
            className={buttonClass("ghost")}
          >
            Edit
          </Link>
          <Button
            variant="ghost"
            disabled={pin.isPending || pinned === undefined}
            onClick={() => pin.mutate(!isPinned)}
            title="Pinned rules show on the Overview"
          >
            <PinIcon
              className={`size-3.5 transition-transform ${isPinned ? "" : "rotate-45"}`}
            />
            {/* Sized for the longer word, so the row stays put. */}
            <span className="grid">
              <span className="invisible col-start-1 row-start-1">Unpin</span>
              <span className="col-start-1 row-start-1">
                {isPinned ? "Unpin" : "Pin"}
              </span>
            </span>
          </Button>
          <Button variant="danger" onClick={() => setConfirming(true)}>
            Delete
          </Button>
          <ConfirmDialog
            open={confirming}
            title="Delete this rule?"
            confirm="Delete rule"
            pending={remove.isPending}
            error={remove.error?.message}
            onConfirm={() => remove.mutate()}
            onClose={() => {
              setConfirming(false);
              remove.reset();
            }}
          >
            <span className="font-mono text-white">{rule.rule.name}</span> stops
            watching, and its violations go with it. This cannot be undone.
            {rule.enabled && (
              <span className="mt-3 block text-gray-500">
                To pause it instead, switch it off.
              </span>
            )}
          </ConfirmDialog>
        </div>
      </header>

      {failure && (
        <p className="mb-10 text-sm text-red-400">{failure.message}</p>
      )}

      <dl className="mb-12 grid gap-2 sm:grid-cols-3">
        <Fact label="Last evaluated">
          {rule.lastEvaluatedBlock === null
            ? "Not yet"
            : `Block ${formatBig(String(rule.lastEvaluatedBlock))}`}
        </Fact>
        <Fact label="Created">
          <span title={new Date(rule.createdAt).toLocaleString()}>
            {timeAgo(rule.createdAt)}
          </span>
        </Fact>
        <Fact label="Changed">
          <span title={new Date(rule.updatedAt).toLocaleString()}>
            {timeAgo(rule.updatedAt)}
          </span>
        </Fact>
      </dl>

      <RuleValues rule={rule} violations={violations} />

      <section className="mb-12">
        <h2 className={heading}>Number format</h2>
        <DisplayForm
          key={`${rule.display.decimals}:${rule.display.unit}`}
          display={rule.display}
          onSave={changed}
          id={id}
        />
      </section>

      <section>
        <div className="flex items-baseline justify-between gap-4">
          <h2 className={heading}>Violations</h2>
          {violations && violations.length > 0 && (
            <Link
              to="/violations"
              search={{ rule: id, all: true }}
              className="text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-emerald-400"
            >
              Filter on the Violations page →
            </Link>
          )}
        </div>
        {violations?.length === 0 && (
          <EmptyState
            compact
            title="Never tripped"
            hint="When this rule trips, each run shows up here."
          />
        )}
        {violations && violations.length > 0 && (
          <ViolationList
            violations={violations}
            rules={[rule]}
            showRule={false}
          />
        )}
      </section>
    </div>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white/3 px-5 py-4">
      <dt className="text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase">
        {label}
      </dt>
      <dd className="mt-1 font-mono text-sm text-white tabular-nums">
        {children}
      </dd>
    </div>
  );
}

/**
 * How the rule's numbers read: contracts return whole numbers, so a token
 * amount needs its decimals, and a label says what it counts.
 */
function DisplayForm({
  id,
  display,
  onSave,
}: {
  id: string;
  display: RuleDisplay;
  onSave: (rule: SavedRule) => Promise<void>;
}) {
  const [decimals, setDecimals] = useState(
    display.decimals === null ? "" : String(display.decimals),
  );
  const [unit, setUnit] = useState(display.unit ?? "");
  const { data: current } = useQuery({
    queryKey: ["rule-current", id],
    queryFn: ({ signal }) => api.ruleCurrent(id, signal),
  });
  const save = useMutation({
    mutationFn: () =>
      api.changeRule(id, {
        display: {
          decimals: decimals === "" ? null : Number(decimals),
          unit: unit.trim() || null,
        },
      }),
    onSuccess: onSave,
  });
  const dirty =
    decimals !== (display.decimals === null ? "" : String(display.decimals)) ||
    unit !== (display.unit ?? "");
  const sample =
    current?.find((c) => /^-?\d+$/.test(c.value))?.value ??
    "1234500000000000000000";
  const label = unit.trim() || null;
  const choices: [string, string][] = [
    ["", "raw"],
    ["6", "6 decimals"],
    ["8", "8 decimals"],
    ["18", "18 decimals"],
  ];
  const custom = !choices.some(([v]) => v === decimals);

  // Each choice is the latest value read that way: pick what looks right.
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="flex flex-wrap gap-2">
        {choices.map(([value, caption]) => (
          <button
            key={caption}
            type="button"
            onClick={() => setDecimals(value)}
            className={`cursor-pointer px-4 py-2.5 text-left transition-colors ${
              decimals === value
                ? "bg-emerald-500/15 text-emerald-300"
                : "bg-white/3 text-gray-300 hover:bg-white/6"
            }`}
          >
            <span className="block font-mono text-sm">
              {showValue(sample, {
                decimals: value === "" ? null : Number(value),
                unit: label,
              })}
            </span>
            <span className="block text-[10px] tracking-wider text-gray-500 uppercase">
              {caption}
            </span>
          </button>
        ))}
        <label
          className={`px-4 py-2.5 ${custom ? "bg-emerald-500/15" : "bg-white/3"}`}
        >
          <input
            value={custom ? decimals : ""}
            onChange={(e) => setDecimals(e.target.value.replace(/\D/g, ""))}
            inputMode="numeric"
            maxLength={2}
            placeholder="Other"
            className="block w-16 bg-transparent font-mono text-sm text-white placeholder:text-gray-500 focus:outline-none"
          />
          <span className="block text-[10px] tracking-wider text-gray-500 uppercase">
            decimals
          </span>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          maxLength={16}
          placeholder="Label, like USDC"
          aria-label="Label after each value"
          className="w-44 bg-white/5 px-3 py-2 font-mono text-sm text-white placeholder:text-gray-600 focus:bg-white/8 focus:outline-none"
        />
        <Button type="submit" disabled={!dirty || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        {save.error && (
          <p className="text-sm text-red-400">{save.error.message}</p>
        )}
      </div>
    </form>
  );
}
